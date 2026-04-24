import { ApplicationCommandOptionType } from 'discord.js'

const MAX_DISCORD_MESSAGE_CHARS = 1900

export const MODEL_COMMAND = {
  name: 'model',
  description: '查看或切换当前模型',
  options: [
    {
      name: 'index',
      description: '模型编号；留空则列出可用模型',
      type: ApplicationCommandOptionType.Integer,
      required: false,
    },
  ],
} as const

type ModelCommandDeps = {
  getCurrentModel: () => string
  listAvailableModels: () => Promise<string[]>
  setModel: (modelId: string) => Promise<string>
}

export class DiscordModelCommand {
  constructor(private deps: ModelCommandDeps) {}

  parseTextCommand(text: string) {
    const trimmed = text.trim()
    if (!trimmed.startsWith('/model')) {
      return null
    }

    const [command, ...rest] = trimmed.split(/\s+/)
    if (command !== '/model') {
      return null
    }

    const rawIndex = rest.join(' ').trim()
    if (!rawIndex) return { index: undefined }

    const index = Number.parseInt(rawIndex, 10)
    if (!Number.isInteger(index) || index <= 0) {
      throw new Error('模型编号必须是大于 0 的整数。先运行 /model 查看编号。')
    }

    return { index }
  }

  async buildListReply() {
    const models = await this.deps.listAvailableModels()
    const currentModel = this.deps.getCurrentModel()
    const header = [
      `当前模型：\`${currentModel}\``,
      '可用模型列表：',
    ]
    const lines = models.length > 0
      ? models.map((model, index) => `${index + 1}. \`${model}\`${model === currentModel ? ' (当前)' : ''}`)
      : ['- 未拉取到任何模型']

    return this.chunkReplyLines([
      ...header,
      ...lines,
      '使用 `/model <编号>` 切换默认模型。',
    ])
  }

  async switchByIndexReply(index: number) {
    if (!Number.isInteger(index) || index <= 0) {
      throw new Error('模型编号必须是大于 0 的整数。')
    }

    const models = await this.deps.listAvailableModels()
    const nextModel = models[index - 1]
    if (!nextModel) {
      throw new Error(`模型编号 ${index} 不存在。先运行 /model 查看可用模型。`)
    }

    const appliedModel = await this.deps.setModel(nextModel)
    return `已将默认模型永久切换为第 ${index} 个：\`${appliedModel}\`。后续请求会使用该模型。`
  }

  private chunkReplyLines(lines: string[]) {
    const chunks: string[] = []
    let current = ''

    for (const line of lines) {
      const next = current ? `${current}\n${line}` : line
      if (next.length > MAX_DISCORD_MESSAGE_CHARS && current) {
        chunks.push(current)
        current = line
        continue
      }
      current = next.slice(0, MAX_DISCORD_MESSAGE_CHARS)
    }

    if (current) {
      chunks.push(current)
    }

    return chunks.length > 0 ? chunks : ['（空）']
  }
}
