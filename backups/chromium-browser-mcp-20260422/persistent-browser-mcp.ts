import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const MAX_TEXT_CHARS = 12000
const DEFAULT_TIMEOUT_MS = 15000
const DEFAULT_START_TIMEOUT_MS = 45000
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_LAUNCH_COMMAND = '/root/zako-bot/scripts/launch-browser-stack.sh'

type BrowserMode = 'headless' | 'headed'

const openInput = {
  url: z.string().url().describe('HTTP or HTTPS URL to open in the persistent browser.'),
  waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional().describe('Navigation wait state.'),
}

const manualLoginInput = {
  url: z.string().url().optional().describe('Optional target URL to open before the user takes over manual login.'),
  waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional().describe('Optional navigation wait state when opening the target URL.'),
}

const readInput = {
  url: z.string().url().optional().describe('Optional URL to navigate to before reading.'),
  maxChars: z.number().int().min(500).max(MAX_TEXT_CHARS).optional().describe('Maximum text length to return.'),
}

const clickInput = {
  selector: z.string().min(1).describe('Playwright selector for the element to click.'),
}

const typeInput = {
  selector: z.string().min(1).describe('Playwright selector for the input element.'),
  text: z.string().describe('Text to type into the matched element.'),
  pressEnter: z.boolean().optional().describe('Press Enter after typing.'),
}

interface BrowserProfileConfig {
  id: string
  label: string
  instanceName: string
  cdpUrl: string
  noVncUrl: string
  vncPassword: string
  launchCommand: string
  launchArgs: string[]
  startTimeoutMs: number
  idleTimeoutMs: number
  manualLoginMessage?: string
}

interface BrowserHubConfig {
  profiles: BrowserProfileConfig[]
}

interface ProfileRuntime {
  child?: ChildProcess
  startPromise?: Promise<void>
  idleTimer?: NodeJS.Timeout
  mode?: BrowserMode
}

class BrowserHub {
  private browsers = new Map<string, Browser>()
  private runtimes = new Map<string, ProfileRuntime>()

  constructor(private profiles: BrowserProfileConfig[]) {}

  profile(id: string) {
    const profile = this.profiles.find(item => item.id === id)
    if (!profile) {
      throw new Error(`Browser profile "${id}" is not configured`)
    }

    return profile
  }

  async start(profileId: string) {
    const profile = this.profile(profileId)
    await this.ensureStarted(profile, 'headless')
    return this.describeStatus(profile, true)
  }

  async stop(profileId: string) {
    const profile = this.profile(profileId)
    await this.stopProfile(profile)
    return this.describeStatus(profile, false)
  }

  async open(profileId: string, url: string, waitUntil: 'load' | 'domcontentloaded' | 'networkidle' = 'domcontentloaded') {
    const profile = this.profile(profileId)
    const page = await this.page(profile, 'headless')
    await page.goto(url, { waitUntil, timeout: DEFAULT_TIMEOUT_MS })
    return this.describePage(profile, page)
  }

  async read(profileId: string, input: { url?: string; maxChars?: number }) {
    const profile = this.profile(profileId)
    const page = await this.page(profile, 'headless')

    if (input.url) {
      await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS })
    }

    await page.waitForLoadState('domcontentloaded', { timeout: DEFAULT_TIMEOUT_MS }).catch(() => undefined)
    const bodyText = await page.evaluate(() => document.body?.innerText ?? '')
    const trimmed = bodyText.trim()
    const text = trimmed.slice(0, input.maxChars ?? 6000)

    return {
      ...(await this.describePage(profile, page)),
      text,
      truncated: trimmed.length > text.length,
    }
  }

  async click(profileId: string, selector: string) {
    const profile = this.profile(profileId)
    const page = await this.page(profile, 'headless')
    await page.locator(selector).first().click({ timeout: DEFAULT_TIMEOUT_MS })
    return this.describePage(profile, page)
  }

  async type(profileId: string, selector: string, text: string, pressEnter = false) {
    const profile = this.profile(profileId)
    const page = await this.page(profile, 'headless')
    const locator = page.locator(selector).first()
    await locator.fill(text, { timeout: DEFAULT_TIMEOUT_MS })

    if (pressEnter) {
      await locator.press('Enter', { timeout: DEFAULT_TIMEOUT_MS })
    }

    return this.describePage(profile, page)
  }

  async status(profileId: string) {
    const profile = this.profile(profileId)
    return this.describeStatus(profile, false)
  }

  async manualLogin(
    profileId: string,
    input: { url?: string; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' } = {},
  ) {
    const profile = this.profile(profileId)
    const page = await this.page(profile, 'headed')

    if (input.url) {
      await page.goto(input.url, { waitUntil: input.waitUntil ?? 'domcontentloaded', timeout: DEFAULT_TIMEOUT_MS })
    }

    return {
      ...(await this.describePage(profile, page)),
      message: profile.manualLoginMessage ?? 'Start the browser if needed, send the user the returned noVNC URL and vncPassword, let the user finish the login or verification in the persistent browser profile, then wait for the user to say the manual step is done.',
    }
  }

  async shutdown() {
    await Promise.allSettled(this.profiles.map(profile => this.stopProfile(profile)))
  }

  private runtime(profileId: string) {
    const existing = this.runtimes.get(profileId)
    if (existing) {
      return existing
    }

    const created: ProfileRuntime = {}
    this.runtimes.set(profileId, created)
    return created
  }

  private async page(profile: BrowserProfileConfig, mode: BrowserMode) {
    await this.ensureStarted(profile, mode)
    const browser = await this.browser(profile, true, mode)
    const context = this.defaultContext(browser)
    let page = context.pages().find((candidate: Page) => !candidate.url().startsWith('devtools://'))

    if (!page) {
      page = await context.newPage()
      await page.goto('about:blank', { waitUntil: 'load', timeout: DEFAULT_TIMEOUT_MS }).catch(() => undefined)
    }

    await page.bringToFront().catch(() => undefined)
    this.touch(profile.id)
    return page
  }

  private async browser(profile: BrowserProfileConfig, keepAlive = true, mode: BrowserMode = 'headless') {
    const existing = this.browsers.get(profile.id)
    if (existing?.isConnected()) {
      if (keepAlive) {
        this.touch(profile.id)
      }
      return existing
    }

    await this.ensureStarted(profile, mode, keepAlive)
    const browser = await chromium.connectOverCDP(profile.cdpUrl)
    browser.on('disconnected', () => {
      this.browsers.delete(profile.id)
    })
    this.browsers.set(profile.id, browser)
    if (keepAlive) {
      this.touch(profile.id)
    }
    return browser
  }

  private defaultContext(browser: Browser): BrowserContext {
    const context = browser.contexts()[0]
    if (!context) {
      throw new Error('Persistent browser did not expose a default context')
    }

    return context
  }

  private async describePage(profile: BrowserProfileConfig, page: Page) {
    return {
      ...(await this.describeStatus(profile, true)),
      url: page.url(),
      title: await page.title(),
    }
  }

  private async describeStatus(profile: BrowserProfileConfig, keepAlive: boolean) {
    const runtime = this.runtime(profile.id)
    const running = await this.isRunning(profile)
    if (!running) {
      return {
        profileId: profile.id,
        label: profile.label,
        running: false,
        noVncUrl: profile.noVncUrl,
        vncPassword: profile.vncPassword,
        idleTimeoutMs: profile.idleTimeoutMs,
        mode: runtime.mode ?? 'headless',
        message: 'Browser is stopped. Use the start tool before browser work, or use manual_login to start it for a human login flow.',
      }
    }

    if (keepAlive) {
      this.touch(profile.id)
    }

    const pageInfo = await this.peekPage(profile)
    return {
      profileId: profile.id,
      label: profile.label,
      running: true,
      mode: runtime.mode ?? 'headless',
      noVncUrl: profile.noVncUrl,
      vncPassword: profile.vncPassword,
      idleTimeoutMs: profile.idleTimeoutMs,
      url: pageInfo?.url ?? '',
      title: pageInfo?.title ?? '',
    }
  }

  private async peekPage(profile: BrowserProfileConfig) {
    try {
      const browser = await this.browser(profile, false, this.runtime(profile.id).mode ?? 'headless')
      const context = this.defaultContext(browser)
      const page = context.pages().find((candidate: Page) => !candidate.url().startsWith('devtools://'))

      if (!page) {
        return null
      }

      return {
        url: page.url(),
        title: await page.title(),
      }
    }
    catch {
      return null
    }
  }

  private async ensureStarted(profile: BrowserProfileConfig, mode: BrowserMode, keepAlive = true) {
    const runtime = this.runtime(profile.id)

    if (await this.isRunning(profile)) {
      if (runtime.mode && runtime.mode !== mode) {
        await this.stopProfile(profile)
      }
      else {
        if (keepAlive) {
          this.touch(profile.id)
        }
        return
      }
    }

    if (!runtime.startPromise) {
      runtime.mode = mode
      runtime.startPromise = this.spawnProfile(profile, mode)
        .catch((error) => {
          runtime.mode = undefined
          throw error
        })
        .finally(() => {
          runtime.startPromise = undefined
        })
    }

    await runtime.startPromise
    if (keepAlive) {
      this.touch(profile.id)
    }
  }

  private async spawnProfile(profile: BrowserProfileConfig, mode: BrowserMode) {
    const runtime = this.runtime(profile.id)
    const child = spawn(profile.launchCommand, [...profile.launchArgs, mode], {
      stdio: 'ignore',
    })

    runtime.child = child
    child.once('exit', () => {
      if (runtime.child === child) {
        runtime.child = undefined
        runtime.mode = undefined
      }
      void this.disconnectBrowser(profile.id)
      this.clearIdleTimer(profile.id)
    })

    try {
      await this.waitForRunning(profile)
    }
    catch (error) {
      this.killChild(runtime.child)
      runtime.child = undefined
      runtime.mode = undefined
      throw error
    }
  }

  private async waitForRunning(profile: BrowserProfileConfig) {
    const startedAt = Date.now()

    while (Date.now() - startedAt < profile.startTimeoutMs) {
      if (await this.isRunning(profile)) {
        return
      }

      await delay(500)
    }

    throw new Error(`Timed out starting browser profile "${profile.id}"`)
  }

  private async isRunning(profile: BrowserProfileConfig) {
    const versionUrl = new URL('/json/version', profile.cdpUrl)

    try {
      const response = await fetch(versionUrl, {
        signal: AbortSignal.timeout(1500),
      })

      return response.ok
    }
    catch {
      return false
    }
  }

  private async stopProfile(profile: BrowserProfileConfig) {
    this.clearIdleTimer(profile.id)
    await this.disconnectBrowser(profile.id)

    const runtime = this.runtime(profile.id)
    const child = runtime.child
    runtime.child = undefined
    runtime.mode = undefined

    if (child) {
      await this.terminateChild(child)
    }
  }

  private async disconnectBrowser(profileId: string) {
    const browser = this.browsers.get(profileId)
    this.browsers.delete(profileId)

    if (browser) {
      await browser.close().catch(() => undefined)
    }
  }

  private touch(profileId: string) {
    const profile = this.profile(profileId)
    if (profile.idleTimeoutMs <= 0) {
      return
    }

    const runtime = this.runtime(profileId)
    this.clearIdleTimer(profileId)
    runtime.idleTimer = setTimeout(() => {
      void this.stopProfile(profile).catch((error) => {
        console.error(`[persistent-browser-mcp] Failed to stop idle profile "${profile.id}":`, error)
      })
    }, profile.idleTimeoutMs)
  }

  private clearIdleTimer(profileId: string) {
    const runtime = this.runtime(profileId)
    if (runtime.idleTimer) {
      clearTimeout(runtime.idleTimer)
      runtime.idleTimer = undefined
    }
  }

  private async terminateChild(child: ChildProcess) {
    this.killChild(child)

    const exited = await Promise.race([
      new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
      delay(5000).then(() => false),
    ])

    if (!exited && child.exitCode === null) {
      child.kill('SIGKILL')
      await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    }
  }

  private killChild(child?: ChildProcess) {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM')
    }
  }
}

function loadConfig(configPath: string): BrowserHubConfig {
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<BrowserHubConfig>
  if (!Array.isArray(raw.profiles) || raw.profiles.length === 0) {
    throw new Error(`No browser profiles found in ${configPath}`)
  }

  return {
    profiles: raw.profiles.map((profile) => {
      if (!profile || typeof profile !== 'object') {
        throw new Error(`Invalid browser profile in ${configPath}`)
      }

      const item = profile as Partial<BrowserProfileConfig>
      if (!item.id || !item.label || !item.instanceName || !item.cdpUrl || !item.noVncUrl || !item.vncPassword) {
        throw new Error(`Browser profile is missing required fields in ${configPath}`)
      }

      return {
        id: item.id,
        label: item.label,
        instanceName: item.instanceName,
        cdpUrl: item.cdpUrl,
        noVncUrl: item.noVncUrl,
        vncPassword: item.vncPassword,
        launchCommand: item.launchCommand ?? DEFAULT_LAUNCH_COMMAND,
        launchArgs: Array.isArray(item.launchArgs) && item.launchArgs.every(arg => typeof arg === 'string')
          ? item.launchArgs
          : [item.instanceName],
        startTimeoutMs: typeof item.startTimeoutMs === 'number' && Number.isFinite(item.startTimeoutMs)
          ? Math.max(Math.trunc(item.startTimeoutMs), 5000)
          : DEFAULT_START_TIMEOUT_MS,
        idleTimeoutMs: typeof item.idleTimeoutMs === 'number' && Number.isFinite(item.idleTimeoutMs)
          ? Math.max(Math.trunc(item.idleTimeoutMs), 0)
          : DEFAULT_IDLE_TIMEOUT_MS,
        manualLoginMessage: item.manualLoginMessage,
      }
    }),
  }
}

function textResult(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ],
  }
}

async function main() {
  const configPath = process.argv[2] ?? process.env.ZAKOBOT_BROWSER_MCP_CONFIG ?? '/etc/zako-browser/mcp-profiles.json'
  const config = loadConfig(configPath)
  const hub = new BrowserHub(config.profiles)
  const server = new McpServer({
    name: 'persistent-browser',
    version: '1.1.0',
  })

  const shutdown = async () => {
    await hub.shutdown().catch((error) => {
      console.error('[persistent-browser-mcp] Shutdown error:', error)
    })
  }

  process.once('SIGINT', () => {
    void shutdown().finally(() => process.exit(0))
  })
  process.once('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0))
  })
  process.once('exit', () => {
    void hub.shutdown()
  })

  for (const profile of config.profiles) {
    server.registerTool(`${profile.id}_status`, {
      description: `Show whether the on-demand browser for ${profile.label} is running.`,
      inputSchema: {},
    }, async () => textResult(await hub.status(profile.id)))

    server.registerTool(`${profile.id}_start`, {
      description: `Start the browser for ${profile.label} in headless mode and keep its profile data.`,
      inputSchema: {},
    }, async () => textResult(await hub.start(profile.id)))

    server.registerTool(`${profile.id}_stop`, {
      description: `Stop the on-demand browser for ${profile.label} to free VPS memory.`,
      inputSchema: {},
    }, async () => textResult(await hub.stop(profile.id)))

    server.registerTool(`${profile.id}_open`, {
      description: `Start if needed, then open a URL inside the browser for ${profile.label}.`,
      inputSchema: openInput,
    }, async ({ url, waitUntil }) => textResult(await hub.open(profile.id, url, waitUntil)))

    server.registerTool(`${profile.id}_read`, {
      description: `Start if needed, then read visible text from the browser for ${profile.label}.`,
      inputSchema: readInput,
    }, async ({ url, maxChars }) => textResult(await hub.read(profile.id, { url, maxChars })))

    server.registerTool(`${profile.id}_click`, {
      description: `Start if needed, then click a page element in the browser for ${profile.label}.`,
      inputSchema: clickInput,
    }, async ({ selector }) => textResult(await hub.click(profile.id, selector)))

    server.registerTool(`${profile.id}_type`, {
      description: `Start if needed, then type into a page element in the browser for ${profile.label}.`,
      inputSchema: typeInput,
    }, async ({ selector, text, pressEnter }) => textResult(await hub.type(profile.id, selector, text, pressEnter)))

    server.registerTool(`${profile.id}_manual_login`, {
      description: `Start or switch the browser for ${profile.label} to headed mode, optionally open a target URL, then return the noVNC URL plus access password details for manual login or verification.`,
      inputSchema: manualLoginInput,
    }, async ({ url, waitUntil }) => textResult(await hub.manualLogin(profile.id, { url, waitUntil })))
  }

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((error) => {
  console.error('[persistent-browser-mcp] Fatal error:', error)
  process.exit(1)
})
