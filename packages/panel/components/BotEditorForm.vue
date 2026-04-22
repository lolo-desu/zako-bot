<template>
  <UCard variant="subtle">
    <template #header>
      <div class="flex flex-col gap-1">
        <h1 class="m-0 text-2xl font-bold text-[var(--text-primary)]">
          {{ title }}
        </h1>
        <p v-if="description" class="m-0 text-sm text-[var(--text-secondary)]">
          {{ description }}
        </p>
      </div>
    </template>

    <form class="flex max-w-3xl flex-col gap-6" @submit.prevent="handleSubmit">
      <div class="grid gap-4 md:grid-cols-2">
        <UFormField label="名称" name="name" required>
          <UInput
            v-model="state.name"
            class="w-full"
            :disabled="pending"
            placeholder="如：客服机器人、公告助手"
          />
        </UFormField>

        <UFormField label="频道" name="platform" required>
          <USelect
            v-model="state.platform"
            class="w-full"
            :disabled="pending"
            :items="platformOptions"
          />
        </UFormField>
      </div>

      <div class="grid gap-4 md:grid-cols-2">
        <UFormField label="角色" name="roleId" required>
          <USelect
            v-model="state.roleId"
            class="w-full"
            :disabled="pending || roleOptions.length === 0"
            :items="roleOptions"
            placeholder="选择角色"
          />
        </UFormField>

        <UFormField label="模型" name="model" required>
          <USelect
            v-model="selectedModelValue"
            class="w-full"
            :disabled="pending || modelSelectOptions.length === 0"
            :items="modelSelectOptions"
            placeholder="选择模型"
          />
        </UFormField>
      </div>

      <UAlert
        v-if="!roleOptions.length"
        color="warning"
        variant="subtle"
        icon="i-heroicons-exclamation-triangle-20-solid"
        title="还没有可用角色"
        description="请先创建角色，再回来绑定机器人。"
      />

      <UAlert
        v-if="showModelAlert"
        color="warning"
        variant="subtle"
        icon="i-heroicons-exclamation-triangle-20-solid"
        title="还没有可用模型"
        description="先到模型设置页保存平台配置并拉取模型列表。"
      >
        <template #actions>
          <UButton
            label="前往模型设置"
            color="warning"
            variant="outline"
            type="button"
            to="/settings/models"
          />
        </template>
      </UAlert>

      <div class="grid gap-4 md:grid-cols-2">
        <UFormField label="Bot Token" name="token" required>
          <UInput
            v-model="state.token"
            class="w-full"
            :type="showToken ? 'text' : 'password'"
            :disabled="pending"
            placeholder="输入 Discord Bot Token"
          >
            <template #trailing>
              <UButton
                :icon="showToken ? 'i-heroicons-eye-slash-20-solid' : 'i-heroicons-eye-20-solid'"
                size="xs"
                variant="ghost"
                color="neutral"
                class="mr-1"
                type="button"
                :aria-label="showToken ? '隐藏 Bot Token' : '显示 Bot Token'"
                @click="showToken = !showToken"
              />
            </template>
          </UInput>
        </UFormField>

        <UFormField label="启用" name="enabled">
          <div class="flex h-10 items-center">
            <USwitch v-model="state.enabled" :disabled="pending" />
          </div>
        </UFormField>
      </div>

      <div class="grid gap-4 md:grid-cols-2">
        <UFormField label="用户 ID（可选）" name="discordUserId">
          <UInput
            v-model="state.discordUserId"
            class="w-full"
            :disabled="pending"
            placeholder="留空则允许服务器内任意用户对话"
          />
        </UFormField>

        <UFormField label="服务器 ID" name="discordGuildId" required>
          <UInput
            v-model="state.discordGuildId"
            class="w-full"
            :disabled="pending"
            placeholder="输入允许对话的 Discord 服务器 ID"
          />
        </UFormField>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-2">
        <div v-if="$slots['actions-left']" class="flex flex-wrap gap-2">
          <slot name="actions-left" />
        </div>

        <div class="ml-auto flex flex-wrap justify-end gap-2">
          <UButton
            label="返回列表"
            color="neutral"
            variant="outline"
            to="/bots"
          />
          <UButton
            :label="submitLabel"
            type="submit"
            :loading="pending"
            :disabled="!canSubmit"
          />
        </div>
      </div>
    </form>
  </UCard>
</template>

<script setup lang="ts">
import type { BotEditorInput } from '@zakobot/shared'
import { useModelPlatforms } from '~/composables/modelPlatforms'

type SelectOption = {
  label: string
  value: string
}

type ModelOption = SelectOption & {
  apiKey: string
  baseUrl: string
  model: string
  platformName: string
}

const props = defineProps<{
  title: string
  description?: string
  submitLabel: string
  initialValue: BotEditorInput
  roleOptions: SelectOption[]
  pending?: boolean
}>()

const emit = defineEmits<{
  submit: [value: BotEditorInput]
}>()

const { platforms } = useModelPlatforms()
const platformsReady = ref(false)

const state = reactive<BotEditorInput>({
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
  discordGuildId: '',
  enabled: true,
})

const showToken = ref(false)
const selectedModelValue = ref('')

const platformOptions: SelectOption[] = [
  { label: 'Discord', value: 'discord' },
]

const roleOptions = computed(() => props.roleOptions)

const modelOptions = computed<ModelOption[]>(() =>
  platforms.value
    .filter(p => p.enabled)
    .flatMap(platform =>
      platform.enabledModels.map(model => ({
        label: `${platform.name}-${model}`,
        value: `${platform.id}::${model}`,
        apiKey: platform.apiKey,
        baseUrl: platform.baseUrl,
        model,
        platformName: platform.name,
      })),
    ),
)

const modelSelectOptions = computed<SelectOption[]>(() => {
  const options: SelectOption[] = modelOptions.value.map(({ label, value }) => ({ label, value }))

  if (!state.llmPlatformName || !state.llmModel) {
    return options
  }

  const fallbackValue = getFallbackModelValue(state.llmPlatformName, state.llmModel)
  const hasCurrent = options.some(option =>
    option.label === `${state.llmPlatformName}-${state.llmModel}` || option.value === fallbackValue,
  )

  if (hasCurrent) {
    return options
  }

  return [
    { label: `${state.llmPlatformName}-${state.llmModel}`, value: fallbackValue },
    ...options,
  ]
})

const showModelAlert = computed(() => platformsReady.value && modelOptions.value.length === 0)

onMounted(() => {
  platformsReady.value = true
})

watch(
  () => props.initialValue,
  (value) => {
    state.name = value.name
    state.platform = value.platform
    state.token = value.token
    state.roleId = value.roleId
    state.llmProvider = value.llmProvider
    state.llmPlatformName = value.llmPlatformName
    state.llmModel = value.llmModel
    state.llmApiKey = value.llmApiKey
    state.llmBaseUrl = value.llmBaseUrl
    state.discordUserId = value.discordUserId
    state.discordGuildId = value.discordGuildId
    state.enabled = value.enabled
    selectedModelValue.value = resolveModelValue(value.llmPlatformName, value.llmModel)
  },
  { immediate: true, deep: true },
)

watch(modelOptions, () => {
  if (!state.llmPlatformName || !state.llmModel) {
    return
  }

  selectedModelValue.value = resolveModelValue(state.llmPlatformName, state.llmModel)
}, { immediate: true })

watch(selectedModelValue, (value) => {
  const selected = modelOptions.value.find(option => option.value === value)

  if (!selected) {
    return
  }

  state.llmProvider = 'openai'
  state.llmPlatformName = selected.platformName
  state.llmModel = selected.model
  state.llmApiKey = selected.apiKey.trim()
  state.llmBaseUrl = selected.baseUrl.trim()
})

const canSubmit = computed(() =>
  state.name.trim().length > 0
  && state.platform === 'discord'
  && state.token.trim().length > 0
  && state.roleId.trim().length > 0
  && state.llmPlatformName.trim().length > 0
  && state.llmModel.trim().length > 0
  && state.llmApiKey.trim().length > 0
  && state.llmBaseUrl.trim().length > 0
   && state.discordGuildId.trim().length > 0,
)

function handleSubmit() {
  if (!canSubmit.value) {
    return
  }

  emit('submit', {
    name: state.name.trim(),
    platform: 'discord',
    token: state.token.trim(),
    roleId: state.roleId.trim(),
    llmProvider: 'openai',
    llmPlatformName: state.llmPlatformName.trim(),
    llmModel: state.llmModel.trim(),
    llmApiKey: state.llmApiKey.trim(),
    llmBaseUrl: state.llmBaseUrl.trim(),
    discordUserId: state.discordUserId.trim(),
    discordGuildId: state.discordGuildId.trim(),
    enabled: state.enabled,
  })
}

function resolveModelValue(platformName: string, model: string) {
  const matched = modelOptions.value.find(option =>
    option.platformName === platformName && option.model === model,
  )

  return matched?.value ?? getFallbackModelValue(platformName, model)
}

function getFallbackModelValue(platformName: string, model: string) {
  return `saved::${platformName}::${model}`
}
</script>
