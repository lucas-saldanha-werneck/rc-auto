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
  expect(enabled(calls)).toEqual([true])
  await clock.advance(10)
  expect(enabled(calls)).toEqual([true, false])
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
