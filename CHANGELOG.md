# Changelog

Versions are the `version` in `.claude-plugin/plugin.json`. Newest first.

## 0.2.6 (2026-11-13)

- README: add an Examples section.

## 0.2.5 (2026-11-12)

- Create the settings file exclusively so two sessions never overwrite it.

## 0.2.4 (2026-11-12)

- The idle deadline survives restarts (kept per desktop session).
- A failed switch-off is retried; idleness is checked again right before switching off.
- Every typed message turns Remote Control on; a keep-on session is checked again every hour.

## 0.2.3 (2026-11-11)

- Point to the catalog repo's new name, `lucas-tools`.

## 0.2.2 (2026-11-11)

- Catalog renamed to `lucas-tools`.

## 0.2.1 (2026-11-09)

- Short description, catalog install steps, settings headings in the README.

## 0.2.0 (2026-11-08)

- Keep-on list: extra files from a settings file or /config.
- Create your settings file on the first session.
- Keep-on paths: trim them and skip relative ones (and a relative `XDG_CONFIG_HOME`), which were read from the project folder.

## 0.1.2 (2026-11-08)

- Windows: find the keep-on file under `USERPROFILE` when `HOME` is unset.

## 0.1.1 (2026-11-08)

- Retry a failed switch-off; count idle time from the message.

## 0.1.0 (2026-11-08)

- Remote Control on when you type, off after 24 hours idle.
