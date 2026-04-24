import 'dotenv/config'
import { createDb, listEnabledMcpServers } from '@zakobot/database'
import { BotManager } from './bot/bot-manager.js'
import { PluginLoader } from './plugins/loader.js'
import { ApiServer } from './api/server.js'
import { McpManager } from './mcp/index.js'
import { SkillManager } from './skills/index.js'
import { seed } from './seed.js'
import { createDefaultToolRegistry } from './tools/index.js'
import { getSearchSettings } from './settings/search-settings.js'
import { getBrowseSettings } from './settings/browse-settings.js'
import { getGeneralSettings } from './settings/general-settings.js'
import { ensureDirectory, getMcpWorkdir, getSkillsRoot, getZakobotHome, resolveZakobotPath } from './runtime/paths.js'
import { initFileConsoleLogging } from './runtime/logger.js'

const zakobotHome = ensureDirectory(getZakobotHome())
const mcpWorkdir = ensureDirectory(getMcpWorkdir(zakobotHome))
const skillsRoot = ensureDirectory(getSkillsRoot(zakobotHome))
const logsDir = ensureDirectory(resolveZakobotPath(zakobotHome, 'logs'))

initFileConsoleLogging(resolveZakobotPath(logsDir, 'core.log'))

const dbUrl = process.env.DATABASE_URL ?? resolveZakobotPath(zakobotHome, 'data.db')
const db = createDb(dbUrl)

let shuttingDown = false

async function main() {
  seed(db)

  const toolRegistry = createDefaultToolRegistry(
    () => getSearchSettings(db),
    () => getBrowseSettings(db),
  )
  const mcpManager = new McpManager(toolRegistry, { stdioCwd: mcpWorkdir })
  const skillManager = new SkillManager(db, skillsRoot)
  const botManager = new BotManager(db, toolRegistry, skillManager, () => getGeneralSettings(db))
  const pluginLoader = new PluginLoader(botManager, toolRegistry)
  const apiServer = new ApiServer(db, botManager, pluginLoader, mcpManager, skillManager)

  const stopServices = async () => {
    const tasks = [
      apiServer.stop(),
      pluginLoader.unloadAll(),
      botManager.stopAll(),
      mcpManager.disconnectAll(),
    ]

    const results = await Promise.allSettled(tasks)
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('[Core] Shutdown step failed:', result.reason)
      }
    }
  }

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return
    }

    shuttingDown = true
    console.log(`[Core] Received ${signal}, shutting down...`)

    await stopServices()
    process.exit(0)
  }

  process.once('SIGINT', () => {
    void shutdown('SIGINT')
  })

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM')
  })

  try {
    await apiServer.start()
    await pluginLoader.loadAll()
    await mcpManager.connectAll(listEnabledMcpServers(db))
    await botManager.startAll()
  } catch (error) {
    await stopServices()
    throw error
  }
}

main().catch((error) => {
  console.error('[Core] Fatal error:', error)
  process.exit(1)
})
