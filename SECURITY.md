# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue. Open the repository's
[Security tab](https://github.com/lucas-saldanha-werneck/rc-auto/security) and choose
"Report a vulnerability" (GitHub private vulnerability reporting).

## Supported versions

Only the latest release is supported. Fixes land there.

## What this plugin accesses

- It runs inside the Claude desktop app's mod host and calls the app's own Remote Control switch tool (`set_remote_control`) to turn Remote Control on after each message you type or send from another device, and off again after 24 hours without one. While it is on, the session can be reached from your other devices.
- Files: it reads and creates `~/.config/rc-auto/config.json` (or under `$XDG_CONFIG_HOME`), and reads `~/.claude/rc-auto-keep-on.json` (or under `$CLAUDE_CONFIG_DIR`) and any files you list in `keep_on_files`. It does not read transcripts.
- Stored data: for each session it switched on, it keeps the session id and the time of your last message in the mod's own plugin store, so the 24-hour deadline survives a restart; records unseen for 30 days are dropped.
- Processes: one short `sh -c` call to create the config file without overwriting an existing one.
- Network: the plugin's own code makes no network requests, and it does not read secrets.
