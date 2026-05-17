# Development History

This document captures the major engineering decisions, bugs discovered, and solutions implemented during the development of pob-mcp. It's intended to give future contributors context on *why* things work the way they do.

---

## Origin (ianderse/pob-mcp fork)

Started as a fork of `ianderse/pob-mcp`. The original had a working skeleton but significant issues:
- The Lua bridge would freeze on timeout — the process died but its buffered response data would be consumed by the next request, causing silent wrong answers
- Write-back to PoB was broken
- Several handlers were missing or returning wrong field names
- No TCP/live-GUI mode

---

## Phase 1 — Bridge Stabilization

### Ghost response bug
On timeout, the old code killed the LuaJIT process but left its stdout buffer intact. The next request would read stale data from the dead process as if it were a valid response. Fixed by clearing the buffer and setting a `killed` flag on timeout, forcing a fresh process spawn.

### Missing tree version 3.28 (Mirage)
Builds saved in PoB 3.28 have `treeVersion="3_28"` which wasn't in the fork's `treeVersionList`. PoB's `Init()` returned early, leaving `self.savers` nil and crashing `export_build_xml`. Fixed by adding 3.28 to `GameVersions.lua` and copying tree data.

### `mainEnv` nil crash in `Build:Save()`
The `calcsTab.mainEnv` chain could be nil if a build hadn't been calculated yet. Added a nil guard for `mainSkillFlags` and ensured `BuildOutput()` runs before `SaveDB()`.

### Timeless Jewel crash
`DataLegionLookUpTableHelper.lua` had an `assert()` that fired when Timeless Jewel data was unavailable in headless mode. Changed to a soft return `{}` so the spec loads without jewel effects.

### `PassiveSpec:Load` throwing for all specs
One bad spec in the spec list would abort loading all specs. Wrapped `PassiveSpec:Load` in `pcall` in `TreeTab.lua`.

### Wrong field names
`list_item_sets` was using `itemSetList` — the actual fields are `itemSets` + `itemSetOrderList`. Found by reading the PoB source.

---

## Phase 2 — Upstream PR Merges

Evaluated and merged several PRs from `ianderse/pob-mcp`:
- **PR #8** — `lua_list_characters` / `lua_import_character` (live character import via PoE API)
- **PR #9, #10** — Various build handler improvements
- **PR #11** — `find_best_anointment` handler
- **PR #12** — `POE_SESSION_ID` support in trade client

---

## Phase 3 — TCP Mode (Live PoB GUI Connection)

### Architecture
Instead of spawning headless LuaJIT, connect to a running PoB GUI via a persistent TCP socket. The GUI runs the API server in its frame loop via `onFrameFuncs`. Both Claude and the user can work on the same build simultaneously.

### LuaSocket entry point mismatch
PoB ships `socket.dll` with entry point `luaopen_socket_core` (not `luaopen_socket`). `require('socket')` fails with "specified procedure could not be found." Fixed by falling back to `package.loadlib('./socket.dll', 'luaopen_socket_core')` and adding a `socket.bind()` shim since `socket.core` lacks the convenience wrapper.

### Main.lua patch placement
The TCP server initialization must be INSIDE `main:Init()` so `self.onFrameFuncs` is in scope. First version inserted AFTER the closing `end`, breaking the frame hook. Fixed regex to insert BEFORE the bare `end`: `($tcpBlock + 'end$1$2')`.

### `apiBase` path bug
`GetScriptPath()` is not defined in standard GUI mode (only headless). The fallback was `''`, making `dofile('' .. '/API/Handlers.lua')` into `/API/Handlers.lua` (absolute Unix path). Changed fallback to `'.'`.

### PoB integrity check
PoB's updater compares every file against a remote SHA1 manifest. Our `Modules/Main.lua` patch always fails this check and the console shows "integrity check failed, it will be replaced." This is expected and harmless — the TCP server is already running in memory. `LaunchPoBWithAPI.bat` re-patches on every launch, so PoB updates self-heal.

### Background frame rate — WM_TIMER vs WM_NULL
SimpleGraphic calls `GetMessageW` (blocking) when PoB loses focus, freezing the frame loop and the TCP pump. We tried `SetTimer` (WM_TIMER) first — it fires but is a low-priority synthesized message that does NOT trigger SimpleGraphic's render path. `PostMessageA(WM_NULL)` does, because it posts a real message to the queue. Solution: `LaunchSubScript` background thread posts WM_NULL every 16ms.

### Keepalive shutdown hang
The keepalive subscript ran an infinite `while true` loop. PoB waits for subscripts before exiting, so it would hang forever after the user closed PoB. Fixed with a three-part approach:
1. **Sentinel file** (`pob-api.run`) created on init, deleted by `M.stop()`
2. **`main.Shutdown` hook** — `M.init()` wraps `main.Shutdown` so `M.stop()` fires at the start of shutdown, deleting the sentinel within 16ms
3. **`RegisterSubScript`** — the subscript ID is registered via `launch:RegisterSubScript` so `OnSubFinished` doesn't crash when the subscript exits cleanly
4. **PostMessageA == 0 fallback** — detects window destruction for hard kills

### VSCode MCP config location
Claude Code's VSCode extension reads MCP servers from a **workspace-level `.mcp.json`** (not `~/.claude/mcp.json` which is for the CLI). Creating `.mcp.json` in the project root made the tools appear in the IDE.

### Auto-reconnect
When the TCP connection is lost, the MCP server retries every 2 s for up to `POB_RECONNECT_TIMEOUT_MS` (default 5 minutes). Transient errors (ECONNREFUSED, banner timeout) trigger retries; protocol errors fail immediately.

### Lua scoping bugs (repeated pattern)
Several bugs were caused by defining helper functions (`diag`, `client_count`, etc.) AFTER the public API functions that need them. In Lua, a local is only visible to code defined AFTER it in the same block. Moving helpers above `M.init()` fixed all of these.

---

## Phase 4 — Robustness & Polish

### ConPrintf console logging
All TCP API events now show in PoB's in-game console (`~` key): connect, disconnect, `>> action`, `<< action ok`, `!! action failed`. Makes it immediately visible what Claude is doing to the build.

### Any-node tree routing
The existing `find_path_to_node` seeds its BFS from all currently allocated nodes. Added `from_node_id` parameter: when provided, seeds from a single specific node instead, enabling arbitrary node-to-node routing without a build context. Output includes a type breakdown (X keystone, Y notable, Z travel).

---

## Phase 5 — Passive Tree Simulation (`get_passive_upgrades`, `suggest_masteries`)

Both tools evaluated candidates but always returned 0 results. Three independent root causes, each one hiding the next.

### Root cause 1: `calcFullDPS` runs unconditionally when passive tree tab is open

`calcs.getMiscCalculator` returns a cached `calcFunc` closure. When called, the closure checks:

```lua
if (useFullDPS ~= false or build.viewMode == "TREE") and usedFullDPS then
    calcs.calcFullDPS(...)  -- expensive: 30+ seconds for a complex build
end
```

The second branch fires whenever the user has the passive tree tab visible, regardless of `useFullDPS`. This made every `calcWith` call time out (10 s limit) when PoB was sitting on its default tab.

**Fix:** Temporarily set `build.viewMode = "CALCULATOR"` before calling `calcFunc(override, false)` and restore it after. The closure reads `build.viewMode` dynamically at call time (Lua upvalue captures the table reference, not a snapshot), so the bypass works. Passing `false` as `useFullDPS` also satisfies the `useFullDPS ~= false` half.

**Key insight:** `calcs.getMiscCalculator` runs `calcs.initEnv + calcs.perform + calcFullDPS` once to build the base, then caches a closure. `GetMiscCalculator()` (the CalcsTab method) just `unpack(self.miscCalculator)` — no rebuild. Each `calcFunc(override, false)` call with our bypass is ~0.1–1 s.

### Root cause 2: `pcall(write_line, ...)` in TcpServer.lua silently swallows JSON failures

TcpServer.lua sends responses with:

```lua
local ok3, res = pcall(handler, params)
if not ok3 then
    pcall(write_line, c.sock, { ok = false, error = ... })
else
    ConPrintf('[PoB API] << %s ok', action)
    pcall(write_line, c.sock, res)  -- ← error here is silently swallowed
end
```

`handlers.calc_with` was returning `{ ok = true, output = env.player.output }` — the raw output table from `calcs.perform`. That table contains Lua function values and userdata that dkjson cannot serialize. `json.encode` threw, `pcall` caught it, nothing was sent. TypeScript waited 10 s, timed out, killed the socket. All subsequent `calcWith` calls in the same tool invocation immediately failed on `isAlive()` check. Result: "showing top 0."

The silent `[PoB API] << calc_with ok` console message with no corresponding TypeScript response was the tell.

**Fix:** Extract only the JSON-safe scalar fields in the handler before returning:

```lua
local slim = { CombinedDPS = out.CombinedDPS, TotalDPS = out.TotalDPS, Life = out.Life, TotalEHP = out.TotalEHP, EnergyShield = out.EnergyShield }
if type(out.Minion) == 'table' then slim.Minion = { CombinedDPS = out.Minion.CombinedDPS, TotalDPS = out.Minion.TotalDPS } end
return { ok = true, output = slim }
```

**Lesson:** Any handler that returns a large PoB internal table is silently broken. Always extract scalars.

### Root cause 3: `get_mastery_options` used wrong field names

In PassiveTree.lua, mastery effect objects look like this after processing:

```lua
-- in tree.masteryEffects[effectId]:  { id = effectId, sd = processedStats }
-- on node.masteryEffects[i]:  { effect = effectId, stats = processedStats }
```

The `M.get_mastery_options` implementation used `effect.id` (nil) and `effect.sd` (nil), so every `effectId` came back as nil and every stat array was empty. The mastery node flag check was also wrong: `node.isMastery` vs the correct `node.m or node.isMastery`.

**Fix:** Use `effect.effect` for the ID, `effect.stats` for the stat text, and `(node.m or node.isMastery)` for the type check.

### Root cause 4: `calcs.initEnv` ignores `override.masteryEffects`

For mastery simulation, we tried passing `override = { masteryEffects = {[nodeId] = effectId} }` to `calcFunc`. Looking at `CalcSetup.lua`, `calcs.initEnv` handles `override.addNodes`, `override.removeNodes`, `override.spec`, `override.conditions`, and item replacement overrides — but has no code path for `masteryEffects`. The override was silently ignored; every mastery option simulated to the same DPS as the base.

**How mastery mods actually flow:** During `PassiveSpec:ImportFromNodeList`, each allocated mastery node has `node.sd = effect.sd` set from `masterySelections[nodeId]`, and `ProcessStats(node)` rebuilds `node.modList`. `calcs.initEnv` then reads `allocNodes[id].modList` when building the player's mod database.

**Fix:** For each mastery node in the override, save `node.sd` and `node.modList`, set `node.sd = effect.sd`, call `tree:ProcessStats(node)` to rebuild `modList`, call `calcFunc({}, false)`, then restore both fields. The `calcFunc({}, false)` with no override reads `allocNodes` directly, picking up the patched `modList`.

**Note:** JSON round-trips object keys as strings; mastery node IDs must be coerced back to numbers with `tonumber(k)` before looking up `allocNodes[nodeId]` or `tree.masteryEffects[effectId]`.

---

- **PoB's Lua environment**: LuaJIT 2.x, standard libs available. `os.clock()` works. `io.open` works with paths relative to the PoB install directory.
- **socket.dll**: Ships with PoB, entry point `luaopen_socket_core`. Not a standard LuaSocket install.
- **WM_TIMER vs WM_NULL**: Timer messages are synthesized and low-priority; real posted messages trigger the render loop.
- **LaunchSubScript**: Runs Lua in a background thread. Subscripts have their own Lua state (no shared globals). Communication via `OnSubCall` callbacks and files.
- **Sentinel file pattern**: Reliable cross-Lua-state signaling without shared memory. File existence = "keep running"; deletion = "stop".
