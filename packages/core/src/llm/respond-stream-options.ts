import type { ToolApprovalCallback } from '@zakobot/shared'

export type RespondStreamOptions = {
  requestApproval?: ToolApprovalCallback
  abortSignal?: AbortSignal
  onRateLimitRetry?: (attempt: number, delayMs: number) => void | Promise<void>
}
