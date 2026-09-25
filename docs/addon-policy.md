# Blizzard AddOn policy

Spec: §5 (Visibility), §6.3, §14, and §19.1 D10 of
[`architecture.md`](architecture.md).

How the Ogre MCP addon meets each rule of Blizzard's UI Add-On Development
Policy. Source:
<https://us.forums.blizzard.com/en/wow/t/ui-add-on-development-policy/24534>.

The addon is the adapter of the WoW kit, in `kits/wow/adapter/`. Players
install it as the folder `OgreMCP` (`OgreMCP.toc`). This doc was checked
against adapter version 0.2.0.

The policy has 8 rules.

| # | Rule | Status |
|---|---|---|
| 1 | Free of charge | Met |
| 2 | Code completely visible | Met |
| 3 | No negative impact on realms or other players | Met |
| 4 | No advertisements | Met |
| 5 | No donation requests in game | Met |
| 6 | No offensive material | Met |
| 7 | Follow the Terms of Use and the EULA | Met |
| 8 | Blizzard may disable add-on functionality | Accepted |

## 1. Free of charge

- The addon is free. It is one build, the same for every tier (§14, D10).
- It has no account, tier, or license check. It shows no URL, price, tier, or
  upgrade text in game (rule 4).
- The bridge is free, and so is the platform for anyone who hosts it
  (§13.3, §14). Both are open source.
- The hosted service has a free tier and a planned paid tier (§14). The paid
  tier changes only hosted-service limits: devices, tool calls per day,
  history retention, and the history tools. It never changes what the addon
  collects or writes. The public beta ships the free tier only (D5).
- The TOC `Title` ("Ogre MCP") and `Notes` name no payment, tier, or price.
  The listing text follows the same rule (§7).

## 2. Code completely visible

- The addon is plain Lua and one TOC file (`kits/wow/adapter/*.lua`,
  `kits/wow/adapter/OgreMCP.toc`). It has no build step, no minification, and
  no obfuscation. It is MIT licensed (`kits/wow/LICENSE`).
- The addon loads no code at run time. It has no `loadstring`, `load`,
  `RunScript`, or `dofile`. It looks up client functions by name, but it runs
  no text as code. It has no network access; the client gives addons none
  (§17).
- The repo is public (since 2026-09-25, §5):
  <https://github.com/bttf/ogremcp>.
- The adapter zips are built from public commits and hold the adapter files
  as committed, not minified:
  - The bridge installs the zip the platform serves (§8.2). The platform
    build zips `kits/wow/adapter/` at the commit it builds from
    (`platform/src/kits/build.ts`). The hosted platform builds from `main`.
  - The `Addon release` workflow zips the adapter at an `addon-v` tag on
    `main` with `git archive` (`.github/workflows/addon-release.yml`,
    `docs/releases.md`).
  - From P9.5, the CurseForge and Wago packagers build the listing zips from
    the same `addon-v` tags (§7).
- Git history is not rewritten. CI runs gitleaks over the full history on
  every PR (`.gitleaks.toml`, the `secrets` job in `.github/workflows/ci.yml`).

## 3. No negative impact on realms or other players

The addon reads the player's own state through client APIs and writes it to
its SavedVariables file. It sends no message to the realm or to other
players.

- No `SendAddonMessage`, no `SendChatMessage`, no channel joins. Chat output
  goes to the player's own chat frame (`DEFAULT_CHAT_FRAME:AddMessage` in
  `Transmit.lua`).
- Collection runs on a 5-second ticker (`COLLECT_INTERVAL` in
  `Collectors.lua`), because position changes fire no event. Game events
  schedule one collection 1 second out (`COLLECT_DEBOUNCE`), and further
  events before it runs coalesce into it (`Collect.lua`).
- Item details are cached per item link for the session (`Items.lua`). An
  unchanged inventory costs no item API call. Tooltip reads are skipped in
  combat and capped at 8 per collection. Item info that stays unreadable is
  asked for at most 5 times, until the item leaves the inventory and comes
  back.
- Quest text is cached per quest for the session. Empty text is retried with
  a growing delay, at most 10 times, until the quest leaves the log and comes
  back (`Collectors.lua`).
- `/transmit` reloads the UI (`ReloadUI`, else `C_UI.Reload`) so the client
  writes the file. It runs only when the player types it. The addon has no
  key binding and no other command.
- SavedVariables hold the current character's state only. Each write replaces
  the whole table (`Storage.lua`), so the file does not grow with play time.
  `recent_path` keeps at most 20 entries (`RecentPath.lua`).

## 4. No advertisements

The addon shows no advertisement and no link to a product or service. The TOC
has no URL. Apart from its TOC `Title` and `Notes` in the AddOns list, the
only text it shows is three status lines from `/transmit` (`Transmit.lua`):
two when the reload fails, and one when the client did not reload.

## 5. No donation requests in game

The addon asks for no donation, tip, or payment, in chat or in any frame.

## 6. No offensive material

The addon ships no image and no sound: its folder holds Lua files and a TOC.
Its only text is its status lines. Game text it stores (quest, item, zone,
and character names) comes from the client.

## 7. Terms of Use and EULA

- The addon does not automate play. It casts nothing, moves nothing, targets
  nothing, and presses no key. It reads state and stores it.
- Its only command is `/transmit`, which reloads the UI and changes nothing in
  the game (§1, §6.3).
- On Classic Era, reading quest text selects each quest in the quest log and
  then restores the player's selection. It does this only while the quest log
  is closed and the player is out of combat (`FetchQuestTexts` in
  `Collectors.lua`).
- To read weapon damage and speed where the client lacks `C_TooltipInfo`, the
  addon fills its own tooltip, `OgreMCPScanTooltip`. The tooltip is set with
  `ANCHOR_NONE` and no position, and is hidden after each read. `GameTooltip`
  is never touched (`Items.lua`).
- The bridge reads the SavedVariables file after the client writes it. It
  also installs the addon folder, and updates it only while the game is not
  running (§7). To tell whether the game runs, it reads the names in the
  system's process list (`bridge/internal/process`). It does not read game
  memory or inject into the client. Its only writes under the game folder
  install and update the addon.
- The MCP tools read stored snapshots and game sites, and take issue reports
  (§10). No tool can act in the game (§1).

## 8. Blizzard may disable functionality

Blizzard can change or remove any API the addon uses.

- The collectors look up each game-state API before they call it and skip
  one the client lacks (`Api` in `Collectors.lua`). A secret or out-of-range
  value reads as nil and is never written.
- Each section is collected in its own protected call. A section whose API
  fails keeps its last collected value, and the other sections are unaffected
  (`Collect.lua`).
- The interpreter reads a missing field as null (`nilable` in
  `kits/wow/interpreter/schema.ts`).

So a removed API degrades one field or one section, not the addon.
