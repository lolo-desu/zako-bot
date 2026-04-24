import {
  appendConversationMessage,
  deleteConversationTopicById,
  getConversationTopic,
  getActiveConversationTopic,
  listConversationTopics,
  listConversationMessages,
  startConversationTopic,
  type ConversationMessageRow,
  type ConversationTopicRow,
  type BotInstanceRow,
  type DB,
} from '@zakobot/database'
import type { ChatMessage, ChatMessageContentPart } from '@zakobot/shared'

const MAX_HISTORY = 40

export interface ConversationScope {
  platform: string
  scopeKey: string
  sourceType: string
  sourceId: string
  metadata: Record<string, unknown>
}

export interface ConversationMessageInput {
  role: 'user' | 'assistant'
  content: string
  messageType?: string
  platformMessageId?: string
  senderId?: string
  senderName?: string
  metadata?: Record<string, unknown>
}

export class ConversationService {
  constructor(private db: DB) {}

  getOrCreateActiveTopic(instance: BotInstanceRow, scope: ConversationScope) {
    const existing = getActiveConversationTopic(this.db, instance.id, scope.platform, scope.scopeKey)
    if (existing) return existing

    return startConversationTopic(this.db, {
      botInstanceId: instance.id,
      platform: scope.platform,
      scopeKey: scope.scopeKey,
      name: this.buildTopicName(scope.platform),
      sourceType: scope.sourceType,
      sourceId: scope.sourceId,
      metadata: JSON.stringify(scope.metadata),
      status: 'active',
    })!
  }

  startNewTopic(instance: BotInstanceRow, scope: ConversationScope) {
    return startConversationTopic(this.db, {
      botInstanceId: instance.id,
      platform: scope.platform,
      scopeKey: scope.scopeKey,
      name: this.buildTopicName(scope.platform),
      sourceType: scope.sourceType,
      sourceId: scope.sourceId,
      metadata: JSON.stringify(scope.metadata),
      status: 'active',
    })!
  }

  getTopic(topicId: string) {
    return getConversationTopic(this.db, topicId)
  }

  deleteTopic(topicId: string) {
    return deleteConversationTopicById(this.db, topicId)
  }

  listTopics(botInstanceId: string) {
    return listConversationTopics(this.db, botInstanceId)
  }

  listTopicHistory(topicId: string): ChatMessage[] {
    return listConversationMessages(this.db, topicId, MAX_HISTORY)
      .filter(message => message.role === 'user' || message.role === 'assistant')
      .map((message): ChatMessage => {
        if (message.role === 'user') {
          let imageUrls: string[] = []
          try {
            const meta = JSON.parse(message.metadata || '{}') as Record<string, unknown>
            if (Array.isArray(meta.imageUrls)) imageUrls = meta.imageUrls as string[]
          }
          catch { /* ignore */ }

          if (imageUrls.length > 0) {
            const parts: ChatMessageContentPart[] = []
            if (message.content) parts.push({ type: 'text', text: message.content })
            for (const url of imageUrls) parts.push({ type: 'image_url', image_url: { url } })
            return { role: 'user', content: parts }
          }
        }

        return { role: message.role as 'user' | 'assistant', content: message.content }
      })
  }

  listTopicMessages(topicId: string): ConversationMessageRow[] {
    return listConversationMessages(this.db, topicId, 200)
  }

  appendMessage(instance: BotInstanceRow, topicId: string, scope: ConversationScope, input: ConversationMessageInput) {
    return appendConversationMessage(this.db, {
      topicId,
      botInstanceId: instance.id,
      platform: scope.platform,
      role: input.role,
      content: input.content,
      messageType: input.messageType ?? 'text',
      platformMessageId: input.platformMessageId ?? '',
      senderId: input.senderId ?? '',
      senderName: input.senderName ?? '',
      metadata: JSON.stringify({
        ...scope.metadata,
        ...(input.metadata ?? {}),
      }),
    })
  }

  private buildTopicName(platform: string) {
    const now = new Date()
    const timestamp = [
      now.getFullYear(),
      this.pad(now.getMonth() + 1, 2),
      this.pad(now.getDate(), 2),
      this.pad(now.getHours(), 2),
      this.pad(now.getMinutes(), 2),
      this.pad(now.getSeconds(), 2),
      this.pad(now.getMilliseconds(), 3),
    ].join('')

    return `${platform}-${timestamp}`
  }

  private pad(value: number, length: number) {
    return String(value).padStart(length, '0')
  }
}
