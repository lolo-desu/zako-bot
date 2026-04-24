import http from 'http'
import { randomUUID } from 'crypto'
import {
  createBot,
  createMcpServer,
  createRole,
  deleteBot,
  deleteMcpServer,
  deleteRole,
  getBotWithRole,
  getMcpServer,
  getRole,
  listBotsWithRoles,
  listMcpServers,
  listRoles,
  updateBot,
  updateMcpServer,
  updateRole,
} from '@zakobot/database'
import type { DB, McpServerRow, RoleRow } from '@zakobot/database'
import type { BotManager } from '../bot/bot-manager.js'
import type { PluginLoader } from '../plugins/loader.js'
import type { McpManager } from '../mcp/index.js'
import type { SkillManager } from '../skills/index.js'
import { getSearchSettings, saveSearchSettings } from '../settings/search-settings.js'
import { getBrowseSettings, saveBrowseSettings } from '../settings/browse-settings.js'
import { getGeneralSettings, saveGeneralSettings } from '../settings/general-settings.js'
import type {
  ApiResponse,
  BotEditorInput,
  BotListItem,
  BotProfile,
  ConversationMessage,
  ConversationTopic,
  CreateConversationTopicInput,
  RoleEditorInput,
  RoleProfile,
  BrowseSettings,
  GeneralSettings,
  McpServerEditorInput,
  McpServerProfile,
  McpServerStatus,
  McpTransport,
  SearchSettings,
  SendConversationMessageInput,
  SendConversationMessageResult,
  SkillContent,
  SkillEditorInput,
  SkillImportInput,
  SkillProfile,
} from '@zakobot/shared'

export class ApiServer {
  private server: http.Server
  private started = false

  constructor(
    private db: DB,
    private botManager: BotManager,
    private pluginLoader: PluginLoader,
    private mcpManager: McpManager,
    private skillManager: SkillManager,
  ) {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res)
    })
  }

  async start() {
    const port = Number(process.env.CORE_API_PORT ?? 6325)
    await this.listenWithRetry(port, '127.0.0.1')
    this.started = true
    console.log(`[ApiServer] Listening on 127.0.0.1:${port}`)
  }

  async stop() {
    if (!this.started) {
      return
    }

    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve()
      })
    })

    this.started = false
    console.log('[ApiServer] Stopped.')
  }

  private async listenWithRetry(port: number, host: string) {
    const attempts = 20
    const retryDelayMs = 250

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.listen(port, host)
        return
      } catch (error) {
        const code = this.getErrorCode(error)
        const shouldRetry = code === 'EADDRINUSE' && attempt < attempts

        if (!shouldRetry && code === 'EADDRINUSE') {
          throw new Error(
            `Core API port ${host}:${port} is already in use. Stop the existing core process or set CORE_API_PORT to another port.`,
            { cause: error },
          )
        }

        if (!shouldRetry) {
          throw error
        }

        await new Promise(resolve => setTimeout(resolve, retryDelayMs))
      }
    }
  }

  private listen(port: number, host: string) {
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.server.off('error', onError)
        this.server.off('listening', onListening)
      }

      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }

      const onListening = () => {
        cleanup()
        resolve()
      }

      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen(port, host)
    })
  }

  private getErrorCode(error: unknown) {
    return typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : undefined
  }

  private json<T>(res: http.ServerResponse, data: ApiResponse<T>, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  private async readJson<T>(req: http.IncomingMessage) {
    const chunks: Buffer[] = []

    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }

    if (!chunks.length) {
      return {} as T
    }

    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
  }

  private toRoleProfile(row: RoleRow): RoleProfile {
    return {
      id: row.id,
      avatar: row.avatar,
      name: row.name,
      systemPrompt: row.systemPrompt,
      enabledTools: this.parseEnabledTools(row.enabledTools),
      enabledSkills: this.parseEnabledSkills(row.enabledSkills),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }
  }

  private toBotProfile(row: NonNullable<ReturnType<typeof getBotWithRole>>): BotProfile {
    return {
      id: row.instance.id,
      name: row.instance.name,
      platform: row.instance.platform,
      token: row.instance.token,
      roleId: row.instance.roleId,
      roleName: row.role.name,
      roleAvatar: row.role.avatar,
      llmProvider: row.instance.llmProvider as 'openai',
      llmPlatformName: row.instance.llmPlatformName,
      llmModel: row.instance.llmModel,
      llmApiKey: row.instance.llmApiKey,
      llmBaseUrl: row.instance.llmBaseUrl,
      discordUserId: row.instance.discordUserId,
      discordGuildId: row.instance.discordGuildId,
      enabled: row.instance.enabled,
      createdAt: row.instance.createdAt.toISOString(),
      updatedAt: row.instance.updatedAt.toISOString(),
    }
  }

  private toBotListItem(row: NonNullable<ReturnType<typeof getBotWithRole>>): BotListItem {
    return {
      id: row.instance.id,
      name: row.instance.name,
      platform: row.instance.platform,
      roleId: row.instance.roleId,
      roleName: row.role.name,
      roleAvatar: row.role.avatar,
      llmPlatformName: row.instance.llmPlatformName,
      llmModel: row.instance.llmModel,
      discordUserId: row.instance.discordUserId,
      discordGuildId: row.instance.discordGuildId,
      enabled: row.instance.enabled,
      createdAt: row.instance.createdAt.toISOString(),
      updatedAt: row.instance.updatedAt.toISOString(),
    }
  }

  private toConversationTopic(row: ReturnType<BotManager['listConversationTopics']>[number]): ConversationTopic {
    return {
      id: row.id,
      botInstanceId: row.botInstanceId,
      platform: row.platform,
      scopeKey: row.scopeKey,
      name: row.name,
      status: row.status,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      metadata: this.parseJsonRecord(row.metadata),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }
  }

  private toConversationMessage(row: ReturnType<BotManager['listConversationMessages']>[number]): ConversationMessage {
    return {
      id: row.id,
      topicId: row.topicId,
      botInstanceId: row.botInstanceId,
      platform: row.platform,
      role: row.role as 'user' | 'assistant',
      content: row.content,
      messageType: row.messageType,
      platformMessageId: row.platformMessageId,
      senderId: row.senderId,
      senderName: row.senderName,
      metadata: this.parseJsonRecord(row.metadata),
      createdAt: row.createdAt.toISOString(),
    }
  }

  private toMcpServerProfile(row: McpServerRow): McpServerProfile {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      transport: row.transport as McpTransport,
      command: row.command,
      args: this.parseJsonStringArray(row.args),
      env: this.parseJsonStringRecord(row.env),
      url: row.url,
      enabled: row.enabled,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }
  }

  private parseRoleInput(body: Partial<RoleEditorInput>) {
    const name = body.name?.trim()
    const systemPrompt = body.systemPrompt?.trim()

    if (!name) {
      throw new Error('Role name is required')
    }

    if (!systemPrompt) {
      throw new Error('Role systemPrompt is required')
    }

    const enabledTools = this.normalizeEnabledTools(body.enabledTools)
    const enabledSkills = this.normalizeEnabledSkills(body.enabledSkills)

    return {
      avatar: body.avatar?.trim() ?? '',
      name,
      systemPrompt,
      enabledTools,
      enabledSkills,
    }
  }

  private parseSkillInput(body: Partial<SkillEditorInput>): SkillEditorInput {
    const content = body.content?.trim()
    const name = body.name?.trim() ?? ''
    const description = body.description?.trim() ?? ''

    if (!content) {
      throw new Error('Skill content is required')
    }

    return {
      name,
      description,
      content,
      enabled: body.enabled === false ? false : true,
      requiredTools: this.normalizeEnabledTools(body.requiredTools),
    }
  }

  private parseSkillImportInput(body: Partial<SkillImportInput>): SkillImportInput {
    const fileName = body.fileName?.trim()
    const contentBase64 = body.contentBase64?.trim()
    const sourceType = body.sourceType === 'md' || body.sourceType === 'zip' ? body.sourceType : undefined

    if (!fileName) {
      throw new Error('Skill file name is required')
    }

    if (!contentBase64) {
      throw new Error('Skill file content is required')
    }

    return { fileName, contentBase64, sourceType }
  }

  private parseBotInput(body: Partial<BotEditorInput>) {
    const name = body.name?.trim()
    const token = body.token?.trim()
    const roleId = body.roleId?.trim()
    const llmPlatformName = body.llmPlatformName?.trim()
    const llmModel = body.llmModel?.trim()
    const llmApiKey = body.llmApiKey?.trim()
    const llmBaseUrl = body.llmBaseUrl?.trim()
    const discordUserId = body.discordUserId?.trim()
    const discordGuildId = body.discordGuildId?.trim()
    const platform = body.platform?.trim()

    if (!name) throw new Error('Bot name is required')
    if (!platform) throw new Error('Bot platform is required')
    if (platform !== 'discord') throw new Error('Only Discord bots are currently supported')
    if (!token) throw new Error('Bot token is required')
    if (!roleId) throw new Error('Role is required')
    if (!llmPlatformName) throw new Error('Model platform is required')
    if (!llmModel) throw new Error('Model is required')
    if (!llmApiKey) throw new Error('Model API key is required')
    if (!llmBaseUrl) throw new Error('Model base URL is required')
    if (!discordGuildId) throw new Error('Discord guild ID is required')

    return {
      name,
      platform: 'discord' as const,
      token,
      roleId,
      llmProvider: 'openai' as const,
      llmPlatformName,
      llmModel,
      llmApiKey,
      llmBaseUrl,
      discordUserId,
      discordGuildId,
      enabled: Boolean(body.enabled),
    }
  }

  private parseCreateConversationTopicInput(body: Partial<CreateConversationTopicInput>) {
    const botInstanceId = body.botInstanceId?.trim()

    if (!botInstanceId) {
      throw new Error('Bot instance ID is required')
    }

    return { botInstanceId }
  }

  private parseSendConversationMessageInput(body: Partial<SendConversationMessageInput>) {
    const botInstanceId = body.botInstanceId?.trim()
    const topicId = body.topicId?.trim()
    const content = body.content?.trim()

    if (!botInstanceId) {
      throw new Error('Bot instance ID is required')
    }

    if (!content) {
      throw new Error('Message content is required')
    }

    return {
      botInstanceId,
      topicId: topicId || undefined,
      content,
    }
  }

  private parseMcpServerInput(body: Partial<McpServerEditorInput>): Omit<McpServerRow, 'id' | 'createdAt' | 'updatedAt'> {
    const name = body.name?.trim()
    const description = body.description?.trim() ?? ''
    const transport = body.transport
    const command = body.command?.trim() ?? ''
    const args = Array.isArray(body.args) ? body.args.filter((item): item is string => typeof item === 'string') : []
    const env = this.normalizeStringRecord(body.env)
    const url = body.url?.trim() ?? ''

    if (!name) {
      throw new Error('MCP server name is required')
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error('MCP server name can only contain letters, numbers, underscores and hyphens')
    }

    if (transport !== 'stdio' && transport !== 'sse') {
      throw new Error('MCP transport must be stdio or sse')
    }

    if (transport === 'stdio' && !command) {
      throw new Error('MCP stdio command is required')
    }

    if (transport === 'sse') {
      if (!url) {
        throw new Error('MCP SSE URL is required')
      }

      try {
        new URL(url)
      }
      catch {
        throw new Error('MCP SSE URL is invalid')
      }
    }

    return {
      name,
      description,
      transport,
      command,
      args: JSON.stringify(args),
      env: JSON.stringify(env),
      url,
      enabled: body.enabled === false ? false : true,
    }
  }

  private parseGeneralSettingsInput(body: Partial<GeneralSettings>): GeneralSettings {
    const rounds = typeof body.maxToolCallRounds === 'number'
      ? body.maxToolCallRounds
      : Number(body.maxToolCallRounds)
    const maxToolCallRounds = Number.isFinite(rounds)
      ? Math.min(Math.max(Math.trunc(rounds), 1), 32)
      : 8
    const toolApprovalMode = body.toolApprovalMode === 'all' || body.toolApprovalMode === 'sensitive' || body.toolApprovalMode === 'none'
      ? body.toolApprovalMode
      : 'all'
    const toolProcessMode = body.toolProcessMode === 'none' || body.toolProcessMode === 'tools_only' || body.toolProcessMode === 'full'
      ? body.toolProcessMode
      : 'full'
    const maxThreadsRaw = typeof body.maxThreadsPerChannel === 'number'
      ? body.maxThreadsPerChannel
      : Number(body.maxThreadsPerChannel)
    const maxThreadsPerChannel = Number.isFinite(maxThreadsRaw) && maxThreadsRaw >= 0
      ? Math.min(Math.trunc(maxThreadsRaw), 100)
      : 0
    return {
      systemPrompt: body.systemPrompt?.trim() ?? '',
      maxToolCallRounds,
      requireMention: body.requireMention === false ? false : true,
      threadMode: body.threadMode === true ? true : false,
      maxThreadsPerChannel,
      sendTime: body.sendTime === true ? true : false,
      timezone: typeof body.timezone === 'string' && body.timezone.trim() ? body.timezone.trim() : 'UTC',
      toolApprovalMode,
      toolProcessMode,
    }
  }

  private parseSearchSettingsInput(body: Partial<SearchSettings>): SearchSettings {
    return {
      provider: body.provider === 'tavily' ? 'tavily' : 'google_web',
      tavilyApiKey: body.tavilyApiKey?.trim() ?? '',
    }
  }

  private parseBrowseSettingsInput(body: Partial<BrowseSettings>): BrowseSettings {
    return {
      provider: body.provider === 'jina' ? 'jina' : 'fetch',
      jinaApiKey: body.jinaApiKey?.trim() ?? '',
      jinaEngine: body.jinaEngine === 'direct' || body.jinaEngine === 'cf-browser-rendering'
        ? body.jinaEngine
        : 'browser',
      jinaRetainImages: this.normalizeJinaRetainImages(body.jinaRetainImages),
      jinaTokenBudgetEnabled: Boolean(body.jinaTokenBudgetEnabled),
      jinaTokenBudget: this.normalizeJinaTokenBudget(body.jinaTokenBudget),
    }
  }

  private parseJsonRecord(value: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>
      return parsed && typeof parsed === 'object' ? parsed : {}
    }
    catch {
      return {}
    }
  }

  private parseJsonStringArray(value: string): string[] {
    try {
      const parsed = JSON.parse(value) as unknown
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string')
        : []
    }
    catch {
      return []
    }
  }

  private parseJsonStringRecord(value: string): Record<string, string> {
    try {
      return this.normalizeStringRecord(JSON.parse(value) as unknown)
    }
    catch {
      return {}
    }
  }

  private normalizeStringRecord(value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {}
    }

    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
  }

  private parseEnabledTools(value: string): string[] {
    try {
      return this.normalizeEnabledTools(JSON.parse(value) as unknown)
    }
    catch {
      return []
    }
  }

  private normalizeEnabledTools(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return []
    }

    const builtinTools = new Set<string>(['web_search', 'web_browse', 'shell_exec', 'file_read', 'file_write', 'file_edit', 'file_list'])
    const result: string[] = []
    const seen = new Set<string>()

    for (const tool of value) {
      if (typeof tool !== 'string' || seen.has(tool)) {
        continue
      }

      seen.add(tool)

      if (builtinTools.has(tool) || /^mcp__[a-zA-Z0-9_-]+__.+$/.test(tool)) {
        result.push(tool)
      }
    }

    return result
  }

  private parseEnabledSkills(value: string): string[] {
    try {
      return this.normalizeEnabledSkills(JSON.parse(value) as unknown)
    }
    catch {
      return []
    }
  }

  private normalizeEnabledSkills(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return []
    }

    const result: string[] = []
    const seen = new Set<string>()

    for (const skillId of value) {
      if (typeof skillId !== 'string') {
        continue
      }

      const normalized = skillId.trim()
      if (!normalized || seen.has(normalized)) {
        continue
      }

      seen.add(normalized)
      result.push(normalized)
    }

    return result
  }

  private listMcpStatus(): McpServerStatus[] {
    const statusById = new Map(this.mcpManager.getStatus().map(status => [status.id, status]))

    return listMcpServers(this.db).map((server) => {
      const status = statusById.get(server.id)
      return {
        id: server.id,
        name: server.name,
        connected: status?.connected ?? false,
        toolCount: status?.toolCount ?? 0,
        toolNames: status?.toolNames ?? [],
        error: status?.error,
      }
    })
  }

  private normalizeJinaRetainImages(value: unknown): BrowseSettings['jinaRetainImages'] {
    return (
      value === 'all'
      || value === 'alt'
      || value === 'all_p'
      || value === 'alt_p'
      || value === 'none'
    )
      ? value
      : 'none'
  }

  private normalizeJinaTokenBudget(value: unknown) {
    const number = typeof value === 'number' ? value : Number(value)

    if (!Number.isFinite(number)) {
      return 200_000
    }

    return Math.min(Math.max(Math.trunc(number), 1_000), 1_000_000)
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const { pathname, searchParams } = url

    if (pathname === '/status' && req.method === 'GET') {
      const { botsOnline, instances } = this.botManager.getStatus()
      return this.json(res, {
        ok: true,
        data: {
          uptime: process.uptime(),
          botsOnline,
          botsTotal: instances.length,
          pluginsLoaded: this.pluginLoader.list().length,
        },
      })
    }

    if (pathname === '/plugins' && req.method === 'GET') {
      return this.json(res, { ok: true, data: this.pluginLoader.list() })
    }

    if (pathname === '/skills' && req.method === 'GET') {
      return this.json<SkillProfile[]>(res, { ok: true, data: this.skillManager.list() })
    }

    if (pathname === '/skills' && req.method === 'POST') {
      try {
        const payload = this.parseSkillInput(await this.readJson<SkillEditorInput>(req))
        return this.json<SkillProfile>(res, { ok: true, data: this.skillManager.create(payload) }, 201)
      }
      catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid request body'
        return this.json(res, { ok: false, error: message }, 400)
      }
    }

    if (pathname === '/skills/import' && req.method === 'POST') {
      try {
        const payload = this.parseSkillImportInput(await this.readJson<SkillImportInput>(req))
        return this.json<SkillProfile>(res, { ok: true, data: this.skillManager.import(payload) }, 201)
      }
      catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid request body'
        return this.json(res, { ok: false, error: message }, 400)
      }
    }

    if (pathname === '/mcp/status' && req.method === 'GET') {
      return this.json(res, { ok: true, data: this.listMcpStatus() })
    }

    if (pathname === '/mcp/servers' && req.method === 'GET') {
      return this.json(res, {
        ok: true,
        data: listMcpServers(this.db).map(row => this.toMcpServerProfile(row)),
      })
    }

    if (pathname === '/mcp/servers' && req.method === 'POST') {
      try {
        const payload = this.parseMcpServerInput(await this.readJson<McpServerEditorInput>(req))
        const created = createMcpServer(this.db, payload)

        if (created.enabled) {
          this.mcpManager.connect(created).catch((error) => {
            console.error(`[ApiServer] Failed to connect MCP server "${created.name}":`, error)
          })
        }

        return this.json(res, { ok: true, data: this.toMcpServerProfile(created) }, 201)
      }
      catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid request body'
        return this.json(res, { ok: false, error: message }, 400)
      }
    }

    if (pathname === '/settings/search' && req.method === 'GET') {
      return this.json(res, { ok: true, data: getSearchSettings(this.db) })
    }

    if (pathname === '/settings/search' && req.method === 'PUT') {
      try {
        const payload = this.parseSearchSettingsInput(await this.readJson<SearchSettings>(req))
        return this.json(res, { ok: true, data: saveSearchSettings(this.db, payload) })
      }
      catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid request body'
        return this.json(res, { ok: false, error: message }, 400)
      }
    }

    if (pathname === '/settings/browse' && req.method === 'GET') {
      return this.json(res, { ok: true, data: getBrowseSettings(this.db) })
    }

    if (pathname === '/settings/browse' && req.method === 'PUT') {
      try {
        const payload = this.parseBrowseSettingsInput(await this.readJson<BrowseSettings>(req))
        return this.json(res, { ok: true, data: saveBrowseSettings(this.db, payload) })
      }
      catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid request body'
        return this.json(res, { ok: false, error: message }, 400)
      }
    }

    if (pathname === '/settings/general' && req.method === 'GET') {
      return this.json(res, { ok: true, data: getGeneralSettings(this.db) })
    }

    if (pathname === '/settings/general' && req.method === 'PUT') {
      try {
        const payload = this.parseGeneralSettingsInput(await this.readJson<GeneralSettings>(req))
        return this.json(res, { ok: true, data: saveGeneralSettings(this.db, payload) })
      }
      catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid request body'
        return this.json(res, { ok: false, error: message }, 400)
      }
    }

    const mcpServerReconnectMatch = pathname.match(/^\/mcp\/servers\/([^/]+)\/reconnect$/)
    if (mcpServerReconnectMatch && req.method === 'POST') {
      const server = getMcpServer(this.db, mcpServerReconnectMatch[1])

      if (!server) {
        return this.json(res, { ok: false, error: 'MCP server not found' }, 404)
      }

      try {
        await this.mcpManager.reconnect(server)
        return this.json(res, { ok: true, data: this.toMcpServerProfile(server) })
      }
      catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to reconnect MCP server'
        return this.json(res, { ok: false, error: message }, 400)
      }
    }

    const mcpServerMatch = pathname.match(/^\/mcp\/servers\/([^/]+)$/)
    if (mcpServerMatch && req.method === 'GET') {
      const server = getMcpServer(this.db, mcpServerMatch[1])

      if (!server) {
        return this.json(res, { ok: false, error: 'MCP server not found' }, 404)
      }

      return this.json(res, { ok: true, data: this.toMcpServerProfile(server) })
    }

    if (mcpServerMatch && req.method === 'PUT') {
      const existing = getMcpServer(this.db, mcpServerMatch[1])

      if (!existing) {
        return this.json(res, { ok: false, error: 'MCP server not found' }, 404)
      }

      try {
        const payload = this.parseMcpServerInput(await this.readJson<McpServerEditorInput>(req))
        const updated = updateMcpServer(this.db, mcpServerMatch[1], payload)

        if (!updated) {
          throw new Error('Failed to update MCP server')
        }

        if (updated.enabled) {
          this.mcpManager.reconnect(updated).catch((error) => {
            console.error(`[ApiServer] Failed to reconnect MCP server "${updated.name}":`, error)
          })
        }
        else {
          await this.mcpManager.disconnect(updated.id)
        }

        return this.json(res, { ok: true, data: this.toMcpServerProfile(updated) })
      }
      catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid request body'
        return this.json(res, { ok: false, error: message }, 400)
      }
    }

    if (mcpServerMatch && req.method === 'DELETE') {
      const existing = getMcpServer(this.db, mcpServerMatch[1])

      if (!existing) {
        return this.json(res, { ok: false, error: 'MCP server not found' }, 404)
      }

      try {
        await this.mcpManager.disconnect(existing.id)
        deleteMcpServer(this.db, existing.id)
        return this.json(res, { ok: true, data: this.toMcpServerProfile(existing) })
      }
      catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to delete MCP server'
        return this.json(res, { ok: false, error: message }, 400)
      }
    }

    if (pathname === '/roles' && req.method === 'GET') {
      return this.json(res, { ok: true, data: listRoles(this.db).map(row => this.toRoleProfile(row)) })
    }

    if (pathname === '/roles' && req.method === 'POST') {
      try {
        const payload = this.parseRoleInput(await this.readJson<RoleEditorInput>(req))
        const now = new Date()
        const created = createRole(this.db, {
          id: randomUUID(),
          avatar: payload.avatar,
          name: payload.name,
          systemPrompt: payload.systemPrompt,
          llmProvider: 'openai',
          llmModel: '',
          llmApiKey: '',
          llmBaseUrl: null,
          enabledTools: JSON.stringify(payload.enabledTools),
          enabledSkills: JSON.stringify(payload.enabledSkills),
          createdAt: now,
          updatedAt: now,
        })

        return this.json(res, { ok: true, data: this.toRoleProfile(created!) }, 201)
      }
      catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid request body'
        return this.json(res, { ok: false, error: message }, 400)
      }
    }

    if (pathname === '/bots' && req.method === 'GET') {
      return this.json(res, {
        ok: true,
        data: listBotsWithRoles(this.db).map(row => this.toBotListItem(row)),
      })
    }

    if (pathname === '/conversations' && req.method === 'GET') {
      const botInstanceId = searchParams.get('botInstanceId')?.trim()

      if (!botInstanceId) {
        return this.json(res, { ok: false, error: 'Bot instance ID is required' }, 400)
      }

      try {
        const topics = this.botManager
          .listConversationTopics(botInstanceId)
          .map(topic => this.toConversationTopic(topic))

        return this.json(res, { ok: true, data: topics })
      }
      catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load conversation topics'
        const status = message.includes('not found') ? 404 : 400
        return this.json(res, { ok: false, error: message }, status)
      }
    }

    if (pathname === '/conversations' && req.method === 'POST') {
      try {
        const payload = this.parseCreateConversationTopicInput(await this.readJson<CreateConversationTopicInput>(req))
        const topic = this.botManager.startPanelConversation(payload.botInstanceId)
        return this.json(res, { ok: true, data: this.toConversationTopic(topic) }, 201)
      }
      catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to create conversation topic'
        const status = message.includes('not found') ? 404 : 400
        return this.json(res, { ok: false, error: message }, status)
      }
    }

    if (pathname === '/conversations/messages' && req.method === 'POST') {
      try {
        const payload = this.parseSendConversationMessageInput(await this.readJson<SendConversationMessageInput>(req))
        const result = await this.botManager.sendPanelMessage(payload.botInstanceId, payload.content, payload.topicId)
        const data: SendConversationMessageResult = {
          topic: this.toConversationTopic(result.topic),
          userMessage: this.toConversationMessage(result.userMessage),
          assistantMessage: this.toConversationMessage(result.assistantMessage),
        }

        return this.json(res, { ok: true, data })
      }
      catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to send conversation message'
        const status = message.includes('not found') ? 404 : 400
        return this.json(res, { ok: false, error: message }, status)
      }
    }

    const conversationMatch = pathname.match(/^\/conversations\/([^/]+)$/)
    if (conversationMatch && req.method === 'DELETE') {
      const botInstanceId = searchParams.get('botInstanceId')?.trim()

      if (!botInstanceId) {
        return this.json(res, { ok: false, error: 'Bot instance ID is required' }, 400)
      }

      try {
        const topic = await this.botManager.deleteConversationTopic(botInstanceId, conversationMatch[1])
        return this.json(res, { ok: true, data: this.toConversationTopic(topic) })
      }
      catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to delete conversation topic'
        const status = message.includes('not found') ? 404 : 400
        return this.json(res, { ok: false, error: message }, status)
      }
    }

    if (pathname === '/bots' && req.method === 'POST') {
      try {
        const payload = this.parseBotInput(await this.readJson<BotEditorInput>(req))

        if (!getRole(this.db, payload.roleId)) {
          return this.json(res, { ok: false, error: 'Role not found' }, 404)
        }

        const now = new Date()
        const created = createBot(this.db, {
          id: randomUUID(),
          name: payload.name,
          platform: payload.platform,
          token: payload.token,
          roleId: payload.roleId,
          llmProvider: payload.llmProvider,
          llmPlatformName: payload.llmPlatformName,
          llmModel: payload.llmModel,
          llmApiKey: payload.llmApiKey,
          llmBaseUrl: payload.llmBaseUrl,
          discordUserId: payload.discordUserId,
          discordGuildId: payload.discordGuildId,
          enabled: payload.enabled,
          createdAt: now,
          updatedAt: now,
        })

        if (!created) {
          throw new Error('Failed to create bot')
        }

        await this.botManager.syncInstance(created.instance.id).catch((error) => {
          console.error(`[ApiServer] Failed to sync bot "${created.instance.name}":`, error)
        })

        return this.json(res, { ok: true, data: this.toBotProfile(created) }, 201)
      }
      catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid request body'
        return this.json(res, { ok: false, error: message }, 400)
      }
    }

    const roleMatch = pathname.match(/^\/roles\/([^/]+)$/)
    if (roleMatch && req.method === 'GET') {
      const role = getRole(this.db, roleMatch[1])

      if (!role) {
        return this.json(res, { ok: false, error: 'Role not found' }, 404)
      }

      return this.json(res, { ok: true, data: this.toRoleProfile(role) })
    }

    if (roleMatch && req.method === 'PUT') {
      const existing = getRole(this.db, roleMatch[1])

      if (!existing) {
        return this.json(res, { ok: false, error: 'Role not found' }, 404)
      }

      try {
        const payload = this.parseRoleInput(await this.readJson<RoleEditorInput>(req))
        const updated = updateRole(this.db, roleMatch[1], {
          avatar: payload.avatar,
          name: payload.name,
          systemPrompt: payload.systemPrompt,
          enabledTools: JSON.stringify(payload.enabledTools),
          enabledSkills: JSON.stringify(payload.enabledSkills),
          updatedAt: new Date(),
        })

        return this.json(res, { ok: true, data: this.toRoleProfile(updated!) })
      }
      catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid request body'
        return this.json(res, { ok: false, error: message }, 400)
      }
    }

    const skillContentMatch = pathname.match(/^\/skills\/([^/]+)\/content$/)
    if (skillContentMatch && req.method === 'GET') {
      try {
        return this.json<SkillContent>(res, { ok: true, data: this.skillManager.getContent(skillContentMatch[1]) })
      }
      catch (error) {
        const message = error instanceof Error ? error.message : 'Skill not found'
        return this.json(res, { ok: false, error: message }, 404)
      }
    }

    const skillMatch = pathname.match(/^\/skills\/([^/]+)$/)
    if (skillMatch && req.method === 'GET') {
      const skill = this.skillManager.get(skillMatch[1])

      if (!skill) {
        return this.json(res, { ok: false, error: 'Skill not found' }, 404)
      }

      return this.json<SkillProfile>(res, { ok: true, data: skill })
    }

    if (skillMatch && req.method === 'PUT') {
      if (!this.skillManager.get(skillMatch[1])) {
        return this.json(res, { ok: false, error: 'Skill not found' }, 404)
      }

      try {
        const payload = this.parseSkillInput(await this.readJson<SkillEditorInput>(req))
        return this.json<SkillProfile>(res, { ok: true, data: this.skillManager.update(skillMatch[1], payload) })
      }
      catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid request body'
        return this.json(res, { ok: false, error: message }, 400)
      }
    }

    if (skillMatch && req.method === 'DELETE') {
      if (!this.skillManager.get(skillMatch[1])) {
        return this.json(res, { ok: false, error: 'Skill not found' }, 404)
      }

      try {
        return this.json<SkillProfile>(res, { ok: true, data: this.skillManager.remove(skillMatch[1]) })
      }
      catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to delete skill'
        return this.json(res, { ok: false, error: message }, 400)
      }
    }

    if (roleMatch && req.method === 'DELETE') {
      const existing = getRole(this.db, roleMatch[1])

      if (!existing) {
        return this.json(res, { ok: false, error: 'Role not found' }, 404)
      }

      try {
        deleteRole(this.db, roleMatch[1])
        return this.json(res, { ok: true, data: this.toRoleProfile(existing) })
      }
      catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to delete role'
        const status = message.includes('FOREIGN KEY constraint failed') ? 409 : 400
        const userMessage = status === 409 ? 'Role is still used by existing bots' : message
        return this.json(res, { ok: false, error: userMessage }, status)
      }
    }

    const botMatch = pathname.match(/^\/bots\/([^/]+)$/)
    if (botMatch && req.method === 'GET') {
      const bot = getBotWithRole(this.db, botMatch[1])

      if (!bot) {
        return this.json(res, { ok: false, error: 'Bot not found' }, 404)
      }

      return this.json(res, { ok: true, data: this.toBotProfile(bot) })
    }

    if (botMatch && req.method === 'PUT') {
      const existing = getBotWithRole(this.db, botMatch[1])

      if (!existing) {
        return this.json(res, { ok: false, error: 'Bot not found' }, 404)
      }

      try {
        const payload = this.parseBotInput(await this.readJson<BotEditorInput>(req))

        if (!getRole(this.db, payload.roleId)) {
          return this.json(res, { ok: false, error: 'Role not found' }, 404)
        }

        const updated = updateBot(this.db, botMatch[1], {
          name: payload.name,
          platform: payload.platform,
          token: payload.token,
          roleId: payload.roleId,
          llmProvider: payload.llmProvider,
          llmPlatformName: payload.llmPlatformName,
          llmModel: payload.llmModel,
          llmApiKey: payload.llmApiKey,
          llmBaseUrl: payload.llmBaseUrl,
          discordUserId: payload.discordUserId,
          discordGuildId: payload.discordGuildId,
          enabled: payload.enabled,
          updatedAt: new Date(),
        })

        if (!updated) {
          throw new Error('Failed to update bot')
        }

        await this.botManager.syncInstance(updated.instance.id).catch((error) => {
          console.error(`[ApiServer] Failed to sync bot "${updated.instance.name}":`, error)
        })

        return this.json(res, { ok: true, data: this.toBotProfile(updated) })
      }
      catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid request body'
        return this.json(res, { ok: false, error: message }, 400)
      }
    }

    if (botMatch && req.method === 'DELETE') {
      const existing = getBotWithRole(this.db, botMatch[1])

      if (!existing) {
        return this.json(res, { ok: false, error: 'Bot not found' }, 404)
      }

      try {
        await this.botManager.stopOne(botMatch[1])
        deleteBot(this.db, botMatch[1])
        return this.json(res, { ok: true, data: this.toBotProfile(existing) })
      }
      catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to delete bot'
        return this.json(res, { ok: false, error: message }, 400)
      }
    }

    const conversationMessagesMatch = pathname.match(/^\/conversations\/([^/]+)\/messages$/)
    if (conversationMessagesMatch && req.method === 'GET') {
      const botInstanceId = searchParams.get('botInstanceId')?.trim()

      if (!botInstanceId) {
        return this.json(res, { ok: false, error: 'Bot instance ID is required' }, 400)
      }

      try {
        const messages = this.botManager
          .listConversationMessages(botInstanceId, conversationMessagesMatch[1])
          .map(message => this.toConversationMessage(message))

        return this.json(res, { ok: true, data: messages })
      }
      catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load conversation messages'
        const status = message.includes('not found') ? 404 : 400
        return this.json(res, { ok: false, error: message }, status)
      }
    }

    return this.json(res, { ok: false, error: 'Not found' }, 404)
  }
}
