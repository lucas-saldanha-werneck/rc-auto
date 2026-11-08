import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RcState } from '../types'

// When you type in this session (at the desk or from your phone), turn
// Remote Control on; after IDLE_MS with no message from you, turn it off.
// The switch is the desktop app's own tool, so this acts only in the app.

const IDLE_MS = 24 * 60 * 60 * 1000
// A failed switch-off is tried again after 5 minutes, then 10, 20, 40, and
// every hour after that, for as long as the session stays idle.
const RETRY_FIRST_MS = 5 * 60 * 1000
const RETRY_MAX_MS = 60 * 60 * 1000
const RC_TOOL = 'mcp__ccd_session_mgmt__set_remote_control'

const lastTypedAt = atom({ plugin: 'rc-auto', key: 'lastTypedAt' } as const, 0)
const rc = atom({ plugin: 'rc-auto', key: 'rc' } as const, 'unknown')
const lastError = atom({ plugin: 'rc-auto', key: 'lastError' } as const, '')

let typedThisTurn = false
let offTimer: { cancel: () => void } | undefined

const hasTool = async ($: EngineInterface): Promise<boolean> =>
  (await $.tool.list()).some(t => t.name === RC_TOOL)

// rc-auto only switches off sessions it switched on (after a typed message).
// Optional: to keep one of those on past 24 idle hours (for example one that
// afterwards only receives messages from another tool), list it in a keep-on
// file:  { "session_ids": ["<desktop session id>"] }  or  { "local_id": "<id>" }
// The id is the session's CLAUDE_CODE_HOST_SESSION_ID. The files read are:
//   - ~/.claude/rc-auto-keep-on.json (or $CLAUDE_CONFIG_DIR/rc-auto-keep-on.json)
//   - each path in "keep_on_files" of your settings file,
//     ~/.config/rc-auto/config.json (or $XDG_CONFIG_HOME/rc-auto/config.json)
//   - each path in the plugin's keep_on_files option (/config, userConfig)
// No file: no exceptions. A missing or unreadable file is skipped.
let optionFiles: readonly string[] = []

const home = async ($: EngineInterface): Promise<string | undefined> => {
  // Windows does not set HOME unless a shell like Git Bash does; it sets USERPROFILE.
  let h = await $.env.get('HOME')
  if (h === undefined || h === '') h = await $.env.get('USERPROFILE')
  return h !== undefined && h !== '' ? h : undefined
}

const expand = (path: string, h: string | undefined): string | undefined => {
  if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) return h === undefined ? undefined : h + path.slice(1)
  return path
}

const paths = (v: unknown): string[] =>
  (typeof v === 'string' ? [v] : Array.isArray(v) ? v : []).filter((p): p is string => typeof p === 'string' && p.trim() !== '')

const readJson = async ($: EngineInterface, file: string): Promise<Record<string, unknown> | undefined> => {
  try {
    const v: unknown = JSON.parse(await $.fs.read(file))
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const keepOnFiles = async ($: EngineInterface): Promise<string[]> => {
  const h = await home($)
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  const files: (string | undefined)[] = [
    dir !== undefined && dir !== '' ? `${dir}/rc-auto-keep-on.json` : h !== undefined ? `${h}/.claude/rc-auto-keep-on.json` : undefined,
  ]
  const xdg = await $.env.get('XDG_CONFIG_HOME')
  const base = xdg !== undefined && xdg !== '' ? xdg : h !== undefined ? `${h}/.config` : undefined
  if (base !== undefined) {
    const settings = await readJson($, `${base}/rc-auto/config.json`)
    files.push(...paths(settings?.keep_on_files).map(p => expand(p, h)))
  }
  files.push(...optionFiles.map(p => expand(p, h)))
  return [...new Set(files.filter((f): f is string => f !== undefined))]
}

const keepOn = async ($: EngineInterface): Promise<boolean> => {
  try {
    const self = await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')
    if (self === undefined || self === '') return false
    for (const file of await keepOnFiles($)) {
      const cfg = await readJson($, file)
      if (cfg === undefined) continue
      if (cfg.local_id === self) return true
      if (Array.isArray(cfg.session_ids) && cfg.session_ids.includes(self)) return true
    }
    return false
  } catch {
    return false
  }
}

// True when there is nothing left to do: the switch worked, or there is no
// switch, or the session is on the keep-on list. False when the switch failed.
const setRc = async ($: EngineInterface, enabled: boolean): Promise<boolean> => {
  if (!(await hasTool($))) return true
  if (!enabled && (await keepOn($))) return true
  try {
    const ran = await $.tool.call({ tool: RC_TOOL, session_id: 'self', enabled } as never)
    if ('deny' in ran && ran.deny !== undefined) throw new Error(ran.deny)
    if (ran.isError === true) throw new Error(String(ran.text ?? 'error'))
    const state: RcState = enabled ? 'on' : 'off'
    await update($, rc, () => state)
    await update($, lastError, () => '')
    return true
  } catch (err) {
    await update($, lastError, () => String(err instanceof Error ? err.message : err).slice(0, 300))
    return false
  }
}

// Switches off if the session is still idle and still on; if the switch
// fails, tries again later. A new typed message cancels the retry.
const tryOff = async ($: EngineInterface, attempt: number): Promise<void> => {
  const since = (await $.clock.now()) - (await read($, lastTypedAt))
  if (since < IDLE_MS || (await read($, rc)) !== 'on') return
  if (await setRc($, false)) return
  const wait = Math.min(RETRY_FIRST_MS * 2 ** attempt, RETRY_MAX_MS)
  offTimer = $.clock.after(wait, () => {
    void tryOff($, attempt + 1).catch(() => undefined)
  })
}

const armOff = async ($: EngineInterface): Promise<void> => {
  offTimer?.cancel()
  const left = (await read($, lastTypedAt)) + IDLE_MS - (await $.clock.now())
  if (left <= 0) {
    await tryOff($, 0)
    return
  }
  offTimer = $.clock.after(left, () => {
    void tryOff($, 0).catch(() => undefined)
  })
}

export const register: Register = (on, options) => {
  optionFiles = paths(options?.keep_on_files)
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'rc-auto', description: 'Show what rc-auto did with Remote Control' })
    if ((await read($, lastTypedAt)) > 0) await armOff($)
    return next(e)
  })

  // Typed in the prompt box (composer) or sent from another device (bridge).
  // The 24 hours count from the message, so a turn that is still running
  // is never cut off by the old deadline.
  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin?.kind
    if (kind === 'composer' || kind === 'bridge') {
      typedThisTurn = true
      const now = await $.clock.now()
      await update($, lastTypedAt, () => now)
      await armOff($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // After the turn: the app's switch needs a session that has run a turn.
  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (!typedThisTurn) return ran
    typedThisTurn = false
    if ((await read($, rc)) !== 'on') await setRc($, true)
    await armOff($)
    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'rc-auto' }, async $ => {
    const typed = await read($, lastTypedAt)
    const err = await read($, lastError)
    const app = await hasTool($)
    const lines = [
      app ? 'Desktop app: yes' : 'Desktop app: no (this session has no Remote Control switch tool)',
      `Remote Control (as set by rc-auto): ${await read($, rc)}`,
      typed > 0 ? `Last message from you: ${new Date(typed).toISOString()}; off after 24 h without one` : 'No message from you yet',
      `Keep-on files read: ${(await keepOnFiles($).catch(() => [])).join(', ') || 'none'}`,
      ...(err !== '' ? [`Last error: ${err}`] : []),
    ]
    return { text: lines.join('\n') }
  })
}
