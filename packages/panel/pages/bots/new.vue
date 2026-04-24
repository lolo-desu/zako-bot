<template>
  <div class="space-y-4">
    <UAlert
      v-if="rolesError"
      color="error"
      variant="subtle"
      icon="i-heroicons-x-circle-20-solid"
      title="角色加载失败"
      :description="rolesError.message"
    />

    <BotEditorForm
      title="新建机器人"
      description="录入机器人连接信息、绑定角色并选择模型。"
      submit-label="创建机器人"
      :initial-value="form"
      :role-options="roleOptions"
      :pending="pending"
      @submit="handleSubmit"
    />
  </div>
</template>

<script setup lang="ts">
import type { BotEditorInput, BotProfile, RoleProfile } from '@zakobot/shared'

const toast = useToast()

const { data: rolesData, error: rolesError } = await useFetch<{ ok: true, data: RoleProfile[] }>('/api/roles')

const pending = ref(false)
const form: BotEditorInput = {
  name: '',
  platform: 'discord',
  token: '',
  roleId: '',
  llmProvider: 'openai',
  llmPlatformName: '',
  llmModel: '',
  llmApiKey: '',
  llmBaseUrl: '',
  discordUserId: '',
  discordChannelId: '',
  discordGuildId: '',
  enabled: true,
}

const roleOptions = computed(() =>
  (rolesData.value?.data ?? []).map(role => ({
    label: role.name,
    value: role.id,
  })),
)

async function handleSubmit(payload: BotEditorInput) {
  pending.value = true

  try {
    const created = await $fetch<{ ok: true, data: BotProfile }>('/api/bots', {
      method: 'POST',
      body: payload,
    })

    toast.add({ title: `已创建机器人「${created.data.name}」`, color: 'success' })
    await navigateTo(`/bots/${created.data.id}`)
  }
  catch (error: any) {
    toast.add({
      title: error?.data?.message ?? error?.message ?? '创建机器人失败',
      color: 'error',
    })
  }
  finally {
    pending.value = false
  }
}
</script>
