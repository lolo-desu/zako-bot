import { getAppSetting, setAppSetting } from '@zakobot/database'
import type { DB } from '@zakobot/database'
import type { GeneralSettings, ToolApprovalMode, ToolProcessMode } from '@zakobot/shared'

const GENERAL_SETTINGS_KEY = 'general'
const DEFAULT_MAX_TOOL_CALL_ROUNDS = 32

export function getGeneralSettings(db: DB): GeneralSettings {
  const row = getAppSetting(db, GENERAL_SETTINGS_KEY)

  if (!row) {
    return normalizeGeneralSettings({
      maxToolCallRounds: process.env.MAX_TOOL_CALL_ROUNDS,
      requireMention: process.env.REQUIRE_MENTION,
    })
  }

  try {
    return normalizeGeneralSettings(JSON.parse(row.value) as Record<string, unknown>)
  }
  catch {
    return normalizeGeneralSettings({})
  }
}

export function saveGeneralSettings(db: DB, value: Partial<GeneralSettings>): GeneralSettings {
  const settings = normalizeGeneralSettings(value as Record<string, unknown>)
  setAppSetting(db, GENERAL_SETTINGS_KEY, JSON.stringify(settings))
  return settings
}

function normalizeGeneralSettings(value: Record<string, unknown>): GeneralSettings {
  return {
    systemPrompt: typeof value.systemPrompt === 'string' ? value.systemPrompt.trim() : '',
    maxToolCallRounds: normalizeMaxToolCallRounds(value.maxToolCallRounds),
    requireMention: value.requireMention === false || value.requireMention === 'false' ? false : true,
    threadMode: value.threadMode === true || value.threadMode === 'true' ? true : false,
    maxThreadsPerChannel: normalizeMaxThreadsPerChannel(value.maxThreadsPerChannel),
    sendTime: value.sendTime === true || value.sendTime === 'true' ? true : false,
    timezone: typeof value.timezone === 'string' && value.timezone.trim() ? value.timezone.trim() : 'UTC',
    toolApprovalMode: normalizeToolApprovalMode(value.toolApprovalMode),
    toolProcessMode: normalizeToolProcessMode(value.toolProcessMode),
  }
}

function normalizeToolApprovalMode(value: unknown): ToolApprovalMode {
  if (value === 'all' || value === 'sensitive' || value === 'none') return value
  return 'all'
}

function normalizeToolProcessMode(value: unknown): ToolProcessMode {
  if (value === 'none' || value === 'tools_only' || value === 'full') return value
  return 'full'
}

function normalizeMaxThreadsPerChannel(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num) || num < 0) return 0
  return Math.min(Math.trunc(num), 100)
}

function normalizeMaxToolCallRounds(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return DEFAULT_MAX_TOOL_CALL_ROUNDS
  return Math.min(Math.max(Math.trunc(num), 1), 32)
}
