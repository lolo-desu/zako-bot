import type { LLMTool } from '@zakobot/shared'

export function buildToolPrompt(tools: LLMTool[]) {
  if (!tools.length) {
    return ''
  }

  const mcpNote = tools.some(tool => tool.name.startsWith('mcp__'))
    ? ['名称以 mcp__ 开头的是 MCP 服务器暴露的工具。', '']
    : []

  return [
    '以下工具已为当前角色启用。它们会通过模型工具调用接口发送；请根据用户需求主动判断是否调用工具，并严格遵守每个工具的使用说明。',
    '',
    ...mcpNote,
    tools.map(tool => formatToolPromptSection(tool)).join('\n\n'),
  ].join('\n')
}

function formatToolPromptSection(tool: LLMTool) {
  const lines = [`工具：${tool.name}`]
  const description = tool.description.trim()
  const parameterSummary = formatParameterSummary(tool.parameters)
  const instructions = tool.instructions?.trim()

  if (description) {
    lines.push(`说明：${description}`)
  }

  if (parameterSummary) {
    lines.push(`参数：${parameterSummary}`)
  }

  if (instructions) {
    lines.push(`使用说明：${instructions}`)
  }

  return lines.join('\n')
}

function formatParameterSummary(parameters: Record<string, unknown>) {
  const properties = getRecord(parameters.properties)
  const required = new Set(
    Array.isArray(parameters.required)
      ? parameters.required.filter((name): name is string => typeof name === 'string')
      : [],
  )

  if (!properties || !Object.keys(properties).length) {
    return ''
  }

  return Object.entries(properties)
    .map(([name, schema]) => {
      const record = getRecord(schema)
      const type = typeof record?.type === 'string' ? record.type : 'unknown'
      const description = typeof record?.description === 'string' && record.description.trim()
        ? ` - ${record.description.trim()}`
        : ''
      const marker = required.has(name) ? '必填' : '可选'

      return `${name}(${type}, ${marker})${description}`
    })
    .join('；')
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
