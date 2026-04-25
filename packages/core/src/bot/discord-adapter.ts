import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js'
import type { ButtonInteraction, ChatInputCommandInteraction, Interaction, Message, MessageEditOptions, ModalSubmitInteraction, TextBasedChannel } from 'discord.js'
import type { BotInstanceRow, RoleRow } from '@zakobot/database'
import type { AgentEvent, GeneralSettings, ToolApprovalCallback, ToolApprovalDecision } from '@zakobot/shared'
import type { Agent } from '../llm/agent.js'
import type { ConversationScope, ConversationService } from '../llm/conversation-service.js'
import { buildAssistantMessageChunks } from './discord-stream-renderer.js'
import { DiscordModelCommand, MODEL_COMMAND } from './model-command.js'

const TOOL_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000
const TOOL_APPROVAL_AI_REPLY_TTL_MS = 30 * 1000
const COMMAND_REGISTRATION_COOLDOWN_MS = 5 * 60 * 1000
const LLM_RATE_LIMIT_MESSAGE = 'LLM 服务当前过于繁忙，请稍等片刻后重试。'
const REQUEST_STOPPED_MESSAGE = '请求已停止。'
const QUEUED_REQUEST_NOTICE = '当前机器人还有其他请求正在处理，已加入队列。可通过 /stop 停止当前频道或话题中的请求。'

const recentCommandRegistrations = new Map<string, number>()
const pendingCommandRegistrations = new Map<string, Promise<void>>()

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
  finish: (decision: ToolApprovalDecision) => Promise<void>
  remember: () => Promise<void>
  guide: (interaction: ModalSubmitInteraction, guidance: string) => Promise<void>
  askAI: (interaction: ModalSubmitInteraction, question: string) => Promise<void>
}

type ToolProgressEntry = {
  kind: 'tool'
  id: string
  status: string
  summary: string
  command?: string
  note?: string
}

type NoticeProgressEntry = {
  kind: 'notice'
  id: string
  content: string
}

type ProgressEntry = ToolProgressEntry | NoticeProgressEntry

type PendingApprovalMessage = {
  entry: ToolProgressEntry
  components: ActionRowBuilder<ButtonBuilder>[]
}

type CreateMessage = (payload: MsgPayload) => Promise<Message>

type RepliableInteraction = ButtonInteraction | ModalSubmitInteraction | ChatInputCommandInteraction

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
  private rememberedApprovals = new Map<string, Set<string>>()
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
    this.client.on('shardDisconnect', (_event, shardId) => {
      console.warn(`[Discord] "${this.instance.name}" shard ${shardId} disconnected.`)
    })
    this.client.on('shardReconnecting', (shardId) => {
      console.warn(`[Discord] "${this.instance.name}" shard ${shardId} reconnecting.`)
    })
    this.client.on('shardResume', (replayedEvents, shardId) => {
      console.log(`[Discord] "${this.instance.name}" shard ${shardId} resumed with ${replayedEvents} replayed events.`)
    })
    this.client.on('error', (error) => {
      console.error(`[Discord] Client error in "${this.instance.name}":`, error)
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
    const logEntries: ProgressEntry[] = queuedNotice
      ? [{ kind: 'notice', id: 'queue_notice', content: queuedNotice }]
      : []
    let noticeCounter = 0
    let streamedText = ''
    let toolProgressMessage: Message | undefined
    let pendingApprovalMessage: PendingApprovalMessage | undefined
    const assistantMessages: { message: Message; content: string }[] = []

    const renderToolContent = () => {
      const currentEntry = pendingApprovalMessage?.entry ?? logEntries.at(-1)
      const historyEntries = pendingApprovalMessage
        ? logEntries
        : logEntries.slice(0, -1)
      const recentHistory = historyEntries.slice(-4)

      const content = [
        recentHistory.length > 0 ? this.renderProgressHistory(recentHistory) : '',
        currentEntry ? this.renderProgressCurrent(currentEntry) : '',
      ]
        .filter(Boolean)
        .join('\n\n')
        .trim() || '（处理中...）'

      if (content.length <= MAX_DISCORD_MESSAGE_CHARS) {
        return content
      }

      const prefix = '...(内容已截断)\n'
      return `${prefix}${content.slice(-(MAX_DISCORD_MESSAGE_CHARS - prefix.length))}`
    }

    const commitToolMessage = async () => {
      if (!logEntries.length && !pendingApprovalMessage && !toolProgressMessage) {
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

    const pushNotice = async (line: string) => {
      logEntries.push({ kind: 'notice', id: `notice_${++noticeCounter}`, content: line })
      await commitToolMessage()
    }

    const setToolLog = async (entry: ToolProgressEntry) => {
      const existing = logEntries.find(candidate => candidate.id === entry.id)
      if (existing) {
        if (existing.kind === 'tool') {
          existing.status = entry.status
          existing.summary = entry.summary
          existing.command = entry.command
          existing.note = entry.note
        }
      }
      else {
        logEntries.push(entry)
      }
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

    requestApproval = async (callId, name, input) => {
      this.throwIfStopped(abortSignal)

      if (!this.shouldRequireApproval(name, input, toolApprovalMode)) {
        return { approved: true }
      }

      const fingerprint = this.buildApprovalFingerprint(name, input)
      if (this.hasRememberedApproval(topicId, fingerprint)) {
        await setToolLog(this.createToolProgressEntry(callId, name, input, '已自动通过', '已按“始终”规则自动放行'))
        return { approved: true }
      }

      const summary = this.buildToolActionSummary(name, input)
      toolCallSummaries.set(callId, summary)
      const entry = this.buildApprovalEntry(callId, name, input, summary)

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`tool_approve:${callId}`)
          .setLabel('通过')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`tool_always:${callId}`)
          .setLabel('始终')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`tool_deny:${callId}`)
          .setLabel('拒绝')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`tool_guide:${callId}`)
          .setLabel('指导')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(`tool_ask_ai:${callId}`)
          .setLabel('询问')
          .setStyle(ButtonStyle.Secondary),
      )

      pendingApprovalMessage = { entry, components: [row] }
      const approvalMsg = await commitToolMessage()
      if (!approvalMsg) {
        throw new Error('Failed to create tool approval message')
      }

      return new Promise<ToolApprovalDecision>((resolve, reject) => {
        const finalize = async (decision: ToolApprovalDecision, logLine: string) => {
          clearTimeout(timer)
          abortSignal?.removeEventListener('abort', onAbort)
          this.pendingApprovals.delete(callId)
          pendingApprovalMessage = undefined
          await setToolLog(this.buildFinishedToolEntry(callId, name, input, summary, decision, logLine))
          resolve(decision)
        }

        const timer = setTimeout(() => {
          void finalize({ approved: false, reason: '审批超时，未执行。' }, `⏰ 工具授权超时：${summary}`)
        }, TOOL_APPROVAL_TIMEOUT_MS)

        const onAbort = () => {
          clearTimeout(timer)
          this.pendingApprovals.delete(callId)
          pendingApprovalMessage = undefined
          void setToolLog(this.createToolProgressEntry(callId, name, input, '已停止', '工具授权已停止'))
          reject(new Error(REQUEST_STOPPED_MESSAGE))
        }

        abortSignal?.addEventListener('abort', onAbort, { once: true })

        this.pendingApprovals.set(callId, {
          finish: async (decision) => {
            const reasonText = !decision.approved && decision.reason?.trim()
              ? `（原因：${decision.reason.trim()}）`
              : ''
            const guidanceText = !decision.approved && decision.guidance?.trim()
              ? `（指导：${decision.guidance.trim()}）`
              : ''
            await finalize(
              decision,
              decision.approved
                ? `✅ 已通过：${summary}`
                : decision.guidance?.trim()
                    ? `🧭 已指导：${summary}${guidanceText}`
                    : `❌ 已拒绝：${summary}${reasonText}`,
            )
          },
          remember: async () => {
            this.rememberApproval(topicId, fingerprint)
            await finalize(
              { approved: true, always: true },
              `♾️ 已设为始终通过：${summary}`,
            )
          },
          guide: async (interaction, guidance) => {
            const trimmed = guidance.trim()
            await this.replyEphemeral(interaction, trimmed ? '已记录指导，模型会按你的要求改方案。' : '未填写指导内容，已按拒绝处理。')
            await finalize(
              trimmed ? { approved: false, guidance: trimmed } : { approved: false },
              trimmed ? `🧭 已指导：${summary}（指导：${trimmed}）` : `❌ 已拒绝：${summary}`,
            )
          },
          askAI: async (interaction, question) => {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {})
            try {
              const answer = await this.agent.explainToolIntent(topicId, name, input, question)
              await interaction.editReply({
                content: this.buildApprovalAiReply(summary, question, answer),
              }).catch(() => {})
              setTimeout(() => {
                void interaction.deleteReply().catch(() => {})
              }, TOOL_APPROVAL_AI_REPLY_TTL_MS)
            }
            catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              await interaction.editReply({
                content: `无法获取解释：${message}`,
              }).catch(() => {})
            }
          },
        })
      })
    }

    let fullContent = ''
    const toolCallSummaries = new Map<string, string>()

    for await (const event of this.agent.respondStream(topicId, {
      requestApproval,
      abortSignal,
      onRateLimitRetry: async (_attempt, delayMs) => {
        this.throwIfStopped(abortSignal)
        await pushNotice(`${LLM_RATE_LIMIT_MESSAGE}，将在 ${Math.ceil(delayMs / 1000)} 秒后自动重试。可通过 /stop 停止当前请求。`)
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
          const summary = this.buildToolActionSummary(event.name, event.input)
          toolCallSummaries.set(event.callId, summary)
          // Only send a brief notification when no approval dialog will cover it
          const approvalWillShow = this.shouldRequireApproval(event.name, event.input, toolApprovalMode)
            && !this.hasRememberedApproval(topicId, this.buildApprovalFingerprint(event.name, event.input))
          if (!approvalWillShow) {
            this.throwIfStopped(abortSignal)
            await setToolLog(this.formatToolCall(event.callId, event.name, event.input, summary))
          }
          break
        }
        case 'tool_result':
          if (toolProcessMode === 'full') {
            this.throwIfStopped(abortSignal)
            await setToolLog(this.formatToolResult(event, toolCallSummaries.get(event.callId)))
            toolCallSummaries.delete(event.callId)
          }
          break
        case 'tool_limit_reached':
          this.throwIfStopped(abortSignal)
          console.warn(`[Discord] Tool-call limit reached for "${this.instance.name}" topic=${topicId} limit=${event.limit}`)
          await pushNotice(`⚠️ 已达到工具调用上限（${event.limit} 次），模型现在会停止继续调用工具，并基于已有信息直接给出回复。`)
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

  private renderProgressHistory(entries: ProgressEntry[]) {
    const lines = entries.map((entry) => {
      if (entry.kind === 'notice') {
        return `- ℹ️ ${this.truncateValue(entry.content, 120)}`
      }

      const badge = this.formatStatusBadge(entry.status)
      const command = entry.command ? ` ${this.inlineCode(this.truncateValue(entry.command, 90))}` : ''
      const note = entry.note ? ` · ${this.truncateValue(entry.note, 70)}` : ''
      return `- ${badge} ${entry.summary}${command}${note}`
    })

    return ['**最近记录**', ...lines].join('\n')
  }

  private renderProgressCurrent(entry: ProgressEntry) {
    if (entry.kind === 'notice') {
      return ['**当前状态**', `> ℹ️ ${entry.content}`].join('\n')
    }

    const badge = this.formatStatusBadge(entry.status)
    const lines = [
      '**当前操作**',
      `> 状态：${badge}`,
      `> 操作：${entry.summary}`,
    ]

    if (entry.command) {
      lines.push(`> 命令：${this.inlineCode(this.truncateValue(entry.command, 120))}`)
    }

    if (entry.note) {
      lines.push(`> 说明：${this.truncateValue(entry.note, 140)}`)
    }

    return lines.join('\n')
  }

  private formatStatusBadge(status: string) {
    const icons: Record<string, string> = {
      '处理中': '⏳ 处理中',
      '等待审批': '⚠️ 等待审批',
      '已自动通过': '♾️ 已自动通过',
      '已完成': '☑️ 已完成',
      '已指导': '🧭 已指导',
      '已拒绝': '✖️ 已拒绝',
      '失败': '⚠️ 执行失败',
      '已通过': '✅ 已通过',
      '已设为始终': '♾️ 已设为始终',
      '已停止': '⏹️ 已停止',
    }

    return icons[status] ?? status
  }

  private formatToolResult(event: Extract<AgentEvent, { type: 'tool_result' }>, summary?: string): ToolProgressEntry {
    const action = summary ?? this.buildToolActionSummary(event.name, undefined)
    if (event.ok) {
      return this.createToolProgressEntry(event.callId, event.name, undefined, '已完成', undefined, action)
    }

    const guidance = this.extractGuidance(event.result)
    if (guidance !== undefined) {
      return this.createToolProgressEntry(event.callId, event.name, undefined, '已指导', guidance || undefined, action)
    }

    const deniedReason = this.extractDeniedReason(event.result)
    if (deniedReason !== undefined) {
      return this.createToolProgressEntry(event.callId, event.name, undefined, '已拒绝', deniedReason || undefined, action)
    }

    const error = this.formatToolError(event.result).replace(/^[\s(]+|[)\s]+$/g, '') || undefined
    return this.createToolProgressEntry(event.callId, event.name, undefined, '失败', error, action)
  }

  private formatToolCall(callId: string, name: string, input: unknown, summary: string): ToolProgressEntry {
    return this.createToolProgressEntry(callId, name, input, '处理中', undefined, summary)
  }

  private createToolProgressEntry(
    id: string,
    name: string,
    input: unknown,
    status: string,
    note?: string,
    summary?: string,
  ): ToolProgressEntry {
    return {
      kind: 'tool',
      id,
      status,
      summary: summary ?? this.buildToolActionSummary(name, input),
      command: this.isShellLikeTool(name) ? this.getToolCommand(input) : undefined,
      note,
    }
  }

  private buildFinishedToolEntry(
    callId: string,
    name: string,
    input: unknown,
    summary: string,
    decision: ToolApprovalDecision,
    _logLine: string,
  ) {
    if (decision.always) {
      return this.createToolProgressEntry(callId, name, input, '已设为始终', '后续同类命令将自动放行', summary)
    }

    if (decision.approved) {
      return this.createToolProgressEntry(callId, name, input, '已通过', undefined, summary)
    }

    if (decision.guidance?.trim()) {
      return this.createToolProgressEntry(callId, name, input, '已指导', decision.guidance.trim(), summary)
    }

    return this.createToolProgressEntry(callId, name, input, '已拒绝', decision.reason?.trim(), summary)
  }

  private buildToolActionSummary(name: string, input: unknown) {
    const toolName = name.toLowerCase()
    const payload = this.asRecord(input)
    const url = this.pickToolField(payload, ['url', 'noVncUrl'])
    const selector = this.pickToolField(payload, ['selector', 'uid'])
    const command = this.pickToolField(payload, ['command'])
    const filePath = this.pickToolField(payload, ['filePath', 'requestFilePath', 'responseFilePath'])
    const pattern = this.pickToolField(payload, ['pattern', 'query', 'text'])
    const value = this.pickToolField(payload, ['value'])

    if (
      toolName === 'bash'
      || toolName === 'shell_exec'
      || toolName.includes('shell')
      || toolName.endsWith('__bash')
      || toolName.endsWith('_bash')
    ) {
      return '执行命令'
    }

    if (toolName === 'read' || toolName.endsWith('__read') || toolName.endsWith('_read')) {
      if (filePath) return `读取文件 ${this.inlineCode(filePath)}`
      if (url) return `查看页面 ${this.inlineCode(url)}`
      return toolName.includes('browser') ? '查看页面内容' : '读取内容'
    }

    if (toolName === 'write' || toolName.endsWith('__write') || toolName.endsWith('_write')) {
      return filePath ? `写入文件 ${this.inlineCode(filePath)}` : '写入文件'
    }

    if (toolName === 'edit' || toolName.endsWith('__edit') || toolName.endsWith('_edit')) {
      return filePath ? `修改文件 ${this.inlineCode(filePath)}` : '修改文件'
    }

    if (toolName.includes('apply_patch')) {
      return '应用代码补丁'
    }

    if (toolName === 'grep' || toolName.endsWith('__grep') || toolName.endsWith('_grep')) {
      return pattern ? `搜索内容 ${this.inlineCode(this.truncateValue(pattern, 80))}` : '搜索内容'
    }

    if (toolName === 'glob' || toolName.endsWith('__glob') || toolName.endsWith('_glob')) {
      return pattern ? `查找文件 ${this.inlineCode(this.truncateValue(pattern, 80))}` : '查找文件'
    }

    if (toolName.includes('webfetch') || toolName.includes('web_browse')) {
      return url ? `访问网页 ${this.inlineCode(url)}` : '访问网页'
    }

    if (toolName.includes('web_search')) {
      return pattern ? `搜索 ${this.inlineCode(this.truncateValue(pattern, 80))}` : '执行搜索'
    }

    if (toolName.includes('navigate') || toolName.endsWith('_open') || toolName.includes('goto')) {
      return url ? `打开页面 ${this.inlineCode(url)}` : '打开页面'
    }

    if (toolName.includes('manual_login')) {
      return url ? `启动手动浏览器并打开 ${this.inlineCode(url)}` : '启动手动浏览器'
    }

    if (toolName.endsWith('_start') || toolName.includes('browser_start')) {
      return '启动浏览器'
    }

    if (toolName.endsWith('_stop') || toolName.includes('browser_stop')) {
      return '停止浏览器'
    }

    if (toolName.endsWith('_status') || toolName.includes('browser_status')) {
      return '查看浏览器状态'
    }

    if (toolName.includes('click')) {
      return selector ? `点击 ${this.inlineCode(this.truncateValue(selector, 80))}` : '点击页面元素'
    }

    if (toolName.includes('type') || toolName.includes('fill')) {
      if (selector || value) {
        const target = selector ? `在 ${this.inlineCode(this.truncateValue(selector, 60))} 中` : ''
        return `${target}输入内容`.trim()
      }
      return '输入内容'
    }

    if (toolName.includes('screenshot')) {
      return filePath ? `截图到 ${this.inlineCode(filePath)}` : '截取页面截图'
    }

    if (toolName.includes('snapshot')) {
      return '查看页面快照'
    }

    if (toolName.includes('wait_for')) {
      return pattern ? `等待内容出现 ${this.inlineCode(this.truncateValue(pattern, 80))}` : '等待页面变化'
    }

    if (toolName.includes('evaluate')) {
      return '执行页面脚本'
    }

    return `调用工具 ${this.inlineCode(name)}`
  }

  private formatToolError(result: string) {
    const parsed = this.parseJsonObject(result)
    const message = this.pickToolField(parsed, ['error', 'message', 'detail'])
      ?? this.normalizeFreeText(result)

    if (!message) {
      return ''
    }

    return ` (${this.truncateValue(message, 120)})`
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined
    }

    return value as Record<string, unknown>
  }

  private parseJsonObject(value: string): Record<string, unknown> | undefined {
    try {
      const parsed = JSON.parse(value) as unknown
      return this.asRecord(parsed)
    }
    catch {
      return undefined
    }
  }

  private pickToolField(payload: Record<string, unknown> | undefined, keys: string[]) {
    if (!payload) {
      return undefined
    }

    for (const key of keys) {
      const value = payload[key]
      if (typeof value === 'string') {
        const normalized = value.replace(/\s+/g, ' ').trim()
        if (normalized) {
          return normalized
        }
      }
      if (Array.isArray(value) && value.length > 0) {
        const first = value[0]
        if (typeof first === 'string') {
          const normalized = first.replace(/\s+/g, ' ').trim()
          if (normalized) {
            return normalized
          }
        }
      }
    }

    return undefined
  }

  private normalizeFreeText(value: string) {
    const compact = value.replace(/\s+/g, ' ').trim()
    if (!compact || compact.startsWith('{') || compact.startsWith('[')) {
      return ''
    }

    return compact
  }

  private truncateValue(value: string, maxLength: number) {
    return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`
  }

  private inlineCode(value: string) {
    return `\`${value.replace(/`/g, '\\`')}\``
  }

  private isShellLikeTool(name: string) {
    const toolName = name.toLowerCase()
    return toolName === 'shell_exec'
      || toolName === 'bash'
      || toolName.includes('shell')
      || toolName.endsWith('__bash')
      || toolName.endsWith('_bash')
  }

  private getToolCommand(input: unknown) {
    const payload = this.asRecord(input)
    return this.pickToolField(payload, ['command'])
  }

  private getDangerousShellReason(command: string) {
    const normalized = command.toLowerCase().replace(/\s+/g, ' ').trim()
    const patterns: Array<{ pattern: RegExp; reason: string }> = [
      { pattern: /(^|\s)rm\s+/, reason: '删除文件或目录' },
      { pattern: /(^|\s)rmdir\s+/, reason: '删除目录' },
      { pattern: /(^|\s)del\s+/, reason: '删除文件' },
      { pattern: /(^|\s)rd\s+\/s\b/, reason: '递归删除目录' },
      { pattern: /(^|\s)unlink\s+/, reason: '移除文件链接' },
      { pattern: /(^|\s)mv\s+/, reason: '移动或覆盖现有文件' },
      { pattern: /(^|\s)dd\s+/, reason: '直接写入磁盘或镜像' },
      { pattern: /(^|\s)mkfs(\.|\s|$)/, reason: '格式化文件系统' },
      { pattern: /(^|\s)fdisk\s+/, reason: '修改磁盘分区' },
      { pattern: /(^|\s)parted\s+/, reason: '调整磁盘分区' },
      { pattern: /(^|\s)shutdown\s+/, reason: '关闭系统' },
      { pattern: /(^|\s)reboot(\s|$)/, reason: '重启系统' },
      { pattern: /(^|\s)poweroff(\s|$)/, reason: '关闭系统电源' },
      { pattern: /(^|\s)halt(\s|$)/, reason: '停止系统' },
      { pattern: /(^|\s)systemctl\s+(stop|restart|disable|mask|kill)\b/, reason: '修改系统服务状态' },
      { pattern: /(^|\s)service\s+\S+\s+(stop|restart)\b/, reason: '修改服务运行状态' },
      { pattern: /(^|\s)killall\s+/, reason: '终止一组进程' },
      { pattern: /(^|\s)pkill\s+/, reason: '按条件终止进程' },
      { pattern: /(^|\s)git\s+reset\s+--hard\b/, reason: '丢弃 git 工作区改动' },
      { pattern: /(^|\s)git\s+clean\s+-.*f/, reason: '清理未跟踪文件' },
      { pattern: /(^|\s)docker\s+(rm|rmi)\b/, reason: '删除容器或镜像' },
      { pattern: /(^|\s)docker\s+system\s+prune\b/, reason: '批量清理 Docker 资源' },
      { pattern: /(^|\s)kubectl\s+delete\b/, reason: '删除集群资源' },
      { pattern: /(^|\s)drop\s+(database|table|schema)\b/, reason: '删除数据库对象' },
      { pattern: /(^|\s)truncate\s+(table|collection)\b/, reason: '清空数据对象' },
    ]
    return patterns.find(entry => entry.pattern.test(normalized))?.reason
  }

  private isDangerousShellCommand(command: string) {
    return Boolean(this.getDangerousShellReason(command))
  }

  private isDangerousToolCall(name: string, input: unknown) {
    const command = this.getToolCommand(input)
    if (command && this.isShellLikeTool(name)) {
      return this.isDangerousShellCommand(command)
    }

    return false
  }

  private shouldRequireApproval(name: string, input: unknown, mode: GeneralSettings['toolApprovalMode']) {
    if (mode === 'all' && !this.isShellLikeTool(name)) {
      return true
    }

    if (this.isDangerousToolCall(name, input)) {
      return true
    }

    if (mode === 'none') {
      return false
    }

    if (this.isShellLikeTool(name)) {
      return false
    }

    return this.agent.isToolSensitive(name)
  }

  private buildApprovalFingerprint(name: string, input: unknown) {
    const command = this.getToolCommand(input)
    if (command && this.isShellLikeTool(name)) {
      return `${name}::command::${command.replace(/\s+/g, ' ').trim()}`
    }

    return `${name}::input::${this.safeJsonStringify(input)}`
  }

  private hasRememberedApproval(topicId: string, fingerprint: string) {
    return this.rememberedApprovals.get(topicId)?.has(fingerprint) ?? false
  }

  private rememberApproval(topicId: string, fingerprint: string) {
    const remembered = this.rememberedApprovals.get(topicId) ?? new Set<string>()
    remembered.add(fingerprint)
    this.rememberedApprovals.set(topicId, remembered)
  }

  private buildApprovalEntry(callId: string, name: string, input: unknown, summary: string): ToolProgressEntry {
    const command = this.getToolCommand(input)
    const riskReason = command ? this.getDangerousShellReason(command) : undefined
    return this.createToolProgressEntry(
      callId,
      name,
      input,
      '等待审批',
      riskReason ? `风险：高 · ${riskReason}` : '需要你确认后才能继续',
      summary,
    )
  }

  private buildApprovalAiReply(summary: string, question: string, answer: string) {
    const cleanedAnswer = answer.trim() || 'AI 没有返回额外说明。'
    const cleanedQuestion = question.trim() || '为什么现在需要执行这个操作？'
    return [
      '🧠 临时审批说明',
      `操作：${summary}`,
      `问题：${cleanedQuestion}`,
      cleanedAnswer,
      '',
      '_这条说明不会加入上下文，并会自动删除。_',
    ].join('\n')
  }

  private async replyEphemeral(interaction: RepliableInteraction, content: string) {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => {})
      return
    }

    await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {})
  }

  private extractDeniedReason(result: string) {
    if (result === 'User denied this tool call.') {
      return ''
    }

    const prefix = 'User denied this tool call. Reason:'
    if (!result.startsWith(prefix)) {
      return undefined
    }

    return result.slice(prefix.length).trim()
  }

  private extractGuidance(result: string) {
    const prefix = 'User denied this tool call. Guidance:'
    if (!result.startsWith(prefix)) {
      return undefined
    }

    return result.slice(prefix.length).trim()
  }

  private safeJsonStringify(value: unknown) {
    try {
      return JSON.stringify(value, null, 2)
    }
    catch {
      return String(value)
    }
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

  private parseInteractionAction(customId: string) {
    const separatorIndex = customId.indexOf(':')
    if (separatorIndex === -1) {
      return { action: customId, value: '' }
    }

    return {
      action: customId.slice(0, separatorIndex),
      value: customId.slice(separatorIndex + 1),
    }
  }

  private async ensureInteractionAllowed(interaction: RepliableInteraction) {
    if (!this.isAllowedDiscordUser(interaction.user.id)) {
      await this.replyEphemeral(interaction, '你不在此机器人的允许用户列表中。')
      return false
    }

    if (this.instance.discordGuildId && interaction.guildId !== this.instance.discordGuildId) {
      await this.replyEphemeral(interaction, '此交互只能在已配置的 Discord 服务器中使用。')
      return false
    }

    if (!interaction.channelId) {
      await this.replyEphemeral(interaction, '无法识别当前频道，无法执行此交互。')
      return false
    }

    const parentChannelId = interaction.channel?.isThread() ? interaction.channel.parentId : null
    if (!this.isAllowedDiscordChannel(interaction.channelId, parentChannelId)) {
      await this.replyEphemeral(interaction, '此交互只能在已配置的频道或其子区中使用。')
      return false
    }

    return true
  }

  private buildApprovalQuestionModal(customId: string, title: string, label: string, placeholder: string, required: boolean) {
    const input = new TextInputBuilder()
      .setCustomId('question')
      .setLabel(label)
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(required)
      .setMaxLength(500)
      .setPlaceholder(placeholder)

    return new ModalBuilder()
      .setCustomId(customId)
      .setTitle(title)
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input))
  }

  private async handleInteraction(interaction: Interaction) {
    if (!interaction.isButton() && !interaction.isModalSubmit() && !interaction.isChatInputCommand()) {
      return
    }

    if (!await this.ensureInteractionAllowed(interaction)) {
      return
    }

    if (interaction.isButton()) {
      const { action, value: callId } = this.parseInteractionAction(interaction.customId)
      const approval = callId ? this.pendingApprovals.get(callId) : undefined

      if (!callId || !action.startsWith('tool_')) {
        return
      }

      if (!approval) {
        await this.replyEphemeral(interaction, '此操作已过期。')
        return
      }

      if (action === 'tool_approve') {
        await interaction.deferUpdate().catch(() => {})
        await approval.finish({ approved: true })
        return
      }

      if (action === 'tool_always') {
        await interaction.deferUpdate().catch(() => {})
        await approval.remember()
        return
      }

      if (action === 'tool_deny') {
        await interaction.deferUpdate().catch(() => {})
        await approval.finish({ approved: false })
        return
      }

      if (action === 'tool_guide') {
        await interaction.showModal(this.buildApprovalQuestionModal(
          `tool_guide_modal:${callId}`,
          '指导模型',
          '指导内容',
          '例如：先 ls 确认目录，再仅删除临时文件，不要直接 rm -rf。',
          true,
        )).catch(() => {})
        return
      }

      if (action === 'tool_ask_ai') {
        await interaction.showModal(this.buildApprovalQuestionModal(
          `tool_ask_ai_modal:${callId}`,
          '临时问 AI',
          '你想问什么？',
          '例如：为什么现在需要执行这一步？如果拒绝会卡在哪里？',
          false,
        )).catch(() => {})
        return
      }
    }

    if (interaction.isModalSubmit()) {
      const { action, value: callId } = this.parseInteractionAction(interaction.customId)
      const approval = callId ? this.pendingApprovals.get(callId) : undefined

      if (!callId || !action.startsWith('tool_')) {
        return
      }

      if (!approval) {
        await this.replyEphemeral(interaction, '此操作已过期。')
        return
      }

      const question = interaction.fields.getTextInputValue('question').trim()

      if (action === 'tool_guide_modal') {
        await approval.guide(interaction, question)
        return
      }

      if (action === 'tool_ask_ai_modal') {
        await approval.askAI(interaction, question)
        return
      }
    }

    if (!interaction.isChatInputCommand()) return

    try {
      if (interaction.commandName === STOP_COMMAND.name) {
        await interaction.reply({
          content: this.formatStopResult(this.stopScopeRequests(this.buildChannelScope(interaction.channelId, interaction.guildId).scopeKey)),
          flags: MessageFlags.Ephemeral,
        })
        return
      }

      if (interaction.commandName === MANUAL_BROWSER_COMMAND.name) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral })
        await interaction.editReply(await this.startManualBrowser())
        return
      }

      if (interaction.commandName === MODEL_COMMAND.name) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral })
        const index = interaction.options.getInteger('index') ?? undefined
        const replies = typeof index === 'number'
          ? [await this.modelCommand.switchByIndexReply(index)]
          : await this.modelCommand.buildListReply()
        await interaction.editReply(replies[0] ?? '未获取到模型列表。')
        for (const reply of replies.slice(1)) {
          await interaction.followUp({ content: reply, flags: MessageFlags.Ephemeral })
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
        flags: MessageFlags.Ephemeral,
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
          flags: MessageFlags.Ephemeral,
        }).catch(() => {})
        return
      }

      await interaction.reply({
        content: errorMessage,
        flags: MessageFlags.Ephemeral,
      }).catch(() => {})
    }
  }

  private async registerCommands() {
    const application = this.client.application
    if (!application) throw new Error('Discord application is not ready')

    const scopeKey = this.instance.discordGuildId
      ? `guild:${application.id}:${this.instance.discordGuildId}`
      : `global:${application.id}`
    const now = Date.now()
    const lastRegisteredAt = recentCommandRegistrations.get(scopeKey) ?? 0
    if (now - lastRegisteredAt < COMMAND_REGISTRATION_COOLDOWN_MS) {
      return
    }

    const pending = pendingCommandRegistrations.get(scopeKey)
    if (pending) {
      await pending
      return
    }

    const registration = this.syncCommands(application, scopeKey)
    pendingCommandRegistrations.set(scopeKey, registration)

    try {
      await registration
    }
    finally {
      if (pendingCommandRegistrations.get(scopeKey) === registration) {
        pendingCommandRegistrations.delete(scopeKey)
      }
    }
  }

  private async syncCommands(application: NonNullable<DiscordAdapter['client']['application']>, scopeKey: string) {
    const definitions = [NEW_TOPIC_COMMAND, STOP_COMMAND, MANUAL_BROWSER_COMMAND, MODEL_COMMAND]

    if (this.instance.discordGuildId) {
      const guild = await this.client.guilds.fetch(this.instance.discordGuildId)
      const existing = await guild.commands.fetch()

      for (const definition of definitions) {
        const command = existing.find(item => item.name === definition.name)
        if (command) {
          await command.edit(definition)
        }
        else {
          await guild.commands.create(definition)
        }
      }

      recentCommandRegistrations.set(scopeKey, Date.now())
      console.log(`[Discord] Registered /${NEW_TOPIC_COMMAND.name}, /${STOP_COMMAND.name}, /${MANUAL_BROWSER_COMMAND.name}, and /${MODEL_COMMAND.name} for guild ${guild.id}`)
      return
    }

    const existing = await application.commands.fetch()

    for (const definition of definitions) {
      const command = existing.find(item => item.name === definition.name)
      if (command) {
        await command.edit(definition)
      }
      else {
        await application.commands.create(definition)
      }
    }

    recentCommandRegistrations.set(scopeKey, Date.now())
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
    const fullReply = await this.withTypingIndicator(
      sendTyping,
      () => this.enqueueTopicReply(topicId, scope.scopeKey, createMessage),
    )
    this.conversations.appendMessage(this.instance, topicId, scope, {
      role: 'assistant',
      content: fullReply,
      senderId: this.client.user?.id ?? '',
      senderName: this.client.user?.username ?? this.instance.name,
    })
  }

  private async withTypingIndicator<T>(
    sendTyping: () => Promise<unknown>,
    run: () => Promise<T>,
  ): Promise<T> {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const refreshTyping = async () => {
      if (stopped) return

      try {
        await sendTyping()
      }
      catch {
        // Ignore typing indicator failures so the actual reply can continue.
      }

      if (stopped) return
      timer = setTimeout(() => {
        void refreshTyping()
      }, 8000)
    }

    await refreshTyping()

    try {
      return await run()
    }
    finally {
      stopped = true
      if (timer) {
        clearTimeout(timer)
      }
    }
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
