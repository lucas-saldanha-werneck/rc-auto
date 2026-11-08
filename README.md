# rc-auto

A Claude Code mod for the desktop app. It turns Remote Control on for a session when you type in
it, and turns it off again after 24 hours without a message from you.

Remote Control lets you keep using a Claude Code session that runs on your computer from
claude.ai/code or the Claude mobile app
([docs](https://code.claude.com/docs/en/remote-control)). The desktop app can connect every new
session to Remote Control (Settings > Code, "Connect new sessions to Remote Control"). That
connects every session you open, including ones you stopped using. rc-auto connects only the
sessions you type in, and disconnects each one a day after your last message.

## What you see

Nothing, most of the time. After a turn that started with a message you typed (in the prompt box,
or sent from another device through Remote Control), rc-auto switches Remote Control on if it is
not on already. 24 hours after your last such message, it switches it off.

`/rc-auto` shows what it did. Output from a test run:

```
Desktop app: yes
Remote Control (as set by rc-auto): on
Last message from you: 1970-01-01T00:00:01.000Z; off after 24 h without one
```

If the switch failed, a last line `Last error: <message>` follows.

## Install

From a shell:

```
claude plugin marketplace add lucas-saldanha-werneck/rc-auto
claude plugin install rc-auto@rc-auto
```

Or at the prompt of a terminal Claude Code session:

```
/plugin marketplace add lucas-saldanha-werneck/rc-auto
/plugin install rc-auto@rc-auto
```

Install with the user scope (the default) so the mod also loads in the desktop app's local Code
sessions.

## Keep a session on

rc-auto only switches off sessions it switched on, and it switches a session on only after a
message you typed. A session you never type in is outside its rule: if the desktop setting or
another tool connected it, rc-auto leaves it connected, and you need nothing here to keep it on.

The keep-on file is for a session you did type in but want to keep on past 24 idle hours, for
example one that afterwards only receives messages from another tool. List its id in
`~/.claude/rc-auto-keep-on.json` (or `$CLAUDE_CONFIG_DIR/rc-auto-keep-on.json` if you set
`CLAUDE_CONFIG_DIR`). On Windows, `~` is your user folder (`%USERPROFILE%`) when `HOME` is not
set:

```json
{ "session_ids": ["<session id>"] }
```

A file with a single `"local_id": "<session id>"` field also works, so another tool can write its
own session id there. The id is the session's `CLAUDE_CODE_HOST_SESSION_ID` environment variable.
Without the file, or if it does not parse, every session follows the 24-hour rule. rc-auto only
skips the switch-off for listed sessions; it still switches them on when you type.

## Your settings

If another tool already writes its session id to a file of its own (in the same
`{"local_id": ...}` or `{"session_ids": [...]}` shape), point rc-auto at that file instead of
copying the id. Your settings live outside the plugin, so plugin updates never touch them.

- **Settings file**: `~/.config/rc-auto/config.json` (or `$XDG_CONFIG_HOME/rc-auto/config.json`
  when `XDG_CONFIG_HOME` is set; on Windows `~` is `%USERPROFILE%` when `HOME` is not set):

  ```json
  { "keep_on_files": ["~/.claude/state/my-relay.json", "/srv/shared/keep-on.json"] }
  ```

- **Or `/config`** in Claude Code: the *Extra keep-on files* option (`keep_on_files`, a list of
  paths). Claude Code stores it in your `settings.json` under `pluginConfigs`.

| Key | Where | Type | Effect |
| --- | --- | --- | --- |
| `keep_on_files` | settings file or `/config` | list of paths (one string also works in the file) | extra keep-on files, read besides `~/.claude/rc-auto-keep-on.json`. A leading `~` is your home folder |

A session stays on when any of the files lists it. A file that is missing or does not parse is
skipped. `/rc-auto` shows which files it reads. There are no other settings.

## How it works

The desktop app gives its sessions a tool that switches Remote Control on or off
(`mcp__ccd_session_mgmt__set_remote_control`). The mod is one hooks module
(`hooks/register.ts`):

- A `prompt.submit` hook notes when a prompt came from you (origin `composer` or `bridge`),
  records the time, and restarts the 24 hours from that moment.
- A `turn.complete` hook then calls the tool with `enabled: true`. It waits for the end of the
  turn because the app's switch needs a session that has run a turn.
- A timer calls the tool with `enabled: false` once 24 hours pass with no new message from you.
  The time is stored in the mod's state, and at session start rc-auto reads it and sets the
  timer again.
- If the switch-off fails, rc-auto tries again after 5 minutes, then 10, 20 and 40, then every
  hour, until it works or you send a new message. `/rc-auto` shows the last error meanwhile.

Sessions without that tool (terminal sessions, for example) are left alone.

## Uninstall

```
claude plugin uninstall rc-auto@rc-auto
claude plugin marketplace remove rc-auto
```

At a terminal session's prompt, use `/plugin` in place of `claude plugin`.

## Limits and what was not tested

- Built and tested on Claude Code 2.1.319. It needs a version with mods (hooks modules).
- The tests use a fake desktop app (`claude plugin test .`). The switch tool is not in the public
  docs, so its name may change in a future app version. If it does, `/rc-auto` shows
  `Desktop app: no` and the mod does nothing.
- rc-auto only knows what it set. If you turn Remote Control off by hand, rc-auto still thinks it
  is on and does not turn it back on when you type, until its own 24-hour switch-off has run. It
  switches off only sessions it turned on.
- Not tried by hand for this release. The automated tests run on Linux, macOS and Windows; on
  Linux and Windows nothing else was tried.

## License

MIT. See `LICENSE`.

Built with Claude Code
