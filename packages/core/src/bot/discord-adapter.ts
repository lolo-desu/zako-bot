import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js'
import type { ButtonInteraction, Message, MessageEditOptions, TextBasedChannel } from 'discord.js'
import type { BotInstanceRow, RoleRow } from '@zakobot/database'
import type { AgentEvent, GeneralSettings, ToolApprovalCallback } from '@zakobot/shared'
import type { Agent } from '../llm/agent.js'
import type { ConversationScope, ConversationService } from '../llm/conversation-service.js'
import { buildAssistantMessageChunks } from './discord-stream-renderer.js'
import { DiscordModelCommand, MODEL_COMMAND } from './model-command.js'

const TOOL_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000
const LLM_RATE_LIMIT_MESSAGE = 'LLM 服务当前过于繁忙，请稍等片刻后重试。'
const REQUEST_STOPPED_MESSAGE = '请求已停止。'
const QUEUED_REQUEST_NOTICE = '当前机器人还有其他请求正在处理，已加入队列。可通过 /stop 停止当前频道或话题中的请求。'

type MsgPayload = {
  content: string
  components?: ActionRowBuilder<ButtonBuilder>[]
}

type SendableChannel = TextBasedChannel & {
  id: string
  send: (payload: MsgPayload | { content: string }) => Promise<Message>
}

type QueuedRequest = {
  id: string
  scopeKey: string
  controller: AbortController
  run: (signal: AbortSignal) => Promise<string>
  resolve: (value: string) => void
  reject: (reason?: unknown) => void
}

type PendingApproval = {
  finish: (approved: boolean, interaction: ButtonInteraction) => Promise<void>
}

type CreateMessage = (payload: MsgPayload) => Promise<Message>

const MAX_DISCORD_MESSAGE_CHARS = 1900

const NEW_TOPIC_COMMAND = {
  name: 'new',
  description: '开启新话题',
}

const STOP_COMMAND = {
  name: 'stop',
  description: '停止当前请求',
}

const MANUAL_BROWSER_COMMAND = {
  name: 'browser',
  description: '手动拉起浏览器和 VNC',
}

const DEFAULT_MANUAL_BROWSER_URL = 'https://www.google.com'

export class DiscordAdapter {
  readonly client: Client
  private pendingApprovals = new Map<string, PendingApproval>()
  private requestQueue: QueuedRequest[] = []
  private activeRequest?: QueuedRequest
  private processingQueue = false
  private requestCounter = 0
  private modelCommand: DiscordModelCommand

  constructor(
    readonly instance: BotInstanceRow,
    readonly role: RoleRow,
    private agent: Agent,
    private conversations: ConversationService,
    private getGeneralSettings: () => GeneralSettings,
    private listAvailableModels: () => Promise<string[]>,
    private setModel: (modelId: string) => Promise<string>,
    ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    })

    this.client.once('clientReady', (c) => {
      console.log(`[Discord] "${instance.name}" logged in as ${c.user.tag}`)
      void this.registerCommands().catch((err) => {
        console.error(`[Discord] Failed to register commands for "${instance.name}":`, err)
      })
    })

    this.client.on('messageCreate', (msg) => {
      void this.handleMessage(msg).catch((err) => {
        console.error(`[Discord] Unhandled message error in "${this.instance.name}":`, err)
      })
    })
    this.client.on('interactionCreate', (interaction) => {
      void this.handleInteraction(interaction).catch((err) => {
        console.error(`[Discord] Unhandled interaction error in "${this.instance.name}":`, err)
      })
    })

    this.modelCommand = new DiscordModelCommand({
      getCurrentModel: () => this.instance.llmModel,
      listAvailableModels: this.listAvailableModels,
      setModel: this.setModel,
    })
  }

  private async handleMessage(msg: Message) {
    if (msg.author.bot) return

    if (this.instance.discordGuildId && msg.guildId !== this.instance.discordGuildId) return
    if (!this.isAllowedDiscordUser(msg.author.id)) return
    if (!this.isAllowedDiscordChannel(msg.channelId, msg.channel.isThread() ? msg.channel.parentId : null)) return

    const isThread = msg.channel.isThread()
    const isMentioned = this.client.user && msg.mentions.has(this.client.user)
    const userText = msg.content.replace(/<@!?\d+>/g, '').trim()
    const imageUrls = [...msg.attachments.values()]
      .filter(a => a.contentType?.startsWith('image/') ?? false)
      .map(a => a.url)

    const { requireMention, threadMode } = this.getGeneralSettings()

    if (!userText && imageUrls.length === 0) return

    if (!('send' in msg.channel)) return

    let anySentToUser = false

    try {
      if (userText === '/new') {
        const { topic, thread } = await this.createDetachedThreadTopic(
          msg.channelId,
          msg.guildId,
          msg.author.username,
        )
        await msg.reply(`已开启新话题：${topic.name}\n子区：<#${thread.id}>`)
        return
      }

      if (userText === '/stop') {
        await msg.reply(this.formatStopResult(this.stopScopeRequests(this.buildChannelScope(msg.channelId, msg.guildId).scopeKey)))
        return
      }

      const modelCommand = this.modelCommand.parseTextCommand(userText)
      if (modelCommand) {
        const lines = typeof modelCommand.index === 'number'
          ? [await this.modelCommand.switchByIndexReply(modelCommand.index)]
          : await this.modelCommand.buildListReply()
        for (const line of lines) {
          await msg.reply(line)
        }
        return
      }

      if (requireMention && !isMentioned && !isThread) return

      if (!isThread && msg.inGuild() && (threadMode || isMentioned)) {
        const { topic, scope, thread } = await this.createThreadTopicFromMessage(msg, userText)
        const send = (payload: MsgPayload) => thread.send(payload).then((m) => { anySentToUser = true; return m })
        await this.processTopicMessage(topic.id, scope, {
          role: 'user',
          content: userText,
          platformMessageId: msg.id,
          senderId: msg.author.id,
          senderName: msg.author.username,
          metadata: { mentionCount: msg.mentions.users.size, imageUrls },
        }, send, () => thread.sendTyping())
        return
      }

      const scope = isThread
        ? this.buildThreadScope(msg.channelId, msg.channel.parentId ?? '', msg.guildId, '')
        : this.buildChannelScope(msg.channelId, msg.guildId)
      const topic = this.conversations.getOrCreateActiveTopic(this.instance, scope)
      const input = {
        role: 'user',
        content: userText,
        platformMessageId: msg.id,
        senderId: msg.author.id,
        senderName: msg.author.username,
        metadata: { mentionCount: msg.mentions.users.size, imageUrls },
      } as const

      let firstSent = false
      const send = (payload: MsgPayload): Promise<Message> => {
        const p = firstSent
          ? (msg.channel as TextBasedChannel & { send: (p: MsgPayload) => Promise<Message> }).send(payload)
          : msg.reply(payload)
        firstSent = true
        return p.then((m) => { anySentToUser = true; return m })
      }
      await this.processTopicMessage(
        topic.id,
        scope,
        input,
        send,
        () => (msg.channel as TextBasedChannel & { sendTyping: () => Promise<void> }).sendTyping(),
      )
    }
    catch (err) {
      if (this.isRequestStoppedError(err)) return

      console.error(`[Discord] Agent error in "${this.instance.name}":`, err)
      const reply = this.getUserFacingErrorMessage(err)
      if (!anySentToUser || reply === LLM_RATE_LIMIT_MESSAGE) {
        await msg.reply(reply).catch(() => {})
      }
    }
  }

  private async enqueueTopicReply(
    topicId: string,
    scopeKey: string,
    createMessage: CreateMessage,
  ) {
    const queuedNotice = this.activeRequest || this.requestQueue.length > 0
      ? QUEUED_REQUEST_NOTICE
      : undefined

    return this.enqueueRequest(scopeKey, (abortSignal) => this.runStream(topicId, createMessage, abortSignal, queuedNotice))
  }

  private enqueueRequest(scopeKey: string, run: (signal: AbortSignal) => Promise<string>) {
    return new Promise<string>((resolve, reject) => {
      const entry: QueuedRequest = {
        id: `req_${++this.requestCounter}`,
        scopeKey,
        controller: new AbortController(),
        run,
        resolve,
        reject,
      }

      this.requestQueue.push(entry)
      void this.processQueue()
    })
  }

  private async processQueue() {
    if (this.processingQueue) return
    this.processingQueue = true

    try {
      while (this.requestQueue.length > 0) {
        const entry = this.requestQueue.shift()!

        if (entry.controller.signal.aborted) {
          entry.reject(new Error(REQUEST_STOPPED_MESSAGE))
          continue
        }

        this.activeRequest = entry

        try {
          const result = await entry.run(entry.controller.signal)
          if (entry.controller.signal.aborted) {
            entry.reject(new Error(REQUEST_STOPPED_MESSAGE))
          }
          else {
            entry.resolve(result)
          }
        }
        catch (error) {
          entry.reject(error)
        }
        finally {
          if (this.activeRequest?.id === entry.id) {
            this.activeRequest = undefined
          }
        }
      }
    }
    finally {
      this.processingQueue = false
      if (this.requestQueue.length > 0) {
        void this.processQueue()
      }
    }
  }

  private async runStream(
    topicId: string,
    createMessage: CreateMessage,
    abortSignal?: AbortSignal,
    queuedNotice?: string,
  ): Promise<string> {
    const { toolApprovalMode, toolProcessMode } = this.getGeneralSettings()
    const logLines: string[] = queuedNotice ? [queuedNotice] : []
    let streamedText = ''
    let toolProgressMessage: Message | undefined
    let pendingApprovalMessage: { content: string; components: ActionRowBuilder<ButtonBuilder>[] } | undefined
    const assistantMessages: { message: Message; content: string }[] = []

    const renderToolContent = () => {
      const sections = [...logLines, pendingApprovalMessage?.content]
        .filter((section): section is string => Boolean(section && section.trim()))

      const content = sections.join('\n\n').trim() || '（处理中...）'
      if (content.length <= MAX_DISCORD_MESSAGE_CHARS) {
        return content
      }

      const prefix = '...(内容已截断)\n'
      return `${prefix}${content.slice(-(MAX_DISCORD_MESSAGE_CHARS - prefix.length))}`
    }

    const commitToolMessage = async () => {
      if (!logLines.length && !pendingApprovalMessage && !toolProgressMessage) {
        return undefined
      }

      const content = renderToolContent()
      const components = pendingApprovalMessage?.components ?? []

      if (!toolProgressMessage) {
        toolProgressMessage = await createMessage({ content, components })
        return toolProgressMessage
      }

      const payload: MessageEditOptions = { content, components }
      toolProgressMessage = await toolProgressMessage.edit(payload)
      return toolProgressMessage
    }

    const pushLog = async (line: string) => {
      logLines.push(line)
      await commitToolMessage()
    }

    const syncAssistantMessages = async () => {
      const chunks = buildAssistantMessageChunks(streamedText, MAX_DISCORD_MESSAGE_CHARS)

      for (const [index, chunk] of chunks.entries()) {
        const existing = assistantMessages[index]
        if (!existing) {
          const message = await createMessage({ content: chunk })
          assistantMessages.push({ message, content: chunk })
          continue
        }

        if (existing.content === chunk) {
          continue
        }

        existing.message = await existing.message.edit({ content: chunk })
        existing.content = chunk
      }
    }

    let requestApproval: ToolApprovalCallback | undefined

    if (toolApprovalMode !== 'none') {
      requestApproval = async (callId, name, input) => {
        this.throwIfStopped(abortSignal)

        if (toolApprovalMode === 'sensitive' && !this.agent.isToolSensitive(name)) {
          return true
        }

        const inputStr = JSON.stringify(input, null, 2)
        const display = inputStr.length > 800 ? `${inputStr.slice(0, 800)}\n...` : inputStr
        const content = `🔧 **调用工具：${name}**\n\`\`\`json\n${display}\n\`\`\``

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`tool_approve:${callId}`)
            .setLabel('允许')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`tool_deny:${callId}`)
            .setLabel('拒绝')
            .setStyle(ButtonStyle.Danger),
        )

        pendingApprovalMessage = { content, components: [row] }
        const approvalMsg = await commitToolMessage()
        if (!approvalMsg) {
          throw new Error('Failed to create tool approval message')
        }

        return new Promise<boolean>((resolve, reject) => {
          const finish = (value: boolean) => {
            abortSignal?.removeEventListener('abort', onAbort)
            resolve(value)
          }

          const timer = setTimeout(() => {
            this.pendingApprovals.delete(callId)
            pendingApprovalMessage = undefined
            logLines.push(`${content.replace(/^🔧 \*\*/, '⏰ **')}\n— 超时已自动拒绝`)
            finish(false)
            void approvalMsg.edit({ content: renderToolContent(), components: [] }).catch(() => {})
          }, TOOL_APPROVAL_TIMEOUT_MS)

          const onAbort = () => {
            clearTimeout(timer)
            this.pendingApprovals.delete(callId)
            pendingApprovalMessage = undefined
            logLines.push(`${content.replace(/^🔧 \*\*/, '⏹️ **')}\n— 已通过 /stop 停止`)
            reject(new Error(REQUEST_STOPPED_MESSAGE))
            void approvalMsg.edit({ content: renderToolContent(), components: [] }).catch(() => {})
          }

          abortSignal?.addEventListener('abort', onAbort, { once: true })

          this.pendingApprovals.set(callId, {
            finish: async (approved, interaction) => {
              clearTimeout(timer)
              this.pendingApprovals.delete(callId)
              pendingApprovalMessage = undefined
              logLines.push(
                content.replace(/^🔧 \*\*/, approved ? '✅ **' : '❌ **')
                + (approved ? '\n— 已允许' : '\n— 已拒绝'),
              )
              await interaction.update({ content: renderToolContent(), components: [] }).catch(() => {})
              finish(approved)
            },
          })
        })
      }
    }

    let fullContent = ''

    for await (const event of this.agent.respondStream(topicId, {
      requestApproval,
      abortSignal,
      onRateLimitRetry: async (_attempt, delayMs) => {
        this.throwIfStopped(abortSignal)
        await pushLog(`${LLM_RATE_LIMIT_MESSAGE}，将在 ${Math.ceil(delayMs / 1000)} 秒后自动重试。可通过 /stop 停止当前请求。`)
      },
    })) {
      this.throwIfStopped(abortSignal)

      switch (event.type) {
        case 'text_chunk':
          if (event.content) {
            this.throwIfStopped(abortSignal)
            streamedText += event.content
            await syncAssistantMessages()
          }
          break
        case 'tool_call': {
          if (toolProcessMode === 'none') break
          // Only send a brief notification when no approval dialog will cover it
          const approvalWillShow = toolApprovalMode !== 'none'
            && !(toolApprovalMode === 'sensitive' && !this.agent.isToolSensitive(event.name))
          if (!approvalWillShow) {
            this.throwIfStopped(abortSignal)
            await pushLog(`🔧 **调用工具：${event.name}**`)
          }
          break
        }
        case 'tool_result':
          if (toolProcessMode === 'full') {
            this.throwIfStopped(abortSignal)
            await pushLog(this.formatToolResult(event))
          }
          break
        case 'done':
          fullContent = event.content
          streamedText = event.content
          await syncAssistantMessages()
          break
      }
    }

    if (!assistantMessages.length) {
      this.throwIfStopped(abortSignal)
      streamedText = fullContent || '（无回复）'
      await syncAssistantMessages()
    }

    return fullContent
  }

  private stopScopeRequests(scopeKey: string) {
    let active = 0
    let queued = 0

    if (this.activeRequest?.scopeKey === scopeKey && !this.activeRequest.controller.signal.aborted) {
      this.activeRequest.controller.abort()
      active += 1
    }

    const remaining: QueuedRequest[] = []
    for (const entry of this.requestQueue) {
      if (entry.scopeKey === scopeKey && !entry.controller.signal.aborted) {
        entry.controller.abort()
        entry.reject(new Error(REQUEST_STOPPED_MESSAGE))
        queued += 1
        continue
      }
      remaining.push(entry)
    }
    this.requestQueue = remaining

    return { active, queued }
  }

  private formatStopResult(result: { active: number; queued: number }) {
    if (result.active === 0 && result.queued === 0) {
      return '当前频道或话题没有正在处理或排队中的请求。'
    }

    const parts: string[] = []
    if (result.active > 0) parts.push(`${result.active} 个进行中的请求`)
    if (result.queued > 0) parts.push(`${result.queued} 个排队中的请求`)
    return `已停止当前频道或话题中的${parts.join('，')}。`
  }

  private formatToolResult(event: Extract<AgentEvent, { type: 'tool_result' }>): string {
    if (!event.ok) {
      return event.result === 'User denied this tool call.'
        ? `❌ **${event.name}** — 已拒绝`
        : `⚠️ **${event.name}** — ${event.result.slice(0, 300)}`
    }
    if (!event.result.trim()) return `✅ **${event.name}** — 完成`
    const display = event.result.length > 800
      ? `${event.result.slice(0, 800)}\n...（共 ${event.result.length} 字符）`
      : event.result
    return `✅ **${event.name}**\n\`\`\`\n${display}\n\`\`\``
  }

  private getUserFacingErrorMessage(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return message.includes(LLM_RATE_LIMIT_MESSAGE)
      ? LLM_RATE_LIMIT_MESSAGE
      : 'Something went wrong, please try again.'
  }

  private isRequestStoppedError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return message.includes(REQUEST_STOPPED_MESSAGE)
  }

  private throwIfStopped(signal?: AbortSignal) {
    if (signal?.aborted) {
      throw new Error(REQUEST_STOPPED_MESSAGE)
    }
  }

  private isAllowedDiscordUser(userId: string) {
    const allowedUserIds = this.parseDiscordIdList(this.instance.discordUserId)
    return allowedUserIds.length === 0 || allowedUserIds.includes(userId)
  }

  private isAllowedDiscordChannel(channelId: string, parentChannelId: string | null) {
    const allowedChannelIds = this.parseDiscordIdList(this.instance.discordChannelId)
    if (allowedChannelIds.length === 0) {
      return true
    }

    return allowedChannelIds.includes(channelId)
      || (!!parentChannelId && allowedChannelIds.includes(parentChannelId))
  }

  private parseDiscordIdList(value: string) {
    return value
      .split(/[\s,]+/)
      .map(item => item.trim())
      .filter(Boolean)
  }

  private async handleInteraction(interaction: import('discord.js').Interaction) {
    if (interaction.isButton()) {
      const [action, callId] = interaction.customId.split(':')
      if ((action === 'tool_approve' || action === 'tool_deny') && callId) {
        const approval = this.pendingApprovals.get(callId)
        const approved = action === 'tool_approve'
        if (approval) {
          await approval.finish(approved, interaction)
        }
        else {
          await interaction.reply({ content: '此操作已过期。', ephemeral: true }).catch(() => {})
        }
        return
      }
    }

    if (!interaction.isChatInputCommand()) return

    try {
      if (!this.isAllowedDiscordUser(interaction.user.id)) {
        await interaction.reply({
          content: '你不在此机器人的允许用户列表中。',
          ephemeral: true,
        })
        return
      }

      if (this.instance.discordGuildId && interaction.guildId !== this.instance.discordGuildId) {
        await interaction.reply({
          content: '此命令只能在已配置的 Discord 服务器中使用。',
          ephemeral: true,
        })
        return
      }

      const parentChannelId = interaction.channel?.isThread() ? interaction.channel.parentId : null
      if (!this.isAllowedDiscordChannel(interaction.channelId, parentChannelId)) {
        await interaction.reply({
          content: '此命令只能在已配置的频道或其子区中使用。',
          ephemeral: true,
        })
        return
      }

      if (interaction.commandName === STOP_COMMAND.name) {
        await interaction.reply({
          content: this.formatStopResult(this.stopScopeRequests(this.buildChannelScope(interaction.channelId, interaction.guildId).scopeKey)),
          ephemeral: true,
        })
        return
      }

      if (interaction.commandName === MANUAL_BROWSER_COMMAND.name) {
        await interaction.deferReply({ ephemeral: true })
        await interaction.editReply(await this.startManualBrowser())
        return
      }

      if (interaction.commandName === MODEL_COMMAND.name) {
        await interaction.deferReply({ ephemeral: true })
        const index = interaction.options.getInteger('index') ?? undefined
        const replies = typeof index === 'number'
          ? [await this.modelCommand.switchByIndexReply(index)]
          : await this.modelCommand.buildListReply()
        await interaction.editReply(replies[0] ?? '未获取到模型列表。')
        for (const reply of replies.slice(1)) {
          await interaction.followUp({ content: reply, ephemeral: true })
        }
        return
      }

      if (interaction.commandName !== NEW_TOPIC_COMMAND.name) return

      const { topic, thread } = await this.createDetachedThreadTopic(
        interaction.channelId,
        interaction.guildId,
        interaction.user.username,
      )

      await interaction.reply({
        content: `已开启新话题：${topic.name}\n子区：<#${thread.id}>`,
        ephemeral: true,
      })
    } catch (err) {
      console.error(`[Discord] Command error in "${this.instance.name}":`, err)

      const errorMessage = interaction.commandName === MANUAL_BROWSER_COMMAND.name
        ? '拉起手动浏览器失败，请稍后重试。'
        : interaction.commandName === MODEL_COMMAND.name
            ? (err instanceof Error ? err.message : '获取或切换模型失败，请稍后重试。')
            : '开启新话题失败，请稍后重试。'

      if (interaction.deferred && !interaction.replied) {
        await interaction.editReply(errorMessage).catch(() => {})
        return
      }

      if (interaction.replied) {
        await interaction.followUp({
          content: errorMessage,
          ephemeral: true,
        }).catch(() => {})
        return
      }

      await interaction.reply({
        content: errorMessage,
        ephemeral: true,
      }).catch(() => {})
    }
  }

  private async registerCommands() {
    const application = this.client.application
    if (!application) throw new Error('Discord application is not ready')

    if (this.instance.discordGuildId) {
      const guild = await this.client.guilds.fetch(this.instance.discordGuildId)
      const existing = await guild.commands.fetch()

      for (const definition of [NEW_TOPIC_COMMAND, STOP_COMMAND, MANUAL_BROWSER_COMMAND, MODEL_COMMAND]) {
        const command = existing.find(item => item.name === definition.name)
        if (command) {
          await command.edit(definition)
        }
        else {
          await guild.commands.create(definition)
        }
      }

      console.log(`[Discord] Registered /${NEW_TOPIC_COMMAND.name}, /${STOP_COMMAND.name}, /${MANUAL_BROWSER_COMMAND.name}, and /${MODEL_COMMAND.name} for guild ${guild.id}`)
      return
    }

    const existing = await application.commands.fetch()

    for (const definition of [NEW_TOPIC_COMMAND, STOP_COMMAND, MANUAL_BROWSER_COMMAND, MODEL_COMMAND]) {
      const command = existing.find(item => item.name === definition.name)
      if (command) {
        await command.edit(definition)
      }
      else {
        await application.commands.create(definition)
      }
    }

    console.log(`[Discord] Registered global /${NEW_TOPIC_COMMAND.name}, /${STOP_COMMAND.name}, /${MANUAL_BROWSER_COMMAND.name}, and /${MODEL_COMMAND.name}`)
  }

  applyRuntimeUpdate(instance: BotInstanceRow, agent: Agent) {
    Object.assign(this.instance, instance)
    this.agent = agent
  }

  private async startManualBrowser() {
    const toolName = this.agent.findEnabledToolName('_manual_login')
    if (!toolName) {
      throw new Error('No enabled manual login browser tool found for this bot')
    }

    const result = await this.agent.executeEnabledTool(toolName, {
      url: DEFAULT_MANUAL_BROWSER_URL,
      waitUntil: 'domcontentloaded',
    })

    return this.formatManualBrowserResult(result)
  }

  private formatManualBrowserResult(result: string) {
    try {
      const parsed = JSON.parse(result) as {
        noVncUrl?: string
        vncPassword?: string
        url?: string
        message?: string
        label?: string
      }

      const lines = [
        `已拉起${parsed.label ? ` ${parsed.label}` : ''} 手动浏览器。`,
        `页面：${parsed.url ?? DEFAULT_MANUAL_BROWSER_URL}`,
        `noVNC：${parsed.noVncUrl ?? '未返回'}`,
        `密码：${parsed.vncPassword ?? '未返回'}`,
      ]

      if (parsed.message) {
        lines.push(parsed.message)
      }

      return lines.join('\n')
    }
    catch {
      return result
    }
  }

  async deleteConversationThread(
    topic: { id: string; sourceId: string },
    metadata: Record<string, unknown>,
  ) {
    const threadId = typeof metadata.threadId === 'string' && metadata.threadId.trim()
      ? metadata.threadId.trim()
      : topic.sourceId.trim()

    if (!threadId) {
      throw new Error(`Conversation topic "${topic.id}" is missing Discord thread metadata`)
    }

    this.stopScopeRequests(`discord:${threadId}`)

    try {
      const channel = await this.client.channels.fetch(threadId)
      if (!channel) return
      if (!channel.isThread()) {
        throw new Error(`Discord channel "${threadId}" is not a thread`)
      }
      await channel.delete()
    }
    catch (error) {
      if (this.isUnknownDiscordThreadError(error)) {
        return
      }
      throw new Error(`Failed to delete Discord thread: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async pruneOldThreads(channel: Message['channel'], maxCount: number) {
    if (!this.client.user || !('threads' in channel)) return
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { threads } = await (channel as any).threads.fetchActive() as { threads: import('discord.js').Collection<string, import('discord.js').ThreadChannel> }
      const botId = this.client.user.id
      const botThreads = [...threads.values()]
        .filter(t => t.ownerId === botId)
        .sort((a, b) => (a.createdTimestamp ?? 0) - (b.createdTimestamp ?? 0))
      const excess = botThreads.length - maxCount
      if (excess <= 0) return
      await Promise.all(botThreads.slice(0, excess).map(t => t.delete().catch(() => {})))
    }
    catch {
      // 忽略权限不足等错误
    }
  }

  private startNewTopic(scope: ConversationScope) {
    return this.conversations.startNewTopic(this.instance, scope)
  }

  private async processTopicMessage(
    topicId: string,
    scope: ConversationScope,
    input: Parameters<ConversationService['appendMessage']>[3],
    createMessage: CreateMessage,
    sendTyping: () => Promise<unknown>,
  ) {
    this.conversations.appendMessage(this.instance, topicId, scope, input)
    await sendTyping()
    const fullReply = await this.enqueueTopicReply(topicId, scope.scopeKey, createMessage)
    this.conversations.appendMessage(this.instance, topicId, scope, {
      role: 'assistant',
      content: fullReply,
      senderId: this.client.user?.id ?? '',
      senderName: this.client.user?.username ?? this.instance.name,
    })
  }

  private async createThreadTopicFromMessage(msg: Message, userText: string) {
    const thread = await msg.startThread({ name: this.buildThreadName(userText) })
    await this.pruneThreadsIfNeeded(msg.channel)
    const scope = this.buildThreadScope(thread.id, msg.channelId, msg.guildId, msg.id)
    const topic = this.startNewTopic(scope)
    return { thread, topic, scope }
  }

  private async createDetachedThreadTopic(
    channelId: string,
    guildId: string | null,
    requesterName: string,
  ) {
    const parentChannel = await this.resolveParentChannel(channelId)
    const starter = await parentChannel.send({
      content: `为 ${requesterName} 开启了一个新话题。`,
    })
    const thread = await starter.startThread({ name: this.buildThreadName(requesterName) })
    await this.pruneThreadsIfNeeded(parentChannel)
    const scope = this.buildThreadScope(thread.id, parentChannel.id, guildId, starter.id)
    const topic = this.startNewTopic(scope)
    return { thread, topic, scope }
  }

  private async resolveParentChannel(channelId: string): Promise<SendableChannel> {
    const channel = await this.client.channels.fetch(channelId)
    if (!channel?.isTextBased() || !('send' in channel)) {
      throw new Error(`Channel ${channelId} is not a sendable text channel`)
    }

    const parent = channel.isThread() ? channel.parent : channel
    if (!parent?.isTextBased() || !('send' in parent)) {
      throw new Error(`Channel ${channelId} has no sendable parent channel`)
    }

    return parent as SendableChannel
  }

  private async pruneThreadsIfNeeded(channel: Message['channel'] | SendableChannel) {
    const { maxThreadsPerChannel } = this.getGeneralSettings()
    if (maxThreadsPerChannel > 0) {
      await this.pruneOldThreads(channel as Message['channel'], maxThreadsPerChannel)
    }
  }

  private buildThreadScope(
    threadId: string,
    parentChannelId: string,
    guildId: string | null,
    starterMessageId: string,
  ): ConversationScope {
    return {
      platform: this.instance.platform,
      scopeKey: `discord:${threadId}`,
      sourceType: 'discord_thread',
      sourceId: threadId,
      metadata: {
        threadId,
        parentChannelId,
        guildId: guildId ?? '',
        starterMessageId,
      },
    }
  }

  private buildThreadName(seed: string) {
    const normalized = (seed.replace(/<a?:\w+:\d+>/g, '').trim() || seed).slice(0, 100)
    if (normalized) {
      return normalized
    }

    return `新话题-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`
  }

  private isUnknownDiscordThreadError(error: unknown) {
    return typeof error === 'object' && error !== null && 'code' in error && Number(error.code) === 10003
  }

  private buildChannelScope(channelId: string, guildId: string | null): ConversationScope {
    return {
      platform: this.instance.platform,
      scopeKey: `discord:${channelId}`,
      sourceType: 'discord_channel',
      sourceId: channelId,
      metadata: {
        channelId,
        guildId: guildId ?? '',
      },
    }
  }

  async start() {
    await this.client.login(this.instance.token)
  }

  async stop() {
    this.client.destroy()
    console.log(`[Discord] "${this.instance.name}" disconnected.`)
  }

  async sendMessage(channelId: string, content: string) {
    const channel = await this.client.channels.fetch(channelId)
    if (!channel?.isTextBased() || !('send' in channel)) {
      throw new Error(`Channel ${channelId} is not a sendable text channel`)
    }
    await channel.send(content)
  }
}
