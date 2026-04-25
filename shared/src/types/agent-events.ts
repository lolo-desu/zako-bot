export type AgentEvent =
  | { type: 'text_chunk'; content: string }
  | { type: 'tool_call'; callId: string; name: string; input: unknown }
  | { type: 'tool_result'; callId: string; name: string; result: string; ok: boolean }
  | { type: 'tool_limit_reached'; limit: number }
  | { type: 'done'; content: string }

export type ToolApprovalDecision = {
  approved: boolean
  always?: boolean
  reason?: string
  guidance?: string
}

export type ToolApprovalCallback = (callId: string, name: string, input: unknown) => Promise<ToolApprovalDecision>
