# pob-mcp — Claude Code guidance

## What this project is

An MCP server that lets Claude interact with Path of Building (PoB), a build-planning tool for Path of Exile. Two modes:

- **Headless (stdio):** spawns a LuaJIT process to load build XML files and compute stats. No GUI required.
- **TCP mode** (`POB_API_TCP=true`): connects to a running PoB GUI via a TCP socket. Allows reading/writing the build the user has open in real time.

## TCP mode — background operation

PoB's TCP server runs inside PoB's GUI frame loop via `onFrameFuncs`. SimpleGraphic (PoB's renderer) calls `GetMessageW` (blocking) when PoB loses window focus, which would freeze the frame loop. To prevent this, `TcpServer.lua` launches a background subscript (`LaunchSubScript`) that posts `WM_NULL` to the PoB window every ~16 ms, keeping the message loop ticking at up to 60 fps even when PoB is in the background.

**PoB can be minimised or in the background** — the TCP server remains responsive.

**No foreground required** — PoB works fully in the background. If you see repeated connection timeouts, ask the user to verify PoB was launched via `LaunchPoBWithAPI.bat` (not directly).

### PoB console logging

Every API event is shown in PoB's in-game console (`~` key):
```
[PoB API] Claude connected (1 client(s) active)
[PoB API] >> get_stats
[PoB API] << get_stats ok
[PoB API] Claude disconnected (0 client(s) active)
```
This lets the user see exactly what Claude is doing to their build in real time.

### Shutdown

PoB exits cleanly and immediately. `TcpServer.lua` hooks `main.Shutdown` and uses a sentinel file (`pob-api.run`) to signal the keepalive subscript to stop within ~16 ms. No hung processes.

### Auto-reconnect

When the TCP connection is lost (PoB closed, crashed, or updated), the next tool call automatically retries every 2 s for up to `POB_RECONNECT_TIMEOUT_MS` (default **5 minutes / 300 s**). This means:

- **User can close and relaunch PoB mid-session** via `LaunchPoBWithAPI.bat` — the MCP client reconnects automatically.
- **PoB update/restart cycle** is handled transparently within the reconnect window.
- If PoB doesn't come back within 5 minutes, the tool returns a clear error with instructions.

`POB_RECONNECT_TIMEOUT_MS` is configurable (e.g. `600000` for 10 minutes).

### When is a fresh connection triggered?

- First call to any `lua_*` tool after the MCP server starts.
- After a timeout kills the previous connection (`bridge will auto-restart on next request`).
- After calling `lua_stop`.
- After PoB is restarted (user must relaunch via `LaunchPoBWithAPI.bat`).

## Launching PoB with the TCP server

Use `LaunchPoBWithAPI.bat` (in this repo). It:
1. Sets `POB_API_TCP=1` and `POB_API_TCP_PORT=59166` in the environment.
2. Checks whether the TCP patch is still in `Modules/Main.lua`; re-applies it if PoB updated and overwrote it.
3. Launches `Path of Building.exe`.

Normal double-clicking of the PoB executable does **not** set the env vars — the TCP server will not start.

## PoB update suppression + manual-update workflow

When the TCP API is active, our patch in `Modules/Main.lua` suppresses three PoB update UI surfaces:

1. The "Update Ready" button at the bottom-left (hidden via `applyUpdate.shown = false`)
2. The "Update Available" toast notification (suppressed by stubbing `launch.CheckForUpdate` and pre-clearing `launch.updateAvailable`)
3. The update popup (gated by the hidden button, so unreachable)

This is intentional: any of those, if triggered, would replace `Main.lua` mid-session and break the API connection. The startup banner in PoB's console (`~` key) re-states the suppression every launch.

**Tell the user to manually check for PoB updates every few weeks:**

1. Close PoB.
2. Relaunch PoB via the normal shortcut (NOT `LaunchPoBWithAPI.bat`).
3. Click *Check for Update* — apply if available.
4. Close PoB again.
5. Relaunch via `LaunchPoBWithAPI.bat` — it auto-reinstalls the patch over the updated `Main.lua`.

## PoB integrity check warnings

PoB's built-in updater compares file hashes against the remote manifest. Our patch to `Modules/Main.lua` will always fail this check, producing:

```
Warning: Integrity check on 'Modules/Main.lua' failed, it will be replaced.
```

This is expected and harmless — the TCP server is already running in memory for that session. The replacement only takes effect after a restart, at which point `LaunchPoBWithAPI.bat` re-applies the patch automatically. Tell the user to **dismiss** the update notification; clicking "Update" is fine too (the batch file self-heals on next launch).

## Build/test commands

```bash
npm run build          # compile TypeScript
npm test               # 300+ unit tests (no PoB needed)
npm test -- --forceExit  # same, force-exit to avoid open handle warnings

# Live TCP integration (PoB can be in background):
POB_API_TCP=true node tests/smoke/tcp-integration.mjs
```

## Repository layout

```
src/
  index.ts                  — MCP server entry point
  pobLuaBridge.ts           — PoBLuaApiClient (stdio) + PoBLuaTcpClient (TCP)
  server/
    luaClientManager.ts     — manages client lifecycle; detects TCP vs stdio mode
    toolSchemas.ts          — MCP tool definitions (descriptions Claude reads)
    toolRouter.ts           — dispatches tool calls to handlers
  handlers/                 — one file per feature area
  services/                 — build loading, trade API, poe.ninja, etc.

tests/
  unit/                     — Jest unit tests with mock processes/sockets
  smoke/                    — live integration scripts (need real PoB)

PathOfBuilding fork (../PathOfBuilding, branch api-stdio):
  src/API/TcpServer.lua     — non-blocking TCP server pumped by PoB's frame loop
  src/API/Handlers.lua      — maps action names to BuildOps calls
  src/API/BuildOps.lua      — all build read/write operations

Install scripts (in this repo):
  LaunchPoBWithAPI.bat      — launch PoB with TCP env vars
  InstallTcpApi.ps1         — copy API Lua files + patch Main.lua
  UninstallTcpApi.ps1       — restore Main.lua and remove API files
```

## User notifications — what to ask after key operations

Some build data cannot be retrieved from the PoE API and requires a brief conversation with the user. Proactively raise these after the relevant operations rather than waiting for the user to notice something is wrong.

### Read the Notes tab first

`lua_import_character` automatically writes an import summary to PoB's Notes tab (the `set_notes` Lua action) recording bandit choice, quest passive status, and pantheon. At the start of a session involving an imported character, call `get_build_notes` or the `get_notes` Lua action to read this — you may already have the answers and won't need to ask the user again.

### After `lua_import_character`

**1. Bandit choice (always ask)**
The PoE API does not expose bandit quest choices. After import, ask:
> "Which bandit did you choose? Kill All, Alira, Kraityn, or Oak?"

Then call `set_config` with `bandit: "None"` (Kill All) / `"Alira"` / `"Kraityn"` / `"Oak"`.

Current PoE1 values:
- **Kill All (None):** +1 passive point from the bandit quest. The second point that was historically granted here has moved to the "Through Sacred Ground" quest — confirm with the user that they've completed it.
- **Alira:** +5 Mana Regenerated per second, +15% all Elemental Resistances, +20% Critical Strike Multiplier
- **Kraityn:** +6% Attack/Cast Speed, +6% chance to Avoid Elemental Ailments, +6% Movement Speed
- **Oak:** +2% Life Regenerated per second, +20 to Maximum Life, +6% Physical Damage Reduction

**2. Quest passive points (ask if character is not at endgame)**
PoB assumes the character has all quest passive rewards. If the character is still levelling, some quest rewards may be incomplete. Ask:
> "Have you completed all the passive point quest rewards? If not, PoB's point count will be slightly higher than your actual available points."

PoE1 has 24 passive points from quests across all Acts. A character in endgame content has almost certainly completed them all.

**3. Pantheon (optional reminder)**
Pantheon major/minor god choices are not imported. Remind the user to set these in PoB's Config tab if they need accurate pantheon bonuses modelled.

### Naming convention for imported builds

When saving imported characters, use `{League}-{CharacterName}.xml` (e.g. `Mirage-MirageSixFingeredMan.xml`, `Standard-WednesdayWeatherwax.xml`). This keeps league context visible in the build list and avoids collisions between characters with the same name in different leagues.

### After `lua_set_tree` or major tree changes

Remind the user that PoB requires all allocated nodes to form a connected path back to the class start node. Nodes disconnected from the tree are silently dropped. Use `find_path_to_node` first to find the travel nodes needed to reach a target.

**Known connectivity limitation:** `lua_set_tree` uses PoB's `ImportFromNodeList` which applies stricter connectivity validation than the game itself. Some edge cases (e.g. removing an isolated keystone that is accessible in-game via the passive system but not through normal node adjacency) may result in nodes being silently dropped via the API even though they work in-game. If this happens, make the tree change directly in the PoB GUI, then use `lua_import_character` to re-sync, or use `update_tree_delta` which builds incrementally from the current connected tree.

## TCP-first principle

When a live TCP client is active (`PoBLuaTcpClient`), **always prefer TCP operations over file operations**. Reasons:

- The user can see every change in the PoB GUI in real time (console log + live build state).
- The in-memory build state may differ from the saved file (unsaved gems, config tweaks, etc.) — reading from file would give stale data.
- Writing directly to file while the build is open risks being silently overwritten when the user saves from PoB.

**In practice this means:**
- `get_build_notes` / `set_build_notes` → use `get_notes` / `set_notes` TCP actions; fall back to file only if TCP is unavailable.
- Any handler that reads build state (stats, items, tree, config) should prefer `lua_*` TCP calls over parsing the XML file from disk.
- When implementing new handlers that touch build data, check `client instanceof PoBLuaTcpClient` and route accordingly.

The file path is still always written as a persistence backup — the user may not have saved yet, or may be running headless.

## Key constraints

- **Do not modify the user's existing builds** without explicit permission. Creating test builds is fine.
- `POE_SESSION_ID` is a sensitive cookie (like a password). Never commit or log it.
- In TCP mode, `load_build_xml` and `new_build` are rejected — the user controls which build is open via the PoB GUI.
