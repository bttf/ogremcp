# WoW kit

## `manifest.json`

Notes on `adapter.process` (docs/architecture.md §6.1, §7):

- The Windows globs are `WowClassic*.exe`, for the Classic clients and their test and beta builds with or without `-64`, and the retail names `Wow.exe`, `WowT.exe`, and `WowB.exe`, each with or without `-64`. They replace the §6.1 example's `Wow*.exe`, which also matches the WowUp addon manager (`WowUp.exe`, `WowUpCf.exe`). WowUp often stays open in the tray, so under `Wow*.exe` a staged adapter update would never apply.
- A manifest glob has only `*`. A `?` would match no process, and the bridge and the SDK schema reject it (RED-319).
- The bridge matches each glob against the process's executable name and ignores case.
- The macOS glob `World of Warcraft*` also matches the WoW launcher. The owner accepted this on 2026-09-24. An adapter update waits while the launcher is open.
