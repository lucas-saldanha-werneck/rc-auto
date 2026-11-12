import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// On Windows the engine resolves a drive-less absolute path onto the current
// drive with backslashes (D:\home\u\...). Compare paths in POSIX form.
const posix = (p: string): string => p.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')

const RC_TOOL = 'mcp__ccd_session_mgmt__set_remote_control'
const DAY = 24 * 60 * 60 * 1000

// A session in the desktop app: the switch tool is listed, and each call to it
// is recorded. Without `inApp` the tool is missing, as in a terminal session.
const app = (on: On, inApp = true): unknown[] => {
  const calls: unknown[] = []
  on('tool.list', async () => ({ value: inApp ? [{ name: RC_TOOL }] : [] }) as never)
  on('tool.call', async (_$, e) => {
    calls.push(e)
    return { result: 'ok', text: 'ok' } as never
  })
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('turn.complete', async () => ({ text: '' }) as never)
  return calls
}

const turn = async ($: never, kind: 'composer' | 'bridge' | 'plugin'): Promise<void> => {
  const s = $ as { prompt: { submit: (e: never) => Promise<unknown> }; turn: { complete: (e: never) => Promise<unknown> } }
  await s.prompt.submit({ text: 'hello', origin: { kind } } as never)
  await s.turn.complete({ answer: 'done', text: '' } as never)
}

const enabled = (calls: unknown[]): boolean[] => calls.map(c => (c as { enabled: boolean }).enabled)

test('a typed prompt turns Remote Control on after the turn', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const calls = app(on)
  await turn($ as never, 'composer')
  expect(enabled(calls)).toEqual([true])
})

test('a message sent from the phone also counts as typed', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const calls = app(on)
  await turn($ as never, 'bridge')
  expect(enabled(calls)).toEqual([true])
})

test('a prompt that did not come from you does nothing', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const calls = app(on)
  await turn($ as never, 'plugin')
  expect(calls).toEqual([])
})

test('turns Remote Control off after 24 hours without a typed message', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  const calls = app(on)
  await turn($ as never, 'composer')
  await clock.advance(DAY - 1)
  expect(enabled(calls)).toEqual([true])
  await clock.advance(1)
  expect(enabled(calls)).toEqual([true, false])
})

test('a new typed message restarts the 24 hours', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  const calls = app(on)
  await turn($ as never, 'composer')
  await clock.advance(DAY - 10)
  await turn($ as never, 'composer')
  await clock.advance(DAY - 10)
  // Each message of yours switches it on (a no-op in the app when it is on already).
  expect(enabled(calls)).toEqual([true, true])
  await clock.advance(10)
  expect(enabled(calls)).toEqual([true, true, false])
})

test('does nothing outside the desktop app', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const calls = app(on, false)
  await turn($ as never, 'composer')
  expect(calls).toEqual([])
})

test('a session listed in the keep-on file stays on', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  mock.env(on, { HOME: '/home/u', CLAUDE_CODE_HOST_SESSION_ID: 'abc' })
  const read: string[] = []
  on('fs.read', async (_$, e) => {
    read.push((e as { path: string }).path)
    return { value: JSON.stringify({ session_ids: ['abc'] }) } as never
  })
  const calls = app(on)
  await turn($ as never, 'composer')
  await clock.advance(DAY)
  expect(enabled(calls)).toEqual([true])
  expect(read.map(posix)).toEqual(['/home/u/.config/rc-auto/config.json', '/home/u/.claude/rc-auto-keep-on.json'])
})

test('without HOME the keep-on file is found under USERPROFILE (Windows)', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  mock.env(on, { USERPROFILE: '/profile/u', CLAUDE_CODE_HOST_SESSION_ID: 'abc' })
  const read: string[] = []
  on('fs.read', async (_$, e) => {
    read.push((e as { path: string }).path)
    return { value: JSON.stringify({ session_ids: ['abc'] }) } as never
  })
  const calls = app(on)
  await turn($ as never, 'composer')
  await clock.advance(DAY)
  expect(enabled(calls)).toEqual([true])
  expect(read.map(posix)).toEqual(['/profile/u/.config/rc-auto/config.json', '/profile/u/.claude/rc-auto-keep-on.json'])
})

test('a session not in the keep-on file still turns off', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  mock.env(on, { HOME: '/home/u', CLAUDE_CODE_HOST_SESSION_ID: 'abc' })
  on('fs.read', async () => ({ value: JSON.stringify({ local_id: 'other' }) }) as never)
  const calls = app(on)
  await turn($ as never, 'composer')
  await clock.advance(DAY)
  expect(enabled(calls)).toEqual([true, false])
})

test('/rc-auto reports the state', async ($, on) => {
  mock.clock(on, { now: 1000 })
  app(on)
  await turn($ as never, 'composer')
  const out = await ($ as never as { command: { run: (e: object) => Promise<{ text: string }> } }).command.run({ command: 'rc-auto', args: '' })
  expect(out.text).toContain('Desktop app: yes')
  expect(out.text).toContain('Remote Control (as set by rc-auto): on')
  expect(out.text).toContain('Last message from you: 1970-01-01T00:00:01.000Z')
})

test('a failed switch-off is tried again until it works', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  const calls: boolean[] = []
  let failOff = true
  on('tool.list', async () => ({ value: [{ name: RC_TOOL }] }) as never)
  on('tool.call', async (_$, e) => {
    const want = (e as { enabled: boolean }).enabled
    calls.push(want)
    if (!want && failOff) return { result: 'error', text: 'app busy', isError: true } as never
    return { result: 'ok', text: 'ok' } as never
  })
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('turn.complete', async () => ({ text: '' }) as never)
  await turn($ as never, 'composer')
  await clock.advance(DAY)
  expect(calls).toEqual([true, false])
  failOff = false
  await clock.advance(60 * 60 * 1000)
  expect(calls.filter(c => !c).length).toBeGreaterThan(1)
  const tries = calls.length
  await clock.advance(DAY)
  // Once it worked, it stops trying.
  expect(calls.length).toBe(tries)
})

test('a message counts from when you send it, not when the turn ends', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  const calls = app(on)
  await turn($ as never, 'composer')
  await clock.advance(DAY - 10)
  // A message arrives just before the deadline; its turn is still running.
  const s = $ as never as { prompt: { submit: (e: never) => Promise<unknown> } }
  await s.prompt.submit({ text: 'hello', origin: { kind: 'bridge' } } as never)
  await clock.advance(20)
  expect(enabled(calls)).toEqual([true])
})

test('a session you never type in is left alone', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  const calls = app(on)
  await turn($ as never, 'plugin')
  await clock.advance(2 * DAY)
  expect(calls).toEqual([])
})

// Files by POSIX path; any other path reads as empty (not JSON), like a missing file.
const files = (on: On, byPath: Record<string, unknown>): string[] => {
  const read: string[] = []
  on('fs.read', async (_$, e) => {
    const path = posix((e as { path: string }).path)
    read.push(path)
    return { value: path in byPath ? JSON.stringify(byPath[path]) : '' } as never
  })
  return read
}

test('your settings file can point at another keep-on file', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  mock.env(on, { HOME: '/home/u', CLAUDE_CODE_HOST_SESSION_ID: 'abc' })
  const read = files(on, {
    '/home/u/.config/rc-auto/config.json': { keep_on_files: ['~/.claude/state/relay.json'] },
    '/home/u/.claude/state/relay.json': { local_id: 'abc' },
  })
  const calls = app(on)
  await turn($ as never, 'composer')
  await clock.advance(DAY)
  expect(enabled(calls)).toEqual([true])
  expect(read).toContain('/home/u/.claude/state/relay.json')
})

test('the settings file follows XDG_CONFIG_HOME', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  mock.env(on, { HOME: '/home/u', XDG_CONFIG_HOME: '/xdg', CLAUDE_CODE_HOST_SESSION_ID: 'abc' })
  files(on, {
    '/xdg/rc-auto/config.json': { keep_on_files: '/data/keep.json' },
    '/data/keep.json': { session_ids: ['abc'] },
  })
  const calls = app(on)
  await turn($ as never, 'composer')
  await clock.advance(DAY)
  expect(enabled(calls)).toEqual([true])
})

test('the keep_on_files option adds files too', { options: { keep_on_files: ['~/elsewhere.json'] } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  mock.env(on, { HOME: '/home/u', CLAUDE_CODE_HOST_SESSION_ID: 'abc' })
  files(on, { '/home/u/elsewhere.json': { local_id: 'abc' } })
  const calls = app(on)
  await turn($ as never, 'composer')
  await clock.advance(DAY)
  expect(enabled(calls)).toEqual([true])
})

test('a session in none of the listed files still turns off', { options: { keep_on_files: ['/b.json'] } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  mock.env(on, { HOME: '/home/u', CLAUDE_CODE_HOST_SESSION_ID: 'abc' })
  const read = files(on, {
    '/home/u/.config/rc-auto/config.json': { keep_on_files: ['/a.json'] },
    '/a.json': { local_id: 'other' },
    '/b.json': { session_ids: ['x', 'y'] },
  })
  const calls = app(on)
  await turn($ as never, 'composer')
  await clock.advance(DAY)
  expect(enabled(calls)).toEqual([true, false])
  expect(read).toEqual(expect.arrayContaining(['/a.json', '/b.json', '/home/u/.claude/rc-auto-keep-on.json']))
})

test('/rc-auto lists the keep-on files it reads', { options: { keep_on_files: ['/b.json'] } }, async ($, on) => {
  mock.clock(on, { now: 1000 })
  mock.env(on, { HOME: '/home/u' })
  files(on, {})
  app(on)
  const out = await ($ as never as { command: { run: (e: object) => Promise<{ text: string }> } }).command.run({ command: 'rc-auto', args: '' })
  expect(posix(out.text)).toContain('/b.json')
  expect(posix(out.text)).toContain('rc-auto-keep-on.json')
})

test('keep-on paths are trimmed, and a relative one is never read from the project folder', { options: { keep_on_files: [' ~/opt.json '] } }, async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  mock.env(on, { HOME: '/home/u', CLAUDE_CODE_HOST_SESSION_ID: 'abc' })
  const read = files(on, {
    '/home/u/.config/rc-auto/config.json': { keep_on_files: ['  ~/.claude/state/relay.json', 'state/relay.json', '.claude/x.json'] },
    '/home/u/.claude/state/relay.json': { local_id: 'other' },
    '/home/u/opt.json': { local_id: 'other' },
    'state/relay.json': { local_id: 'abc' },
    '.claude/x.json': { local_id: 'abc' },
  })
  const calls = app(on)
  await turn($ as never, 'composer')
  await clock.advance(DAY)
  expect(enabled(calls)).toEqual([true, false])
  // The engine resolves a relative path against the session's folder; none may be read at all.
  expect([...new Set(read)].sort()).toEqual([
    '/home/u/.claude/rc-auto-keep-on.json', '/home/u/.claude/state/relay.json', '/home/u/.config/rc-auto/config.json', '/home/u/opt.json',
  ])
})

// ---- first session: your settings file is created when missing

import { CONFIG_EXAMPLE } from '../hooks/config-example'

type Write = { path: string; text: string }

// A file system that has exactly the given POSIX paths; writes are recorded,
// not made. `failWrite` makes every write reject, like a read-only folder.
const disk = (on: On, have: string[] = [], failWrite = false): Write[] => {
  const writes: Write[] = []
  on('fs.exists', async (_$, e) => ({ value: have.includes(posix((e as { path: string }).path)) }) as never)
  on('fs.write', async (_$, e) => {
    const w = e as Write
    if (failWrite) throw new Error('EACCES: permission denied')
    writes.push({ path: posix(w.path), text: w.text })
    return { value: undefined } as never
  })
  on('command.register', async () => ({ value: undefined }) as never)
  core(on)
  return writes
}

// What core does beneath the plugins at session start: echo { cwd }.
const core = (on: On): void => {
  on('session.start', async (_$, e) => ({ cwd: (e as { cwd: string }).cwd }) as never)
}

const start = async ($: never): Promise<unknown> =>
  ($ as { session: { start: (e: never) => Promise<unknown> } }).session.start({ cwd: '/work', surface: null, isInteractive: false } as never)

test('the first session creates the settings file with the defaults', async ($, on) => {
  mock.env(on, { HOME: '/home/u' })
  const writes = disk(on)
  expect(await start($ as never)).toEqual({ cwd: '/work' })
  expect(writes).toEqual([{ path: '/home/u/.config/rc-auto/config.json', text: CONFIG_EXAMPLE }])
})

test('the settings file is created under XDG_CONFIG_HOME when it is set', async ($, on) => {
  mock.env(on, { HOME: '/home/u', XDG_CONFIG_HOME: '/xdg' })
  const writes = disk(on)
  await start($ as never)
  expect(writes.map(w => w.path)).toEqual(['/xdg/rc-auto/config.json'])
})

test('without HOME the settings file goes under USERPROFILE (Windows)', async ($, on) => {
  mock.env(on, { USERPROFILE: '/profile/u' })
  const writes = disk(on)
  await start($ as never)
  expect(writes.map(w => w.path)).toEqual(['/profile/u/.config/rc-auto/config.json'])
})

test('an existing settings file is never rewritten', async ($, on) => {
  mock.env(on, { HOME: '/home/u' })
  const writes = disk(on, ['/home/u/.config/rc-auto/config.json'])
  await start($ as never)
  await start($ as never)
  expect(writes).toEqual([])
})

test('a refused or failing write does not stop the session', async ($, on) => {
  mock.env(on, { HOME: '/home/u' })
  disk(on, [], true)
  expect(await start($ as never)).toEqual({ cwd: '/work' })
})

test('a failing exists check does not stop the session and writes nothing', async ($, on) => {
  mock.env(on, { HOME: '/home/u' })
  const writes: Write[] = []
  on('fs.exists', async () => {
    throw new Error('EIO')
  })
  on('fs.write', async (_$, e) => {
    writes.push(e as Write)
    return { value: undefined } as never
  })
  on('command.register', async () => ({ value: undefined }) as never)
  core(on)
  expect(await start($ as never)).toEqual({ cwd: '/work' })
  expect(writes).toEqual([])
})

test('no home folder, or a relative XDG_CONFIG_HOME: nothing is written', async ($, on) => {
  mock.env(on, { XDG_CONFIG_HOME: 'relative/dir' })
  const writes = disk(on)
  await start($ as never)
  expect(writes).toEqual([])
})

test('a relative XDG_CONFIG_HOME is ignored: the settings file under HOME is used and created', async ($, on) => {
  mock.env(on, { HOME: '/home/u', XDG_CONFIG_HOME: '.config' })
  const writes = disk(on)
  await start($ as never)
  expect(writes.map(w => w.path)).toEqual(['/home/u/.config/rc-auto/config.json'])
})

test('the starter file is valid JSON, every key at its default and documented', async () => {
  const cfg = JSON.parse(CONFIG_EXAMPLE) as Record<string, unknown>
  expect(Object.keys(cfg).sort()).toEqual(['_doc', 'keep_on_files'])
  expect(cfg.keep_on_files).toEqual([])
  expect(Object.keys(cfg._doc as object)).toContain('keep_on_files')
})

// The same day in the same session, once with no settings file and once with
// the starter file: same switch calls and same keep-on files read.
const dayWith = async ($: never, on: On, settings: string | undefined): Promise<{ calls: boolean[]; report: string }> => {
  const clock = mock.clock(on, { now: 1000 })
  mock.env(on, { HOME: '/home/u', CLAUDE_CODE_HOST_SESSION_ID: 'abc' })
  on('fs.read', async (_$, e) => {
    const path = posix((e as { path: string }).path)
    if (path === '/home/u/.config/rc-auto/config.json' && settings !== undefined) return { value: settings } as never
    if (path === '/home/u/elsewhere.json') return { value: JSON.stringify({ local_id: 'abc' }) } as never
    throw new Error('ENOENT')
  })
  const calls = app(on)
  await turn($, 'composer')
  await clock.advance(DAY)
  const out = await ($ as { command: { run: (e: object) => Promise<{ text: string }> } }).command.run({ command: 'rc-auto', args: '' })
  return { calls: enabled(calls), report: posix(out.text) }
}

let noFile: { calls: boolean[]; report: string } | undefined
let noFileWithOption: { calls: boolean[]; report: string } | undefined

test('reference: no settings file', async ($, on) => {
  noFile = await dayWith($ as never, on, undefined)
  expect(noFile.calls).toEqual([true, false])
})

test('the starter settings file behaves exactly like no file', async ($, on) => {
  const seeded = await dayWith($ as never, on, CONFIG_EXAMPLE)
  expect(noFile).toBeDefined()
  expect(seeded).toEqual(noFile)
})

test('reference: no settings file, keep_on_files set in /config', { options: { keep_on_files: ['~/elsewhere.json'] } }, async ($, on) => {
  noFileWithOption = await dayWith($ as never, on, undefined)
  expect(noFileWithOption.calls).toEqual([true])
})

test('with the starter file the /config keep_on_files option still applies', { options: { keep_on_files: ['~/elsewhere.json'] } }, async ($, on) => {
  const seeded = await dayWith($ as never, on, CONFIG_EXAMPLE)
  expect(noFileWithOption).toBeDefined()
  expect(seeded).toEqual(noFileWithOption)
})

// ---- audit round 2

// A plugin store the test can see (it outlives a restart: the app reads it back).
const store = (on: On, kept: Record<string, unknown> = {}): Record<string, unknown> => {
  on('store.get', async (_$, e) => ({ value: kept[(e as { key: string }).key] }) as never)
  on('store.set', async (_$, e) => {
    const one = e as { key: string; value: unknown }
    kept[one.key] = JSON.parse(JSON.stringify(one.value))
    return { value: undefined } as never
  })
  on('store.delete', async (_$, e) => {
    delete kept[(e as { key: string }).key]
    return { value: undefined } as never
  })
  on('store.keys', async () => ({ value: Object.keys(kept) }) as never)
  return kept
}

test('RA-06 the 24 hours survive an app restart (time and state kept in the store)', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  mock.env(on, { HOME: '/home/u', CLAUDE_CODE_HOST_SESSION_ID: 'local_abc' })
  const kept = store(on)
  disk(on)
  const calls = app(on)
  await start($ as never)
  await turn($ as never, 'composer')
  expect(enabled(calls)).toEqual([true])
  const saved = Object.values(kept).find(v => (v as { rc?: string }).rc === 'on') as { lastTypedAt: number; rc: string }
  expect(saved.lastTypedAt).toBe(1000)
  await clock.advance(DAY)
  expect(enabled(calls)).toEqual([true, false])
})

test('RA-06 after a restart (fresh state) the saved deadline still turns it off', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 + DAY - 60_000 })
  mock.env(on, { HOME: '/home/u', CLAUDE_CODE_HOST_SESSION_ID: 'local_abc' })
  store(on, { 'session:local_abc': { lastTypedAt: 1000, rc: 'on', at: 1000 } })
  disk(on)
  const calls = app(on)
  await start($ as never)
  expect(calls).toEqual([])
  await clock.advance(60_000)
  expect(enabled(calls)).toEqual([false])
})

test('RA-01 the switch tool missing at switch-off time is tried again', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  let listed = true
  const calls: boolean[] = []
  on('tool.list', async () => ({ value: listed ? [{ name: RC_TOOL }] : [] }) as never)
  on('tool.call', async (_$, e) => {
    calls.push((e as { enabled: boolean }).enabled)
    return { result: 'ok', text: 'ok' } as never
  })
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('turn.complete', async () => ({ text: '' }) as never)
  await turn($ as never, 'composer')
  listed = false
  await clock.advance(DAY)
  expect(calls).toEqual([true])
  listed = true
  await clock.advance(60 * 60 * 1000)
  expect(calls).toEqual([true, false])
})

test('RA-02 an error listing the tools at switch-off time is tried again', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  let broken = false
  const calls: boolean[] = []
  on('tool.list', async () => {
    if (broken) throw new Error('tool list unavailable')
    return { value: [{ name: RC_TOOL }] } as never
  })
  on('tool.call', async (_$, e) => {
    calls.push((e as { enabled: boolean }).enabled)
    return { result: 'ok', text: 'ok' } as never
  })
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('turn.complete', async () => ({ text: '' }) as never)
  await turn($ as never, 'composer')
  broken = true
  await clock.advance(DAY)
  expect(calls).toEqual([true])
  broken = false
  await clock.advance(60 * 60 * 1000)
  expect(calls).toEqual([true, false])
})

test('RA-03 a message that arrives while the switch-off is under way stops it', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  const calls: boolean[] = []
  let gate: Promise<void> | undefined
  let release: () => void = () => {}
  let reached = false
  on('tool.list', async () => {
    if (gate !== undefined) {
      reached = true
      await gate
    }
    return { value: [{ name: RC_TOOL }] } as never
  })
  on('tool.call', async (_$, e) => {
    calls.push((e as { enabled: boolean }).enabled)
    return { result: 'ok', text: 'ok' } as never
  })
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('turn.complete', async () => ({ text: '' }) as never)
  await turn($ as never, 'composer')
  gate = new Promise<void>(r => (release = r))
  await clock.advance(DAY)
  for (let k = 0; k < 200 && !reached; k++) await Promise.resolve()
  expect(reached).toBe(true)
  // The switch-off is waiting on the tool list; a message from the phone comes in now.
  gate = undefined
  const s = $ as never as { prompt: { submit: (e: never) => Promise<unknown> } }
  await s.prompt.submit({ text: 'hi', origin: { kind: 'bridge' } } as never)
  release()
  for (let k = 0; k < 200; k++) await Promise.resolve()
  expect(calls).toEqual([true])
})

test('RA-04 a session taken off the keep-on list is switched off later', async ($, on) => {
  const clock = mock.clock(on, { now: 1000 })
  mock.env(on, { HOME: '/home/u', CLAUDE_CODE_HOST_SESSION_ID: 'abc' })
  let listed = true
  on('fs.read', async (_$, e) => {
    const path = posix((e as { path: string }).path)
    if (path === '/home/u/.claude/rc-auto-keep-on.json' && listed) return { value: JSON.stringify({ local_id: 'abc' }) } as never
    throw new Error('ENOENT')
  })
  const calls = app(on)
  await turn($ as never, 'composer')
  await clock.advance(DAY)
  expect(enabled(calls)).toEqual([true])
  listed = false
  await clock.advance(60 * 60 * 1000)
  expect(enabled(calls)).toEqual([true, false])
})

test('RA-09 a typed message turns Remote Control on again even when rc-auto thinks it is on', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const calls = app(on)
  await turn($ as never, 'composer')
  // Turned off by hand in the app meanwhile; the next message from you turns it on again.
  await turn($ as never, 'composer')
  expect(enabled(calls)).toEqual([true, true])
})

test('RA-07 a typed prompt that is dropped does not turn Remote Control on at a later turn', async ($, on) => {
  mock.clock(on, { now: 1000 })
  const calls: unknown[] = []
  let drop = true
  on('tool.list', async () => ({ value: [{ name: RC_TOOL }] }) as never)
  on('tool.call', async (_$, e) => {
    calls.push(e)
    return { result: 'ok', text: 'ok' } as never
  })
  on('prompt.submit', async (_$, e) => (drop ? { drop: 'blocked' } : { text: e.text }) as never)
  on('turn.complete', async () => ({ text: '' }) as never)
  const s = $ as never as { prompt: { submit: (e: never) => Promise<unknown> }; turn: { complete: (e: never) => Promise<unknown> } }
  await s.prompt.submit({ text: 'hello', origin: { kind: 'composer' } } as never)
  drop = false
  await s.prompt.submit({ text: 'from a plugin', origin: { kind: 'plugin' } } as never)
  await s.turn.complete({ answer: 'done', text: '' } as never)
  expect(calls).toEqual([])
})
