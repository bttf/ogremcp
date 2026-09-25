# WoW kit

## `manifest.json`

Notes on `adapter.process` (docs/architecture.md §6.1, §7):

- The Windows glob is `Wow*.exe`, as §6.1 shows. It matches every client the prototype matched (`Wow.exe`, `WowClassic.exe`, their test and beta builds, with or without `-64`). A manifest glob has only `*`, so a `?` would match no process (RED-319). `Wow*.exe` also matches `WowVoiceProxy.exe` and `WowError.exe`; an adapter update waits while either runs.
- The bridge matches each glob against the process's executable name and ignores case.
- The macOS glob `World of Warcraft*` also matches the WoW launcher. The owner accepted this on 2026-09-24. An adapter update waits while the launcher is open.
