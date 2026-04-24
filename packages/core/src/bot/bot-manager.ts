import { randomUUID } from 'crypto'
import type {
  ConversationMessageRow,
  ConversationTopicRow,
  DB,
  BotInstanceRow,
  RoleRow,
} from '@zakobot/database'
import { getEnabledBots, getBotWithRole, getRole, updateBot } from '@zakobot/database'
import type { GeneralSettings } from '@zakobot/shared'
import { DiscordAdapter } from './discord-adapter.js'
import { Agent } from '../llm/agent.js'
import { ConversationService } from '../llm/conversation-service.js'
import { fetchAvailableModels } from '../llm/list-models.js'
import type { ToolRegistry } from '../tools/index.js'
import type { SkillManager } from '../skills/index.js'

export class BotManager {
  private adapters = new Map<string, DiscordAdapter>()
  private conversations: ConversationService

  constructor(
    private db: DB,
    private toolRegistry: ToolRegistry,
    private skillManager: SkillManager,
    private getGeneralSettings: () => GeneralSettings,
  ) {
    this.conversations = new ConversationService(db)
  }

  async startAll() {
    const rows = getEnabledBots(this.db)
    for (const row of rows) {
      await this.startInstance(row).catch((err) =>
        console.error(`[BotManager] Failed to start "${row.instance.name}":`, err),
      )
    }
    console.log(`[BotManager] ${this.adapters.size} bot(s) online.`)
  }

  async startOne(instanceId: string) {
    const row = getBotWithRole(this.db, instanceId)
    if (!row) throw new Error(`Bot instance "${instanceId}" not found`)
    await this.startInstance(row)
  }

  async syncInstance(instanceId: string) {
    const row = getBotWithRole(this.db, instanceId)

    if (!row || !row.instance.enabled) {
      await this.stopOne(instanceId)
      return
    }

    if (this.adapters.has(instanceId)) {
      await this.stopOne(instanceId)
    }

    await this.startInstance(row)
  }

  listConversationTopics(instanceId: string): ConversationTopicRow[] {
    this.requireBotRow(instanceId)
    return this.conversations.listTopics(instanceId)
  }

  listConversationMessages(instanceId: string, topicId: string): ConversationMessageRow[] {
    const row = this.requireBotRow(instanceId)
    const topic = this.conversations.getTopic(topicId)

    if (!topic || topic.botInstanceId !== row.instance.id) {
      throw new Error(`Conversation topic "${topicId}" not found`)
    }

    return this.conversations.listTopicMessages(topicId)
  }

  async deleteConversationTopic(instanceId: string, topicId: string): Promise<ConversationTopicRow> {
    const row = this.requireBotRow(instanceId)
    const topic = this.conversations.getTopic(topicId)

    if (!topic || topic.botInstanceId !== row.instance.id) {
      throw new Error(`Conversation topic "${topicId}" not found`)
    }

    const metadata = this.parseJsonRecord(topic.metadata)
    if (topic.sourceType === 'discord_thread') {
      const adapter = this.adapters.get(instanceId)
      if (!adapter) {
        throw new Error(`Bot instance "${instanceId}" is not running`)
      }

      await adapter.deleteConversationThread(topic, metadata)
    }

    return this.conversations.deleteTopic(topicId)!
  }

  startPanelConversation(instanceId: string): ConversationTopicRow {
    const row = this.requireBotRow(instanceId)

    return this.conversations.startNewTopic(row.instance, {
      platform: row.instance.platform,
      scopeKey: `panel:${randomUUID()}`,
      sourceType: 'panel',
      sourceId: 'panel',
      metadata: {},
    })
  }

  async sendPanelMessage(instanceId: string, content: string, topicId?: string) {
    const row = this.requireBotRow(instanceId)
    const resolvedContent = content.trim()

    if (!resolvedContent) {
      throw new Error('Message content is required')
    }

    let topic = topicId ? this.conversations.getTopic(topicId) : undefined
    if (topic && topic.botInstanceId !== row.instance.id) {
      throw new Error(`Conversation topic "${topicId}" not found`)
    }

    if (!topic) {
      topic = this.startPanelConversation(instanceId)
    }

    const scope = {
      platform: row.instance.platform,
      scopeKey: topic.scopeKey,
      sourceType: topic.sourceType,
      sourceId: topic.sourceId,
      metadata: this.parseJsonRecord(topic.metadata),
    }

    const userMessage = this.conversations.appendMessage(row.instance, topic.id, scope, {
      role: 'user',
      content: resolvedContent,
      senderName: '控制台',
      metadata: {
        origin: 'panel',
      },
    })!

    const agent = this.createAgent(row)
    const reply = await agent.respond(topic.id)

    const assistantMessage = this.conversations.appendMessage(row.instance, topic.id, scope, {
      role: 'assistant',
      content: reply,
      senderId: row.instance.id,
      senderName: row.instance.name,
      metadata: {
        origin: 'panel',
      },
    })!

    return {
      topic: this.conversations.getTopic(topic.id)!,
      userMessage,
      assistantMessage,
    }
  }

  private async startInstance(row: { instance: BotInstanceRow; role: RoleRow }) {
    if (row.instance.platform !== 'discord') {
      console.warn(`[BotManager] Platform "${row.instance.platform}" not yet supported, skipping.`)
      return
    }

    if (!row.instance.llmModel || !row.instance.llmApiKey || !row.instance.llmBaseUrl) {
      throw new Error(`Bot "${row.instance.name}" is missing LLM configuration`)
    }

    if (this.adapters.has(row.instance.id)) {
      await this.stopOne(row.instance.id)
    }

    const agent = this.createAgent(row)
    const adapter = new DiscordAdapter(
      row.instance,
      row.role,
      agent,
      this.conversations,
      this.getGeneralSettings,
      () => this.listAvailableModels(row.instance.id),
      (modelId) => this.setModel(row.instance.id, modelId),
    )

    await adapter.start()
    this.adapters.set(row.instance.id, adapter)
  }

  async stopOne(instanceId: string) {
    const adapter = this.adapters.get(instanceId)
    if (!adapter) return
    await adapter.stop()
    this.adapters.delete(instanceId)
  }

  async stopAll() {
    const instanceIds = [...this.adapters.keys()]

    for (const instanceId of instanceIds) {
      await this.stopOne(instanceId)
    }
  }

  async sendMessage(instanceId: string, channelId: string, content: string) {
    const adapter = this.adapters.get(instanceId)
    if (!adapter) throw new Error(`Bot instance "${instanceId}" is not running`)
    await adapter.sendMessage(channelId, content)
  }

  getStatus() {
    return {
      botsOnline: this.adapters.size,
      instances: [...this.adapters.entries()].map(([id, a]) => ({
        id,
        name: a.instance.name,
        platform: a.instance.platform,
      })),
    }
  }

  async listAvailableModels(instanceId: string) {
    const row = this.requireBotRow(instanceId)
    return fetchAvailableModels({
      platformName: row.instance.llmPlatformName,
      apiKey: row.instance.llmApiKey,
      baseUrl: row.instance.llmBaseUrl,
    })
  }

  async setModel(instanceId: string, modelId: string) {
    const nextModel = modelId.trim()
    if (!nextModel) {
      throw new Error('Model ID is required')
    }

    const row = this.requireBotRow(instanceId)
    const updated = updateBot(this.db, instanceId, {
      llmModel: nextModel,
      updatedAt: new Date(),
    })

    if (!updated) {
      throw new Error('Failed to update bot model')
    }

    const adapter = this.adapters.get(instanceId)
    if (adapter) {
      adapter.applyRuntimeUpdate(updated.instance, this.createAgent(updated))
    }

    return updated.instance.llmModel
  }

  private createAgent(row: { instance: BotInstanceRow; role: RoleRow }) {
    const roleId = row.role.id
    const fallbackRole = row.role
    return new Agent(
      () => getRole(this.db, roleId) ?? fallbackRole,
      {
        provider: row.instance.llmProvider as 'openai',
        model: row.instance.llmModel,
        apiKey: row.instance.llmApiKey,
        baseUrl: row.instance.llmBaseUrl,
      },
      this.conversations,
      this.toolRegistry,
      this.skillManager,
      this.getGeneralSettings,
    )
  }

  private requireBotRow(instanceId: string) {
    const row = getBotWithRole(this.db, instanceId)
    if (!row) {
      throw new Error(`Bot instance "${instanceId}" not found`)
    }

    if (!row.instance.llmModel || !row.instance.llmApiKey || !row.instance.llmBaseUrl) {
      throw new Error(`Bot "${row.instance.name}" is missing LLM configuration`)
    }

    return row
  }

  private parseJsonRecord(value: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }
}
