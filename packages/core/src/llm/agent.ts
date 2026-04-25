import type { RoleRow } from '@zakobot/database'
import type { AgentEvent, ChatMessage, GeneralSettings, LLMConfig } from '@zakobot/shared'
import { LLMClient } from './client.js'
import { ConversationService } from './conversation-service.js'
import type { RespondStreamOptions } from './respond-stream-options.js'
import { buildToolPrompt } from './tool-prompt.js'
import type { ToolRegistry } from '../tools/index.js'
import type { SkillManager } from '../skills/index.js'

export class Agent {
  private client: LLMClient

  constructor(
    private getRole: () => RoleRow,
    llmConfig: LLMConfig,
    private conversations: ConversationService,
    private toolRegistry: ToolRegistry,
    private skillManager: SkillManager,
    private getGeneralSettings: () => GeneralSettings,
  ) {
    this.client = new LLMClient(llmConfig)
  }

  async *respondStream(topicId: string, options: RespondStreamOptions = {}): AsyncGenerator<AgentEvent> {
    const role = this.getRole()
    const history = this.conversations.listTopicHistory(topicId)
    const { requestApproval, abortSignal, onRateLimitRetry } = options
    const { messages, allowedTools, maxToolCallRounds } = this.buildConversationRequest(role, history)

    yield* this.client.chatStream(messages, allowedTools, {
      maxToolCallRounds,
      requestApproval,
      abortSignal,
      onRateLimitRetry,
    })
  }

  async respond(topicId: string): Promise<string> {
    const role = this.getRole()
    const history = this.conversations.listTopicHistory(topicId)
    const { messages, allowedTools, maxToolCallRounds } = this.buildConversationRequest(role, history)

    const reply = await this.client.chat(messages, allowedTools, maxToolCallRounds)
    return reply
  }

  findEnabledToolName(suffix: string): string | null {
    const enabledTools = this.parseEnabledTools(this.getRole().enabledTools)
    return enabledTools.find(name => name.endsWith(suffix)) ?? null
  }

  async executeEnabledTool(name: string, args: Record<string, unknown>): Promise<string> {
    const enabledTools = this.parseEnabledTools(this.getRole().enabledTools)
    if (!enabledTools.includes(name)) {
      throw new Error(`Tool "${name}" is not enabled for this role`)
    }

    const tool = this.toolRegistry.list().find(item => item.name === name)
    if (!tool) {
      throw new Error(`Tool "${name}" is not available`)
    }

    return tool.execute(args)
  }

  async explainToolIntent(topicId: string, name: string, input: unknown, question?: string): Promise<string> {
    const role = this.getRole()
    const history = this.conversations.listTopicHistory(topicId)
    const { messages } = this.buildConversationRequest(role, history)
    const args = this.safeJsonStringify(input)
    const reviewerQuestion = question?.trim() || '为什么现在需要执行这个操作？'

    return this.client.chat([
      ...messages,
      {
        role: 'system',
        content: '你在帮助人工审核一项敏感工具调用。请直接对审核人说明：1) 助手为什么要做这件事；2) 具体会执行什么；3) 主要风险或影响；4) 如果拒绝，当前任务会卡在哪里。不要调用任何工具，不要泄露隐藏推理，不要编造结果。请使用简洁中文，控制在 4 行内。',
      },
      {
        role: 'user',
        content: `待审批工具：${name}\n参数：${args}\n审核人问题：${reviewerQuestion}`,
      },
    ], [], 1)
  }

  private buildConversationRequest(role: RoleRow, history: ChatMessage[]) {
    const { systemPrompt, maxToolCallRounds, sendTime, timezone } = this.getGeneralSettings()
    const enabledTools = this.parseEnabledTools(role.enabledTools)
    const enabledSkills = this.parseEnabledSkills(role.enabledSkills)
    const allowedTools = this.toolRegistry.listEnabled(enabledTools)
    const skillPrompt = this.skillManager.buildPrompt(enabledSkills, this.getLatestUserText(history))
    const toolPrompt = buildToolPrompt(allowedTools)
    const historyWithTime = sendTime ? this.injectSendTime(history, timezone) : history

    return {
      maxToolCallRounds,
      allowedTools,
      messages: [
        ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
        { role: 'system' as const, content: role.systemPrompt },
        ...(skillPrompt ? [{ role: 'system' as const, content: skillPrompt }] : []),
        ...(toolPrompt ? [{ role: 'system' as const, content: toolPrompt }] : []),
        ...historyWithTime,
      ],
    }
  }

  private injectSendTime(history: ChatMessage[], timezone: string): ChatMessage[] {
    const lastUserIndex = history.map(m => m.role).lastIndexOf('user')
    if (lastUserIndex === -1) return history

    const timeStr = new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date())

    const result = [...history]
    const msg = result[lastUserIndex]!
    const timeNote = `\n\n[发送时间：${timeStr} (${timezone})]`
    const newContent = Array.isArray(msg.content)
      ? [...msg.content, { type: 'text' as const, text: timeNote.trim() }]
      : `${msg.content}${timeNote}`
    result[lastUserIndex] = { ...msg, content: newContent }
    return result
  }

  isToolSensitive(name: string): boolean {
    const enabledTools = this.parseEnabledTools(this.getRole().enabledTools)
    return this.toolRegistry.listEnabled(enabledTools).find(t => t.name === name)?.sensitive === true
  }

  private parseEnabledTools(value: string): string[] {
    try {
      const parsed = JSON.parse(value) as unknown
      return Array.isArray(parsed)
        ? parsed.filter((tool): tool is string => typeof tool === 'string')
        : []
    }
    catch {
      return []
    }
  }

  private parseEnabledSkills(value: string): string[] {
    try {
      const parsed = JSON.parse(value) as unknown
      return Array.isArray(parsed)
        ? parsed.filter((skill): skill is string => typeof skill === 'string')
        : []
    }
    catch {
      return []
    }
  }

  private getLatestUserText(history: ChatMessage[]) {
    const message = [...history].reverse().find(item => item.role === 'user')
    const content = message?.content

    if (!content) {
      return ''
    }

    if (typeof content === 'string') {
      return content
    }

    return content
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('\n')
  }

  private safeJsonStringify(value: unknown) {
    try {
      return JSON.stringify(value)
    }
    catch {
      return String(value)
    }
  }
}
