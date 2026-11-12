import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RcState } from '../types'
import { CONFIG_EXAMPLE } from './config-example'

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

// $.state is gone when the app or the Mac restarts, but the app turns Remote
// Control back on for the sessions that had it on. The time of your last message
// and what rc-auto set are therefore kept in $.store too (one file shared by every
// session), under session:<id>, and read back at session start.
const SAVED_TTL_MS = 30 * IDLE_MS
type SavedSession = { lastTypedAt: number; rc: RcState; at: number }

const sessionKey = async ($: EngineInterface): Promise<string | undefined> => {
  try {
    const host = await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')
    if (host !== undefined && host !== '') return `session:${host}`
    const id = await $.session.id()
    return id !== undefined && id !== '' ? `session:${id}` : undefined
  } catch {
    return undefined
  }
}

const persist = async ($: EngineInterface): Promise<void> => {
  try {
    const key = await sessionKey($)
    if (key === undefined) return
    const state = await read($, rc)
    // Only a session rc-auto switched on has a deadline to keep; switched off
    // (or never on, as in a terminal), nothing is left to do for it.
    if (state !== 'on') {
      if ((await $.store.get(key)) !== undefined) await $.store.delete(key)
      return
    }
    const saved: SavedSession = { lastTypedAt: await read($, lastTypedAt), rc: state, at: await $.clock.now() }
    await $.store.set(key, saved)
  } catch {
    // The deadline still holds for as long as this process runs.
  }
}

// Session start: bring back what the store holds for this session, and drop
// records of sessions not seen for 30 days.
const restore = async ($: EngineInterface): Promise<void> => {
  try {
    const key = await sessionKey($)
    if (key === undefined) return
    const now = await $.clock.now()
    for (const k of await $.store.keys()) {
      if (!k.startsWith('session:') || k === key) continue
      const v = (await $.store.get(k)) as Partial<SavedSession> | undefined
      if (v === undefined || v === null || typeof v !== 'object' || !(Number(v.at) > now - SAVED_TTL_MS)) await $.store.delete(k)
    }
    if ((await read($, lastTypedAt)) > 0) return
    const v = (await $.store.get(key)) as Partial<SavedSession> | undefined
    if (v === undefined || v === null || typeof v !== 'object') return
    const typed = Number(v.lastTypedAt)
    if (!Number.isFinite(typed) || typed <= 0) return
    await update($, lastTypedAt, () => typed)
    const state: RcState = v.rc === 'on' || v.rc === 'off' ? v.rc : 'unknown'
    await update($, rc, () => state)
  } catch {
    // Start without it: the next message from you sets the deadline again.
  }
}

const hasTool = async ($: EngineInterface): Promise<boolean> =>
  (await $.tool.list()).some(t => t.name === RC_TOOL)

// rc-auto only switches off sessions it switched on (after a typed message).
// Optional: to keep one of those on past 24 idle hours (for example one that
// afterwards only receives messages from another tool), list it in a keep-on
// file:  { "session_ids": ["<desktop session id>"] }  or  { "local_id": "<id>" }
// The id is the session's CLAUDE_CODE_HOST_SESSION_ID. The files read are:
//   - ~/.claude/rc-auto-keep-on.json (or $CLAUDE_CONFIG_DIR/rc-auto-keep-on.json)
//   - each path in "keep_on_files" of your settings file,
//     ~/.config/rc-auto/config.json (or $XDG_CONFIG_HOME/rc-auto/config.json),
//     which the first session creates with the defaults (see seedSettings)
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
  (typeof v === 'string' ? [v] : Array.isArray(v) ? v : [])
    .filter((p): p is string => typeof p === 'string')
    .map(p => p.trim())
    .filter(p => p !== '')

// POSIX /x, Windows C:\x or C:/x. A relative path would land in the session's folder.
const isAbsolute = (p: string): boolean => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)

const readJson = async ($: EngineInterface, file: string): Promise<Record<string, unknown> | undefined> => {
  try {
    const v: unknown = JSON.parse(await $.fs.read(file))
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

// Your settings file: $XDG_CONFIG_HOME/rc-auto/config.json, else ~/.config/rc-auto/config.json.
// A relative XDG_CONFIG_HOME is ignored (the XDG spec says so; it would be read from the project).
const settingsFile = async ($: EngineInterface, h: string | undefined): Promise<string | undefined> => {
  const xdg = await $.env.get('XDG_CONFIG_HOME')
  const base = xdg !== undefined && isAbsolute(xdg) ? xdg : h !== undefined ? `${h}/.config` : undefined
  return base === undefined ? undefined : `${base}/rc-auto/config.json`
}

const keepOnFiles = async ($: EngineInterface): Promise<string[]> => {
  const h = await home($)
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  const files: (string | undefined)[] = [
    dir !== undefined && dir !== '' ? `${dir}/rc-auto-keep-on.json` : h !== undefined ? `${h}/.claude/rc-auto-keep-on.json` : undefined,
  ]
  const settingsPath = await settingsFile($, h)
  if (settingsPath !== undefined) {
    const settings = await readJson($, settingsPath)
    files.push(...paths(settings?.keep_on_files).map(p => expand(p, h)))
  }
  files.push(...optionFiles.map(p => expand(p, h)))
  // A relative path would be read from each session's project folder: skip it.
  return [...new Set(files.filter((f): f is string => f !== undefined && isAbsolute(f)))]
}

// Creates `$1` with stdin as its content only if it does not exist yet: the
// shell's noclobber (`set -C`) opens it with O_EXCL, so of two sessions
// starting together exactly one creates it and the other leaves it alone.
// Exit 0: created. Nonzero: already there (or the folder cannot be written).
const CREATE_EXCLUSIVE = 'mkdir -p -- "$(dirname -- "$1")" && set -C && cat > "$1"'

// First session after install: create your settings file from CONFIG_EXAMPLE
// when there is none. A file that is there is never rewritten, and any error
// (no home folder, read-only folder, a refused write) is ignored.
// On POSIX the create is exclusive (CREATE_EXCLUSIVE through `sh`), so a file
// another session or you created a moment ago is never overwritten. $.fs has
// no exclusive create, so where `sh` cannot be used (Windows, or process.run
// refused or missing) it falls back to check-then-write, which two sessions
// starting at the same instant on the very first run could still race.
const seedSettings = async ($: EngineInterface): Promise<void> => {
  try {
    const file = await settingsFile($, await home($))
    if (file === undefined || !isAbsolute(file)) return
    if ((await $.env.get('OS')) !== 'Windows_NT') {
      try {
        await $.process.run(['sh', '-c', CREATE_EXCLUSIVE, 'sh', file], { stdin: CONFIG_EXAMPLE, timeoutMs: 10_000 })
        return // created, or it is already there: either way nothing more to do
      } catch {
        // sh could not start or process.run was refused: fall back below
      }
    }
    if (await $.fs.exists(file)) return
    await $.fs.write(file, CONFIG_EXAMPLE)
  } catch {
    // never get in the way of starting a session
  }
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

const idle = async ($: EngineInterface): Promise<boolean> =>
  (await $.clock.now()) - (await read($, lastTypedAt)) >= IDLE_MS

// True when there is nothing left to do: the switch worked, or (switching on)
// there is no switch, or (switching off) a message came in meanwhile. False when
// it failed, including a switch tool missing or a tool list that failed at
// switch-off time: rc-auto turned it on, so it keeps trying to turn it off.
const setRc = async ($: EngineInterface, enabled: boolean): Promise<boolean> => {
  try {
    if (!(await hasTool($))) {
      if (enabled) return true
      throw new Error('the Remote Control switch tool is not listed right now')
    }
    // A message that came in while this ran wins: never switch off under it.
    if (!enabled && !(await idle($))) return true
    const ran = await $.tool.call({ tool: RC_TOOL, session_id: 'self', enabled } as never)
    if ('deny' in ran && ran.deny !== undefined) throw new Error(ran.deny)
    if (ran.isError === true) throw new Error(String(ran.text ?? 'error'))
    const state: RcState = enabled ? 'on' : 'off'
    await update($, rc, () => state)
    await update($, lastError, () => '')
    await persist($)
    return true
  } catch (err) {
    try {
      await update($, lastError, () => String(err instanceof Error ? err.message : err).slice(0, 300))
    } catch {
      // nothing more to record
    }
    return false
  }
}

const later = ($: EngineInterface, wait: number, attempt: number): void => {
  offTimer?.cancel()
  offTimer = $.clock.after(wait, () => {
    void tryOff($, attempt).catch(() => undefined)
  })
}

// Switches off if the session is still idle and still on; if the switch
// fails, tries again later. A new typed message cancels the retry. A session
// on the keep-on list is looked at again every hour, so taking it off the list
// lets it switch off.
const tryOff = async ($: EngineInterface, attempt: number): Promise<void> => {
  let done = false
  try {
    if (!(await idle($)) || (await read($, rc)) !== 'on') return
    if (await keepOn($)) {
      later($, RETRY_MAX_MS, 0)
      return
    }
    done = await setRc($, false)
  } catch {
    done = false
  }
  if (!done) later($, Math.min(RETRY_FIRST_MS * 2 ** attempt, RETRY_MAX_MS), attempt + 1)
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
    await seedSettings($)
    await $.command.register({ name: 'rc-auto', description: 'Show what rc-auto did with Remote Control' })
    await restore($)
    if ((await read($, lastTypedAt)) > 0) await armOff($)
    return next(e)
  })

  // Typed in the prompt box (composer) or sent from another device (bridge).
  // The 24 hours count from the message, so a turn that is still running
  // is never cut off by the old deadline.
  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin?.kind
    const typed = kind === 'composer' || kind === 'bridge'
    if (typed) {
      typedThisTurn = true
      const now = await $.clock.now()
      await update($, lastTypedAt, () => now)
      await persist($)
      await armOff($)
    }
    const result = await next(e)
    // Dropped (a hook blocked it): no turn of yours follows, so a later turn
    // started by a plugin must not take the flag.
    if (typed && result.drop !== undefined) typedThisTurn = false
    return result
  }).catch(($, e, next) => next(e))

  // After the turn: the app's switch needs a session that has run a turn.
  // Switched on after every message of yours, even when rc-auto set it on
  // before: you may have turned it off by hand, and the app leaves a switch
  // that is already on as it is ("no_change").
  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (!typedThisTurn || e.agentId !== undefined) return ran
    typedThisTurn = false
    await setRc($, true)
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
      `Keep-on files checked: ${(await keepOnFiles($).catch(() => [])).join(', ') || 'none'}`,
      ...(err !== '' ? [`Last error: ${err}`] : []),
    ]
    return { text: lines.join('\n') }
  })
}
