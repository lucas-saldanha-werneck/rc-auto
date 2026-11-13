# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue. Open the repository's
[Security tab](https://github.com/lucas-saldanha-werneck/rc-auto/security) and choose
"Report a vulnerability" (GitHub private vulnerability reporting).

## Supported versions

Only the latest release is supported. Fixes land there.

## What this plugin accesses

- It runs inside the Claude desktop app's mod host and calls the app's own Remote Control switch tool (`set_remote_control`) for sessions you type in, and again to turn it off after 24 hours without a message from you.
- Files: it reads and creates `~/.config/rc-auto/config.json`, and reads `~/.claude/rc-auto-keep-on.json` and any files you list in `keep_on_files`. It does not read transcripts.
- Processes: one short `sh -c` call to create the config file without overwriting an existing one.
- Network: the plugin's own code makes no network requests, and it does not read secrets.

