// The starter settings file. On the first session with no settings file,
// rc-auto writes this text to ~/.config/rc-auto/config.json (or
// $XDG_CONFIG_HOME/rc-auto/config.json). Every value is the default, so the
// file changes nothing until you edit it; an existing file is never rewritten.
export const CONFIG_EXAMPLE = `{
  "_doc": {
    "about": "Your rc-auto settings. Plugin updates never touch this file. Every value below is the default, so this file changes nothing until you edit it. Keys that start with _ are ignored.",
    "keep_on_files": "Paths of extra keep-on files, read besides ~/.claude/rc-auto-keep-on.json. Each is JSON in the keep-on format: {\\"local_id\\": \\"<id>\\"} or {\\"session_ids\\": [\\"<id>\\", ...]}, where the id is a desktop session's CLAUDE_CODE_HOST_SESSION_ID. A session listed in any of them is not turned off after 24 idle hours. ~ is your home folder. The keep_on_files option in /config adds more files; both lists are read. Example: [\\"~/.claude/state/relay.json\\"]"
  },
  "keep_on_files": []
}
`
