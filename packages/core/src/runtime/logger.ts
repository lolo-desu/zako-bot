import { appendFileSync } from 'fs'
import { formatWithOptions } from 'util'

const PATCHED_SYMBOL = Symbol.for('zakobot.consolePatched')

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug'

export function initFileConsoleLogging(filePath: string) {
  const globalState = globalThis as typeof globalThis & { [PATCHED_SYMBOL]?: boolean }
  if (globalState[PATCHED_SYMBOL]) {
    return
  }

  globalState[PATCHED_SYMBOL] = true

  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    patchConsoleMethod(level, filePath)
  }
}

function patchConsoleMethod(level: ConsoleMethod, filePath: string) {
  const original = console[level].bind(console)

  console[level] = (...args: unknown[]) => {
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${formatWithOptions({ colors: false, depth: 8 }, ...args)}\n`
    try {
      appendFileSync(filePath, line, 'utf8')
    }
    catch {
      // Ignore file logging failures and keep the process running.
    }

    original(...args)
  }
}
