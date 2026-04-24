import type { ConversationTopic } from '@zakobot/shared'

export default defineEventHandler(async (event) => {
  const topicId = getRouterParam(event, 'id')
  const query = getQuery(event)
  const botInstanceId = String(query.botInstanceId ?? '').trim()

  if (!topicId || !botInstanceId) {
    throw createError({
      statusCode: 400,
      message: 'Bot instance ID and topic ID are required',
    })
  }

  try {
    const topic = await coreDelete<ConversationTopic>(
      `/conversations/${encodeURIComponent(topicId)}?botInstanceId=${encodeURIComponent(botInstanceId)}`,
    )
    return { ok: true, data: topic }
  }
  catch (error) {
    throw createError({
      statusCode: 400,
      message: error instanceof Error ? error.message : 'Failed to delete conversation topic',
    })
  }
})
