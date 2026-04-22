import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { homedir } from 'os'
import type { H3Event } from 'h3'
import { deleteCookie, getCookie, setCookie } from 'h3'

const AUTH_COOKIE_NAME = 'zakobot_panel_session'
const AUTH_FILE_NAME = 'panel-auth.json'
const DEFAULT_PASSWORD = '123456'
const SESSION_MAX_AGE = 60 * 60 * 24 * 30

interface StoredAuthState {
  passwordHash: string
  salt: string
  isDefaultPassword: boolean
  sessionToken: string
  updatedAt: string
}

export interface PanelAuthSession {
  authenticated: boolean
  requiresPasswordChange: boolean
}

interface PasswordChangeResult {
  sessionToken: string
}

export function getPanelAuthSession(event: H3Event): PanelAuthSession {
  const state = ensureAuthState()
  const token = getCookie(event, AUTH_COOKIE_NAME)

  return {
    authenticated: hasValidSessionToken(token, state.sessionToken),
    requiresPasswordChange: state.isDefaultPassword,
  }
}

export function loginWithPassword(password: string) {
  const state = ensureAuthState()

  if (!verifyPassword(password, state)) {
    return null
  }

  const nextState: StoredAuthState = {
    ...state,
    sessionToken: createSessionToken(),
    updatedAt: new Date().toISOString(),
  }

  writeAuthState(nextState)

  return {
    sessionToken: nextState.sessionToken,
    requiresPasswordChange: nextState.isDefaultPassword,
  }
}

export function logoutSession(event: H3Event) {
  clearPanelAuthCookie(event)
}

export function changePanelPassword(currentPassword: string, nextPassword: string): PasswordChangeResult | null {
  const state = ensureAuthState()

  if (!verifyPassword(currentPassword, state)) {
    return null
  }

  const salt = createSalt()
  const nextState: StoredAuthState = {
    passwordHash: hashPassword(nextPassword, salt),
    salt,
    isDefaultPassword: nextPassword === DEFAULT_PASSWORD,
    sessionToken: createSessionToken(),
    updatedAt: new Date().toISOString(),
  }

  writeAuthState(nextState)

  return {
    sessionToken: nextState.sessionToken,
  }
}

export function setPanelAuthCookie(event: H3Event, sessionToken: string) {
  setCookie(event, AUTH_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    path: '/',
    sameSite: 'lax',
    secure: shouldUseSecureCookie(event),
    maxAge: SESSION_MAX_AGE,
  })
}

export function clearPanelAuthCookie(event: H3Event) {
  deleteCookie(event, AUTH_COOKIE_NAME, {
    httpOnly: true,
    path: '/',
    sameSite: 'lax',
    secure: shouldUseSecureCookie(event),
  })
}

function shouldUseSecureCookie(event: H3Event) {
  const forwardedProto = event.node.req.headers['x-forwarded-proto']

  if (typeof forwardedProto === 'string' && forwardedProto.trim()) {
    return forwardedProto.split(',')[0]?.trim() === 'https'
  }

  return Boolean((event.node.req.socket as { encrypted?: boolean }).encrypted)
}

function ensureAuthState(): StoredAuthState {
  const filePath = getAuthFilePath()

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<StoredAuthState>

    if (
      typeof parsed.passwordHash === 'string'
      && typeof parsed.salt === 'string'
      && typeof parsed.isDefaultPassword === 'boolean'
      && typeof parsed.sessionToken === 'string'
      && typeof parsed.updatedAt === 'string'
    ) {
      return parsed as StoredAuthState
    }
  }
  catch {
    // Fall back to the default credentials state below.
  }

  const defaultState = createDefaultAuthState()
  writeAuthState(defaultState)
  return defaultState
}

function createDefaultAuthState(): StoredAuthState {
  const salt = createSalt()

  return {
    passwordHash: hashPassword(DEFAULT_PASSWORD, salt),
    salt,
    isDefaultPassword: true,
    sessionToken: '',
    updatedAt: new Date().toISOString(),
  }
}

function writeAuthState(state: StoredAuthState) {
  const filePath = getAuthFilePath()
  const dirPath = dirname(filePath)
  mkdirSync(dirPath, { recursive: true })

  const tempPath = `${filePath}.tmp`
  writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf8')
  renameSync(tempPath, filePath)
}

function getAuthFilePath() {
  const home = process.env.ZAKOBOT_HOME ?? resolve(homedir(), '.zakobot')
  mkdirSync(home, { recursive: true })
  return resolve(home, AUTH_FILE_NAME)
}

function hashPassword(password: string, salt: string) {
  return scryptSync(password, salt, 64).toString('hex')
}

function verifyPassword(password: string, state: StoredAuthState) {
  const expected = Buffer.from(state.passwordHash, 'hex')
  const actual = Buffer.from(hashPassword(password, state.salt), 'hex')

  if (expected.length !== actual.length) {
    return false
  }

  return timingSafeEqual(expected, actual)
}

function hasValidSessionToken(token: string | undefined, sessionToken: string) {
  if (!token || !sessionToken) {
    return false
  }

  const left = Buffer.from(token)
  const right = Buffer.from(sessionToken)

  if (left.length !== right.length) {
    return false
  }

  return timingSafeEqual(left, right)
}

function createSalt() {
  return randomBytes(16).toString('hex')
}

function createSessionToken() {
  return randomBytes(32).toString('hex')
}
