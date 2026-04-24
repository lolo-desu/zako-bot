<template>
  <div class="flex h-[calc(100vh-4rem)] min-h-0 flex-col gap-6 overflow-hidden">
    <header class="flex flex-col gap-1">
      <h1 class="m-0 text-2xl font-bold text-[var(--text-primary)]">
        聊天
      </h1>
      <p class="m-0 text-sm text-[var(--text-secondary)]">
        直接查看并续接已有话题。
      </p>
    </header>

    <UAlert
      v-if="pageError"
      color="error"
      variant="subtle"
      icon="i-heroicons-x-circle-20-solid"
      title="聊天页加载失败"
      :description="pageError"
    />

    <section v-else class="flex min-h-0 flex-1 flex-col gap-4">
      <UAlert
        v-if="deleteTarget"
        color="error"
        variant="subtle"
        icon="i-heroicons-exclamation-triangle-20-solid"
        title="确认删除话题"
        :description="`话题「${deleteTarget.name}」删除后不可恢复。若它绑定了 Discord 子区，将一并删除对应子区。`"
        :actions="deleteConfirmActions"
        orientation="horizontal"
      />

      <div class="grid gap-3 lg:grid-cols-[18rem_minmax(0,1fr)_auto]">
        <UFormField label="机器人" name="bot">
          <USelect
            v-model="selectedBotId"
            class="w-full"
            :items="botOptions"
            :disabled="botsPending || !botOptions.length"
            placeholder="选择机器人"
          />
        </UFormField>

        <UFormField label="话题" name="topic">
          <USelect
            v-model="selectedTopicId"
            class="w-full"
            :items="topicOptions"
            :disabled="topicsPending || !selectedBotId || !topicOptions.length"
            placeholder="选择话题"
          />
        </UFormField>

        <div class="flex items-end">
          <div class="flex flex-wrap gap-2">
            <UButton
              label="新建话题"
              icon="i-heroicons-plus-20-solid"
              :loading="creatingTopic"
              :disabled="!selectedBotId || creatingTopic || deletingTopicId.length > 0"
              @click="handleCreateTopic"
            />
            <UButton
              label="删除话题"
              color="error"
              variant="outline"
              icon="i-heroicons-trash-20-solid"
              :loading="deleteTarget ? deletingTopicId === deleteTarget.id : false"
              :disabled="!selectedTopic || creatingTopic || deletingTopicId.length > 0"
              @click="openDeleteConfirm"
            />
          </div>
        </div>
      </div>

      <UAlert
        v-if="topicsError || messagesError"
        color="warning"
        variant="subtle"
        icon="i-heroicons-exclamation-triangle-20-solid"
        :description="topicsError || messagesError"
      />

      <section class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-[var(--card-border)] bg-[var(--card-bg)]">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--card-border)] px-4 py-3">
          <div class="min-w-0">
            <p class="truncate text-sm font-semibold text-[var(--text-primary)]">
              {{ selectedTopic?.name ?? '未选择话题' }}
            </p>
            <p class="truncate text-xs text-[var(--text-secondary)]">
              {{ selectedTopicMeta }}
            </p>
          </div>

          <UBadge
            v-if="selectedTopic"
            :label="topicSourceLabel(selectedTopic.sourceType)"
            color="neutral"
            variant="subtle"
          />
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto">
          <div v-if="topicsPending || messagesPending" class="space-y-3 px-4 py-4">
            <USkeleton class="h-16 w-3/4" />
            <USkeleton class="ml-auto h-14 w-2/3" />
            <USkeleton class="h-16 w-4/5" />
          </div>

          <UEmpty
            v-else-if="!selectedBotId"
            class="h-full"
            icon="i-heroicons-command-line-20-solid"
            title="暂无可用机器人"
            description="先选择一个机器人。"
          />

          <UEmpty
            v-else-if="!selectedTopic"
            class="h-full"
            icon="i-heroicons-chat-bubble-left-right-20-solid"
            title="还没有话题"
            description="创建新话题后即可开始聊天。"
          />

          <UChatMessages
            v-else
            :messages="uiMessages"
            :status="chatStatus"
            should-auto-scroll
            :user="{ icon: 'i-heroicons-user-20-solid', side: 'right', variant: 'soft' }"
            :assistant="assistantMessageProps"
            class="h-full px-4 py-4"
          >
            <template #content="{ message }">
              <div class="space-y-2">
                <template
                  v-for="(part, index) in message.parts"
                  :key="`${message.id}-${index}`"
                >
                  <template v-if="part.type === 'image'">
                    <img
                      :src="part.url"
                      class="max-w-[320px] rounded-md border border-[var(--card-border)]"
                      loading="lazy"
                      alt="图片"
                    >
                  </template>
                  <template v-else-if="message.role === 'user'">
                    <p class="whitespace-pre-wrap break-words text-sm leading-6 text-[var(--text-primary)]">
                      {{ part.text }}
                    </p>
                  </template>
                  <Comark
                    v-else
                    class="chat-markdown text-sm leading-6 text-[var(--text-primary)]"
                    :markdown="part.text"
                    :options="comarkOptions"
                    :plugins="comarkPlugins"
                    :streaming="isPartStreaming(message)"
                  />
                </template>
                <p
                  v-if="message.createdAt"
                  class="text-[11px] text-[var(--text-secondary)]"
                >
                  {{ formatTime(message.createdAt) }}
                </p>
              </div>
            </template>
          </UChatMessages>
        </div>

        <div class="border-t border-[var(--card-border)] px-4 py-4">
          <UAlert
            v-if="sendError"
            class="mb-3"
            color="error"
            variant="subtle"
            icon="i-heroicons-x-circle-20-solid"
            :description="sendError"
          />

          <UChatPrompt
            v-model="composer"
            :disabled="!selectedBotId || submitting"
            :error="promptError"
            :rows="3"
            :maxrows="8"
            :ui="promptUi"
            autoresize
            placeholder="输入消息"
            @submit="handleSubmit"
          >
            <template #trailing>
              <UChatPromptSubmit :status="chatStatus" size="md" />
            </template>
          </UChatPrompt>
        </div>
      </section>
    </section>
  </div>
</template>

<script setup lang="ts">
import highlight from '@comark/nuxt/plugins/highlight'
import security from '@comark/nuxt/plugins/security'
import type {
  BotListItem,
  ConversationMessage,
  ConversationTopic,
  SendConversationMessageResult,
} from '@zakobot/shared'

type SelectOption = {
  label: string
  value: string
}

type ChatStatus = 'ready' | 'submitted' | 'error'

type UiTextPart = {
  type: 'text'
  text: string
}

type UiImagePart = {
  type: 'image'
  url: string
}

type UiPart = UiTextPart | UiImagePart

type UiMessage = {
  id: string
  role: 'user' | 'assistant'
  parts: UiPart[]
  createdAt?: Date
}

const { data: botsData, pending: botsPending, error: botsError } = await useFetch<{ ok: true, data: BotListItem[] }>('/api/bots')

const toast = useToast()

const selectedBotId = ref('')
const selectedTopicId = ref('')
const composer = ref('')

const topics = ref<ConversationTopic[]>([])
const messages = ref<ConversationMessage[]>([])

const topicsPending = ref(false)
const messagesPending = ref(false)
const creatingTopic = ref(false)
const submitting = ref(false)
const deletingTopicId = ref('')
const sendError = ref('')
const topicsError = ref('')
const messagesError = ref('')
const deleteTarget = ref<ConversationTopic | null>(null)

const botOptions = computed<SelectOption[]>(() =>
  (botsData.value?.data ?? []).map(bot => ({
    label: bot.name,
    value: bot.id,
  })),
)

const topicOptions = computed<SelectOption[]>(() =>
  topics.value.map(topic => ({
    label: `${topicSourceLabel(topic.sourceType)} · ${topic.name}`,
    value: topic.id,
  })),
)

const selectedBot = computed(() =>
  (botsData.value?.data ?? []).find(bot => bot.id === selectedBotId.value) ?? null,
)

const selectedTopic = computed(() =>
  topics.value.find(topic => topic.id === selectedTopicId.value) ?? null,
)

const selectedTopicMeta = computed(() => {
  if (!selectedTopic.value) {
    return '选择话题后可继续上下文对话'
  }

  return `${topicSourceLabel(selectedTopic.value.sourceType)} · 更新于 ${formatTime(selectedTopic.value.updatedAt)}`
})

const pageError = computed(() => botsError.value?.message ?? '')

const chatStatus = computed<ChatStatus>(() => {
  if (sendError.value) return 'error'
  if (submitting.value) return 'submitted'
  return 'ready'
})

const promptError = computed(() => sendError.value ? new Error(sendError.value) : undefined)

const assistantMessageProps = computed(() => ({
  avatar: selectedBot.value?.roleAvatar
    ? {
        src: selectedBot.value.roleAvatar,
        alt: selectedBot.value.roleName,
      }
    : undefined,
  icon: selectedBot.value?.roleAvatar ? undefined : 'i-heroicons-cpu-chip-20-solid',
  side: 'left' as const,
  variant: 'soft' as const,
}))

const deleteConfirmActions = computed(() => [
  {
    label: '取消',
    color: 'neutral' as const,
    variant: 'outline' as const,
    disabled: deletingTopicId.value.length > 0,
    onClick: closeDeleteConfirm,
  },
  {
    label: deleteTarget.value && deletingTopicId.value === deleteTarget.value.id ? '删除中' : '确认删除',
    color: 'error' as const,
    loading: deleteTarget.value ? deletingTopicId.value === deleteTarget.value.id : false,
    disabled: deletingTopicId.value.length > 0,
    onClick: handleDeleteTopic,
  },
])

const promptUi = {
  base: 'min-h-[88px] pe-16 py-3',
  trailing: 'pe-3 inset-y-3 items-end',
}

const comarkOptions = {
  html: false,
}

const comarkPlugins = [
  security({
    allowDataImages: false,
    blockedTags: ['iframe', 'object', 'script', 'style'],
  }),
  highlight(),
]

const uiMessages = computed<UiMessage[]>(() =>
  messages.value.map((message) => {
    const parts: UiPart[] = []
    if (message.content) parts.push({ type: 'text', text: message.content })
    const imageUrls = Array.isArray(message.metadata?.imageUrls) ? message.metadata.imageUrls as string[] : []
    for (const url of imageUrls) parts.push({ type: 'image', url })
    return { id: message.id, role: message.role, parts, createdAt: new Date(message.createdAt) }
  }),
)

function isPartStreaming(message: UiMessage) {
  const lastMessage = uiMessages.value.at(-1)

  return chatStatus.value === 'submitted' && message.role === 'assistant' && message.id === lastMessage?.id
}

watch(botOptions, (options) => {
  if (!selectedBotId.value && options.length > 0) {
    selectedBotId.value = options[0]!.value
  }
}, { immediate: true })

watch(selectedBotId, async (botId) => {
  selectedTopicId.value = ''
  messages.value = []
  sendError.value = ''
  topicsError.value = ''
  messagesError.value = ''
  deleteTarget.value = null

  if (!botId) {
    topics.value = []
    return
  }

  await loadTopics(botId)
}, { immediate: true })

watch(selectedTopicId, async (topicId) => {
  sendError.value = ''
  messagesError.value = ''

  if (!selectedBotId.value || !topicId) {
    messages.value = []
    return
  }

  await loadMessages(selectedBotId.value, topicId)
})

async function loadTopics(botInstanceId: string, preferredTopicId?: string) {
  topicsPending.value = true

  try {
    const response = await $fetch<{ ok: true, data: ConversationTopic[] }>('/api/chat/topics', {
      query: { botInstanceId },
    })

    topics.value = response.data.slice(0, 20)

    const nextTopicId = preferredTopicId
      ?? (topics.value.some(topic => topic.id === selectedTopicId.value) ? selectedTopicId.value : topics.value[0]?.id ?? '')

    selectedTopicId.value = nextTopicId
  }
  catch (error: any) {
    topics.value = []
    topicsError.value = error?.data?.message ?? error?.message ?? '话题加载失败'
  }
  finally {
    topicsPending.value = false
  }
}

async function loadMessages(botInstanceId: string, topicId: string) {
  messagesPending.value = true

  try {
    const response = await $fetch<{ ok: true, data: ConversationMessage[] }>(`/api/chat/topics/${topicId}/messages`, {
      query: { botInstanceId },
    })

    messages.value = response.data
  }
  catch (error: any) {
    messages.value = []
    messagesError.value = error?.data?.message ?? error?.message ?? '聊天记录加载失败'
  }
  finally {
    messagesPending.value = false
  }
}

async function handleCreateTopic() {
  if (!selectedBotId.value) {
    return
  }

  creatingTopic.value = true
  sendError.value = ''

  try {
    const response = await $fetch<{ ok: true, data: ConversationTopic }>('/api/chat/topics', {
      method: 'POST',
      body: {
        botInstanceId: selectedBotId.value,
      },
    })

    await loadTopics(selectedBotId.value, response.data.id)
    messages.value = []
    toast.add({ title: `已创建话题「${response.data.name}」`, color: 'success' })
  }
  catch (error: any) {
    sendError.value = error?.data?.message ?? error?.message ?? '新建话题失败'
  }
  finally {
    creatingTopic.value = false
  }
}

function openDeleteConfirm() {
  if (!selectedTopic.value) {
    return
  }

  deleteTarget.value = selectedTopic.value
}

function closeDeleteConfirm() {
  if (!deletingTopicId.value) {
    deleteTarget.value = null
  }
}

async function handleDeleteTopic() {
  if (!selectedBotId.value || !deleteTarget.value) {
    return
  }

  const topic = deleteTarget.value
  deletingTopicId.value = topic.id
  sendError.value = ''

  try {
    await $fetch<{ ok: true, data: ConversationTopic }>(`/api/chat/topics/${topic.id}`, {
      method: 'DELETE',
      query: {
        botInstanceId: selectedBotId.value,
      },
    })

    deleteTarget.value = null
    messages.value = []
    await loadTopics(selectedBotId.value)
    toast.add({ title: `已删除话题「${topic.name}」`, color: 'success' })
  }
  catch (error: any) {
    sendError.value = error?.data?.message ?? error?.message ?? '删除话题失败'
  }
  finally {
    deletingTopicId.value = ''
  }
}

async function handleSubmit(event: Event) {
  event.preventDefault()

  if (!selectedBotId.value || !composer.value.trim() || submitting.value) {
    return
  }

  submitting.value = true
  sendError.value = ''

  try {
    const response = await $fetch<{ ok: true, data: SendConversationMessageResult }>('/api/chat/messages', {
      method: 'POST',
      body: {
        botInstanceId: selectedBotId.value,
        topicId: selectedTopicId.value || undefined,
        content: composer.value.trim(),
      },
    })

    composer.value = ''
    await loadTopics(selectedBotId.value, response.data.topic.id)
    await loadMessages(selectedBotId.value, response.data.topic.id)
  }
  catch (error: any) {
    sendError.value = error?.data?.message ?? error?.message ?? '发送消息失败'
  }
  finally {
    submitting.value = false
  }
}

function topicSourceLabel(sourceType: string) {
  if (sourceType === 'panel') return '控制台'
  if (sourceType === 'discord_thread') return 'Discord 子区'
  if (sourceType === 'discord_channel') return 'Discord 频道'
  return sourceType || '未知来源'
}

function formatTime(value: string | Date) {
  const date = typeof value === 'string' ? new Date(value) : value

  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}
</script>
