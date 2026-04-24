<template>
  <div class="space-y-4">
    <UAlert
      v-if="pageError"
      color="error"
      variant="subtle"
      icon="i-heroicons-x-circle-20-solid"
      title="机器人加载失败"
      :description="pageError"
    />

    <USkeleton v-else-if="pending" class="h-[36rem] w-full" />

    <template v-else-if="bot">
      <UAlert
        v-if="showDeleteConfirm"
        color="error"
        variant="subtle"
        icon="i-heroicons-exclamation-triangle-20-solid"
        title="确认删除机器人"
        :description="`机器人「${bot.name}」删除后不可恢复。`"
        :actions="deleteConfirmActions"
        orientation="horizontal"
      />

      <BotEditorForm
        title="编辑机器人"
        description="修改连接信息、角色绑定和启用状态。"
        submit-label="保存修改"
        :initial-value="form"
        :role-options="roleOptions"
        :pending="saving || deleting"
        @submit="handleSubmit"
      >
        <template #actions-left>
          <UButton
            label="删除机器人"
            color="error"
            variant="outline"
            type="button"
            :loading="deleting"
            :disabled="saving || deleting"
            @click="openDeleteConfirm"
          />
        </template>
      </BotEditorForm>
    </template>
  </div>
</template>

<script setup lang="ts">
import type { BotEditorInput, BotProfile, RoleProfile } from '@zakobot/shared'

const route = useRoute()
const toast = useToast()
const botId = computed(() => String(route.params.id))

const [
  botState,
  rolesState,
] = await Promise.all([
  useFetch<{ ok: true, data: BotProfile }>(() => `/api/bots/${botId.value}`),
  useFetch<{ ok: true, data: RoleProfile[] }>('/api/roles'),
])

const { data, pending, error, refresh } = botState
const { data: rolesData, error: rolesError } = rolesState

const saving = ref(false)
const deleting = ref(false)
const showDeleteConfirm = ref(false)

const bot = computed(() => data.value?.data ?? null)
const roleOptions = computed(() =>
  (rolesData.value?.data ?? []).map(role => ({
    label: role.name,
    value: role.id,
  })),
)
const pageError = computed(() => error.value?.message ?? rolesError.value?.message ?? '')

const form = computed<BotEditorInput>(() => ({
  name: bot.value?.name ?? '',
  platform: bot.value?.platform ?? 'discord',
  token: bot.value?.token ?? '',
  roleId: bot.value?.roleId ?? '',
  llmProvider: bot.value?.llmProvider ?? 'openai',
  llmPlatformName: bot.value?.llmPlatformName ?? '',
  llmModel: bot.value?.llmModel ?? '',
  llmApiKey: bot.value?.llmApiKey ?? '',
  llmBaseUrl: bot.value?.llmBaseUrl ?? '',
  discordUserId: bot.value?.discordUserId ?? '',
  discordChannelId: bot.value?.discordChannelId ?? '',
  discordGuildId: bot.value?.discordGuildId ?? '',
  enabled: bot.value?.enabled ?? true,
}))

const deleteConfirmActions = computed(() => [
  {
    label: '取消',
    color: 'neutral' as const,
    variant: 'outline' as const,
    disabled: deleting.value,
    onClick: closeDeleteConfirm,
  },
  {
    label: deleting.value ? '删除中' : '确认删除',
    color: 'error' as const,
    loading: deleting.value,
    disabled: deleting.value,
    onClick: handleDelete,
  },
])

async function handleSubmit(payload: BotEditorInput) {
  saving.value = true

  try {
    const updated = await $fetch<{ ok: true, data: BotProfile }>(`/api/bots/${botId.value}`, {
      method: 'PUT',
      body: payload,
    })

    data.value = updated
    toast.add({ title: `已保存机器人「${updated.data.name}」`, color: 'success' })
    await refresh()
  }
  catch (error: any) {
    toast.add({
      title: error?.data?.message ?? error?.message ?? '保存机器人失败',
      color: 'error',
    })
  }
  finally {
    saving.value = false
  }
}

function openDeleteConfirm() {
  showDeleteConfirm.value = true
}

function closeDeleteConfirm() {
  if (!deleting.value) {
    showDeleteConfirm.value = false
  }
}

async function handleDelete() {
  if (!bot.value) {
    return
  }

  deleting.value = true

  try {
    const deleted = await $fetch<{ ok: true, data: BotProfile }>(`/api/bots/${botId.value}`, {
      method: 'DELETE',
    })

    toast.add({ title: `已删除机器人「${deleted.data.name}」`, color: 'success' })
    showDeleteConfirm.value = false
    await navigateTo('/bots')
  }
  catch (error: any) {
    toast.add({
      title: error?.data?.message ?? error?.message ?? '删除机器人失败',
      color: 'error',
    })
  }
  finally {
    deleting.value = false
  }
}
</script>
