# Path of Building MCP Server — Roadmap

## What's Implemented

All originally planned phases are complete. The server provides 99 tools across 10 categories.

### ✅ File Watching
Real-time detection of builds saved from PoB, with debouncing and automatic cache invalidation.

### ✅ Enhanced Parsing
Full extraction of passive tree, jewels, flasks, items, skills, and configuration from PoB XML.

### ✅ Validation & Optimization
- Build validation with severity classification and 0–10 health score
- Archetype-aware node suggestions
- Gem link analysis and support recommendations
- Defensive layer analysis (avoidance / mitigation / recovery)

### ✅ Lua Bridge — Headless Calculation Engine
Spawns PoB's Lua engine in headless mode (stdio JSON-RPC), giving Claude access to the same calculation engine the PoB GUI uses. Supports:
- Full stat recalculation after any change
- Passive tree editing (full replace or delta add/remove)
- Multi-spec builds and item sets
- Gem and item management
- Config and enemy settings

**Stability fixes shipped:**
- Auto-restart on timeout (ghost-response buffer corruption fix)
- 3.28 (Mirage) tree data + Timeless Jewel graceful degradation
- `export_build_xml` / `save_build` fully working
- All missing handlers implemented (list_specs, select_spec, get_mastery_options, etc.)

### ✅ Trade API Integration
- Stat-filter search, price checking, BIS candidate finder, resistance gear finder
- `find_weighted_trade_items`: uses PoB's internal `TradeQueryGenerator` engine to rank items by real DPS/EHP impact for the loaded build
- `find_best_anointment`: evaluates all ~400 anointable notables via PoB's MiscCalculator

### ✅ Character Import
- `lua_list_characters`: fetches PoE account character list via the official API
- `lua_import_character`: imports tree, jewels, items, and skill gems from a live character with a before/after stat diff

---

## What's Next

### TCP Mode — Connect to Running PoB GUI

The current Lua bridge spawns a separate *headless* PoB process. A TCP mode would instead connect to a **running PoB GUI** launched with `POB_API_TCP=1`, enabling:

- Changes made via Claude appear live in the PoB window
- No need to manage a separate LuaJIT process
- Bi-directional: Claude can read from and write to the build currently open in PoB

**Implementation plan:**
1. Merge `TcpServer.lua` from `ianderse/dev` into the `api-stdio` branch of the PoB fork
2. Implement `PoBLuaTcpClient` in `pobLuaBridge.ts` (same JSON-RPC protocol, TCP transport)
3. Add `POB_API_TCP=true` env var to `LuaClientManager` to select TCP vs stdio mode
4. Launch PoB with: `$env:POB_API_TCP = "1"; & "Path of Building.exe"`

**Effort estimate:** 2–3 days

### poe.ninja League Data

Automatically detect the current league name from poe.ninja so users don't need to type it.

### PoE Wiki Integration

Look up item descriptions, skill gem details, and passive node flavour text from the wiki.

### Build Sharing

Generate shareable PoB links (pobb.in / poe.ninja builder) from the loaded build.

---

## Known Limitations

- **Gem modifications not persisted to GUI**: `add_gem`, `set_gem_level`, `set_gem_quality` changes are in the headless engine's memory and are written by `lua_save_build`, but the PoB GUI won't show them unless you reload the file in PoB. This is inherent to the headless architecture and is resolved by TCP mode.
- **Timeless Jewel effects**: the binary LUT data for Timeless Jewels (LethalPride, etc.) cannot be decompressed in headless mode (no zlib). The build loads correctly but node replacements from socketed Timeless Jewels are skipped.
- **3.28 tree data**: the `api-stdio` fork ships with 3.27 tree data copied as a 3.28 placeholder. New 3.28-specific nodes (if any) will calculate using 3.27 data until official 3.28 data is integrated.
