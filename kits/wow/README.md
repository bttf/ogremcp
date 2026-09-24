# WoW kit

## `manifest.json`

Notes on `adapter.process` (docs/architecture.md §6.1, §7):

- The Windows globs list the client names exactly (`Wow.exe`, `WowClassic.exe`, their test and beta builds, with or without `-64`), as the prototype did. They replace the §6.1 example's `Wow*.exe`, which also matches `WowVoiceProxy.exe` and `WowError.exe`. Those processes would block adapter updates.
- The macOS glob `World of Warcraft*` also matches the WoW launcher. The owner accepted this on 2026-09-24. An adapter update waits while the launcher is open.
