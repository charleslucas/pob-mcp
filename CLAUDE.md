# pob-mcp — Claude Code guidance

## What this project is

An MCP server that lets Claude interact with Path of Building (PoB), a build-planning tool for Path of Exile. Two modes:

- **Headless (stdio):** spawns a LuaJIT process to load build XML files and compute stats. No GUI required.
- **TCP mode** (`POB_API_TCP=true`): connects to a running PoB GUI via a TCP socket. Allows reading/writing the build the user has open in real time.

## TCP mode — background operation

PoB's TCP server runs inside PoB's GUI frame loop via `onFrameFuncs`. SimpleGraphic (PoB's renderer) calls `GetMessageW` (blocking) when PoB loses window focus, which would freeze the frame loop. To prevent this, `TcpServer.lua` launches a background subscript (`LaunchSubScript`) that posts `WM_NULL` to the PoB window every ~16 ms, keeping the message loop ticking at up to 60 fps even when PoB is in the background.

**PoB can be minimised or in the background** — the TCP server remains responsive.

The only time you might need PoB in the foreground is if the keepalive subscript fails to start (e.g. FFI not available). If you see repeated connection timeouts, ask the user to bring PoB to the foreground once to establish the initial connection.

### Auto-reconnect

When the TCP connection is lost (PoB closed, crashed, or updated), the next tool call automatically retries the connection every 2 s for up to `POB_RECONNECT_TIMEOUT_MS` (default 30 s). This means:

- **User can close and relaunch PoB mid-session** via `LaunchPoBWithAPI.bat` — the MCP client will reconnect automatically without any manual intervention.
- **PoB update/restart cycle** is handled transparently as long as it completes within the reconnect window.
- If PoB doesn't come back within the window, the tool returns a clear error with instructions.

`POB_RECONNECT_TIMEOUT_MS` can be raised (e.g. `60000`) if PoB takes longer to start.

### When is a fresh connection triggered?

- First call to any `lua_*` tool after the MCP server starts.
- After a timeout kills the previous connection (`bridge will auto-restart on next request`).
- After calling `lua_stop`.
- After PoB is restarted (user must relaunch via `LaunchPoBWithAPI.bat`).

## Launching PoB with the TCP server

Use `LaunchPoBWithAPI.bat` (in this repo). It:
1. Sets `POB_API_TCP=1` and `POB_API_TCP_PORT=31337` in the environment.
2. Checks whether the TCP patch is still in `Modules/Main.lua`; re-applies it if PoB updated and overwrote it.
3. Launches `Path of Building.exe`.

Normal double-clicking of the PoB executable does **not** set the env vars — the TCP server will not start.

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

# Live TCP integration (requires PoB running in foreground):
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

## Key constraints

- **Do not modify the user's existing builds** without explicit permission. Creating test builds is fine.
- `POE_SESSION_ID` is a sensitive cookie (like a password). Never commit or log it.
- In TCP mode, `load_build_xml` and `new_build` are rejected — the user controls which build is open via the PoB GUI.
