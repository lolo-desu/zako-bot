import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import type { DB } from '../client.js'
import {
  conversationMessages,
  conversationTopics,
  type NewConversationMessageRow,
  type NewConversationTopicRow,
} from '../schema/index.js'

export function getActiveConversationTopic(
  db: DB,
  botInstanceId: string,
  platform: string,
  scopeKey: string,
) {
  return db
    .select()
    .from(conversationTopics)
    .where(and(
      eq(conversationTopics.botInstanceId, botInstanceId),
      eq(conversationTopics.platform, platform),
      eq(conversationTopics.scopeKey, scopeKey),
      eq(conversationTopics.status, 'active'),
    ))
    .orderBy(desc(conversationTopics.createdAt))
    .get()
}

export function getConversationTopic(db: DB, topicId: string) {
  return db
    .select()
    .from(conversationTopics)
    .where(eq(conversationTopics.id, topicId))
    .get()
}

export function listConversationTopics(db: DB, botInstanceId: string) {
  return db
    .select()
    .from(conversationTopics)
    .where(eq(conversationTopics.botInstanceId, botInstanceId))
    .orderBy(desc(conversationTopics.updatedAt), desc(conversationTopics.createdAt))
    .all()
}

export function createConversationTopic(db: DB, values: NewConversationTopicRow) {
  db.insert(conversationTopics).values(values).run()
  return db
    .select()
    .from(conversationTopics)
    .where(eq(conversationTopics.id, values.id))
    .get()
}

export function archiveActiveConversationTopics(
  db: DB,
  botInstanceId: string,
  platform: string,
  scopeKey: string,
  archivedAt: Date,
) {
  return db
    .update(conversationTopics)
    .set({
      status: 'archived',
      updatedAt: archivedAt,
    })
    .where(and(
      eq(conversationTopics.botInstanceId, botInstanceId),
      eq(conversationTopics.platform, platform),
      eq(conversationTopics.scopeKey, scopeKey),
      eq(conversationTopics.status, 'active'),
    ))
    .run()
}

export function startConversationTopic(
  db: DB,
  input: Omit<NewConversationTopicRow, 'id' | 'createdAt' | 'updatedAt'> & { now?: Date },
) {
  const now = input.now ?? new Date()
  archiveActiveConversationTopics(db, input.botInstanceId, input.platform, input.scopeKey, now)

  return createConversationTopic(db, {
    id: randomUUID(),
    botInstanceId: input.botInstanceId,
    platform: input.platform,
    scopeKey: input.scopeKey,
    name: input.name,
    status: input.status ?? 'active',
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    metadata: input.metadata,
    createdAt: now,
    updatedAt: now,
  })
}

export function createConversationMessage(db: DB, values: NewConversationMessageRow) {
  db.insert(conversationMessages).values(values).run()
  return db
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.id, values.id))
    .get()
}

export function appendConversationMessage(
  db: DB,
  input: Omit<NewConversationMessageRow, 'id' | 'createdAt'> & { now?: Date },
) {
  const now = input.now ?? new Date()
  db
    .update(conversationTopics)
    .set({ updatedAt: now })
    .where(eq(conversationTopics.id, input.topicId))
    .run()

  return createConversationMessage(db, {
    id: randomUUID(),
    topicId: input.topicId,
    botInstanceId: input.botInstanceId,
    platform: input.platform,
    role: input.role,
    content: input.content,
    messageType: input.messageType,
    platformMessageId: input.platformMessageId,
    senderId: input.senderId,
    senderName: input.senderName,
    metadata: input.metadata,
    createdAt: now,
  })
}

export function listConversationMessages(db: DB, topicId: string, limit = 40) {
  const rows = db
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.topicId, topicId))
    .orderBy(desc(conversationMessages.createdAt))
    .limit(limit)
    .all()

  return rows.slice().reverse()
}

export function deleteConversationMessagesByTopicIds(db: DB, topicIds: string[]) {
  if (topicIds.length === 0) return

  db
    .delete(conversationMessages)
    .where(inArray(conversationMessages.topicId, topicIds))
    .run()
}

export function deleteConversationTopicsByBotId(db: DB, botInstanceId: string) {
  const topics = db
    .select({ id: conversationTopics.id })
    .from(conversationTopics)
    .where(eq(conversationTopics.botInstanceId, botInstanceId))
    .orderBy(asc(conversationTopics.createdAt))
    .all()

  const topicIds = topics.map(topic => topic.id)
  deleteConversationMessagesByTopicIds(db, topicIds)

  return db
    .delete(conversationTopics)
    .where(eq(conversationTopics.botInstanceId, botInstanceId))
    .run()
}

export function deleteConversationTopicById(db: DB, topicId: string) {
  const existing = getConversationTopic(db, topicId)
  if (!existing) {
    return undefined
  }

  db
    .delete(conversationTopics)
    .where(eq(conversationTopics.id, topicId))
    .run()

  return existing
}
