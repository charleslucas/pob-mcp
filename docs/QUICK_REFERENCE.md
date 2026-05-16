# PoB MCP Server — Quick Reference

## Environment Variables

### Required
```bash
POB_DIRECTORY="/path/to/Path of Building/Builds"
```

### Lua Bridge — Headless Mode (spawns LuaJIT)
```bash
POB_LUA_ENABLED="true"
POB_FORK_PATH="/path/to/PathOfBuilding/src"   # charleslucas/PathOfBuilding, api-stdio branch
POB_CMD="luajit"                               # or full path on Windows
POB_TIMEOUT_MS="10000"                         # per-request timeout (ms); bridge auto-restarts on timeout
```

### Lua Bridge — TCP Mode (connect to running PoB GUI)
```bash
POB_LUA_ENABLED="true"
POB_API_TCP="true"                            # skip headless, connect via TCP instead
POB_API_TCP_HOST="127.0.0.1"                 # optional, loopback default
POB_API_TCP_PORT="31337"                      # optional, default port
POB_RECONNECT_TIMEOUT_MS="300000"            # how long to retry after disconnect (default 5 min)
```
Launch PoB with `LaunchPoBWithAPI.bat` (in pob-mcp repo) — sets env vars, auto-patches Main.lua, handles self-healing after updates. PoB works in background; console (~) shows all API events.

### Trade API
```bash
POE_TRADE_ENABLED="true"
POE_SESSION_ID="<32-hex-POESESSID>"           # private profiles + weighted trade queries
POE_ACCOUNT_NAME="account#1234"               # default account for lua_list_characters / lua_import_character
```

---

## Tool Quick Reference

### XML Tools (Always Available)

| Tool | Purpose |
|------|---------|
| `list_builds` | List all `.xml` build files |
| `analyze_build` | Full build analysis (class, stats, skills, items, tree) |
| `compare_builds` | Side-by-side comparison of two builds |
| `get_build_stats` | Extract specific stats from build XML |
| `get_build_notes` | Read build notes |
| `set_build_notes` | Write build notes |
| `start_watching` | Monitor builds directory for file changes |
| `stop_watching` | Stop file monitoring |
| `watch_status` | Show watcher state and cache info |
| `get_recent_changes` | List recently modified builds |
| `refresh_tree_data` | Clear passive tree data cache |

### Tree Analysis (Always Available)

| Tool | Purpose |
|------|---------|
| `compare_trees` | Show node differences between two builds |
| `get_nearby_nodes` | Find notables/keystones reachable from current allocation |
| `find_path_to_node` | Shortest path to a target node ID |
| `get_passive_upgrades` | Suggest passive tree upgrades |
| `suggest_masteries` | Suggest mastery choices for allocated clusters |

### Lua Bridge — Core (Requires `POB_LUA_ENABLED=true`)

| Tool | Purpose |
|------|---------|
| `lua_start` | Start the PoB calculation engine |
| `lua_stop` | Stop and free the engine |
| `lua_new_build` | Create a blank build for a class/ascendancy |
| `lua_load_build` | Load a build file into the engine |
| `lua_save_build` | Save in-memory build to an `.xml` file |
| `lua_reload_build` | Reload current build from disk |
| `lua_get_build_info` | Build metadata: class, level, tree version |
| `set_character_level` | Set level and recalculate all stats |
| `lua_get_stats` | Calculated stats (`category`: offense / defense / all) |
| `lua_get_tree` | View class, ascendancy, and all allocated node IDs |
| `lua_set_tree` | Replace full tree allocation |
| `update_tree_delta` | Add or remove individual nodes |
| `search_tree_nodes` | Search passive tree by name or stat text |
| `list_specs` | List all tree specs in the build |
| `select_spec` | Switch active tree spec |
| `create_spec` | Create a new tree spec |
| `delete_spec` | Delete a tree spec |
| `rename_spec` | Rename a tree spec |
| `list_item_sets` | List all item sets |
| `select_item_set` | Switch active item set |
| `get_mastery_options` | List mastery cluster options in the current tree |
| `plan_leveling` | Generate a leveling plan |
| `lua_list_characters` | List PoE account characters via the official API |
| `lua_import_character` | Import live tree/items/gems from PoE API into the loaded build |

**Class IDs**: 0=Scion 1=Marauder 2=Ranger 3=Witch 4=Duelist 5=Templar 6=Shadow

### Lua Bridge — Items & Skills

| Tool | Purpose |
|------|---------|
| `add_item` | Add item from PoE clipboard text |
| `add_multiple_items` | Add multiple items at once |
| `get_equipped_items` | List all equipped gear |
| `toggle_flask` | Activate/deactivate flask 1–5 |
| `get_skill_setup` | Show all socket groups with gems |
| `set_main_skill` | Set DPS calculation source (group/gem) |
| `create_socket_group` | Create a new socket group |
| `add_gem` | Add a gem (name, level, quality) |
| `set_gem_level` | Set gem level by group + gem index |
| `set_gem_quality` | Set gem quality type (Default/Anomalous/Divergent/Phantasmal) |
| `remove_gem` | Remove a gem |
| `remove_skill` | Remove an entire socket group |
| `setup_skill_with_gems` | Create group with active + supports in one call |
| `toggle_socket_group` | Enable or disable a socket group |
| `toggle_gem` | Enable or disable a single gem |

### Lua Bridge — Build Optimization

| Tool | Purpose |
|------|---------|
| `analyze_defenses` | 3-layer defensive audit (avoidance/mitigation/recovery) |
| `suggest_optimal_nodes` | Archetype-aware node suggestions by goal |
| `optimize_tree` | Recommend nearby nodes for a goal |
| `analyze_items` | Slot-by-slot item analysis with upgrade priorities |
| `optimize_skill_links` | Audit support gems for gaps |
| `create_budget_build` | Generate a starter build plan |
| `get_build_issues` | Prioritized list of problems and suggestions |
| `check_boss_readiness` | Evaluate boss encounter readiness |
| `suggest_watchers_eye` | Suggest Watcher's Eye mods for the build's auras |
| `find_best_anointment` | Rank all anointable notables by DPS/EHP impact |

**`suggest_optimal_nodes` goals**: `damage` `defense` `life` `es` `resist` `speed`

### Configuration & Enemy Settings

| Tool | Purpose |
|------|---------|
| `get_config` | View bandit, pantheon, enemy settings |
| `set_config` | Toggle charges, buffs, boss mode, conditions |
| `set_enemy_stats` | Set enemy level/resistances for DPS scenarios |
| `save_config_preset` | Save current config as a named preset |
| `load_config_preset` | Load a saved config preset |
| `list_config_presets` | List all saved config presets |

### Build Validation

| Tool | Purpose |
|------|---------|
| `validate_build` | Full health check — resistances, life, mana, defenses, immunities, accuracy |

Returns critical issues, warnings, and info with 0–10 health score. Uses Lua engine when available.

### Skill Gem Analysis

| Tool | Purpose |
|------|---------|
| `analyze_skill_links` | Evaluate supports and detect build archetype |
| `suggest_support_gems` | Ranked support recommendations with DPS estimates |
| `validate_gem_quality` | Find gems needing quality, awakened paths, corruption |
| `compare_gem_setups` | Side-by-side structural comparison |
| `find_optimal_links` | Best support combo for a 4/5/6-link and budget |
| `gem_upgrade_path` | Upgrade path (awakened variants, quality tiers) |

**Budget tiers**: `league_start` `mid_league` `endgame`

### Build Export & Persistence

| Tool | Purpose |
|------|---------|
| `export_build` | Copy build to a new XML file with optional notes |
| `save_tree` | Write passive tree back to an existing build file |
| `snapshot_build` | Create a versioned snapshot |
| `list_snapshots` | List all snapshots for a build |
| `restore_snapshot` | Restore from a snapshot |
| `export_build_summary` | Export a human-readable build summary |

### Currency & Market Data (poe.ninja)

| Tool | Purpose |
|------|---------|
| `get_currency_rates` | Live exchange rates (Chaos Orb equivalent) |
| `find_arbitrage` | Detect profitable currency trading loops |
| `calculate_trading_profit` | Evaluate a specific trading chain |

### Trade API (Requires `POE_TRADE_ENABLED=true`)

| Tool | Purpose |
|------|---------|
| `search_trade_items` | Search with stat/rarity filters, price, links, `online_status` |
| `get_item_price` | Price stats (min/max/median/avg) from recent listings |
| `get_leagues` | List available leagues |
| `search_stats` | Look up Trade API stat IDs |
| `find_item_upgrades` | Best upgrade candidates for your build |
| `find_resistance_gear` | Affordable gear to cap specific resistances |
| `compare_trade_items` | Compare multiple trade listings |
| `search_cluster_jewels` | Search cluster jewels by notable |
| `analyze_build_cluster_jewels` | Evaluate cluster jewel setups for a build |
| `generate_shopping_list` | Prioritized shopping list from build analysis |
| `find_weighted_trade_items` | BIS search using PoB's internal stat weights (needs `POE_SESSION_ID`) |

---

## Common Workflows

### Quick build check (XML only)
```
list_builds → analyze_build → validate_build
```

### High-fidelity stats (headless mode)
```
lua_start → lua_load_build → lua_get_stats (category: defense) → validate_build
```

### Live PoB GUI (TCP mode)
```
# Start PoB with: $env:POB_API_TCP = "1"; & "Path of Building.exe"
# Open build in PoB, then:
lua_get_stats → update_tree_delta → set_config
# Changes appear instantly in the PoB window
```

### Import live character
```
lua_start → lua_list_characters → lua_new_build → lua_import_character → lua_save_build
```

### Passive tree optimization
```
lua_load_build → suggest_optimal_nodes (goal: life) → search_tree_nodes →
update_tree_delta → lua_get_stats → lua_save_build
```

### Find best anointment
```
lua_load_build → find_best_anointment (slot: Amulet, focus: both)
```

### Weighted BIS search
```
lua_load_build → find_weighted_trade_items (league: Mirage, slot: Belt)
```

### Boss DPS scenario
```
lua_load_build → set_enemy_stats (level: 84, resistances...) →
set_config (enemyIsBoss: true) → lua_get_stats (category: offense)
```

---

## Common Stat Keys for `lua_get_stats`

| Key | Description |
|-----|-------------|
| `TotalDPS` / `CombinedDPS` | Total / combined skill DPS |
| `MinionTotalDPS` | Minion DPS (for summoner builds) |
| `Life` / `EnergyShield` / `Mana` | Pool sizes |
| `TotalEHP` | Effective hit pool |
| `Armour` / `Evasion` / `Ward` | Mitigation/avoidance ratings |
| `FireResist` / `ColdResist` / `LightningResist` / `ChaosResist` | Resistances |
| `BlockChance` / `SpellBlockChance` | Block chances |
| `EffectiveSpellSuppressionChance` | Spell suppression |
| `CritChance` / `CritMultiplier` | Crit stats |
| `Speed` | Attack/cast speed |

---

## Error Quick Guide

| Error | Cause | Fix |
|-------|-------|-----|
| `luajit command not found` | LuaJIT not installed / wrong path | Set `POB_CMD` to the full path |
| `Failed to find valid ready banner` | Wrong `POB_FORK_PATH` | Must contain `HeadlessWrapper.lua` |
| `Timed out waiting for PoB response` | Request took too long | Bridge auto-restarts; retry the call |
| `build not initialized` | No build loaded | Use `lua_load_build` first |
| `unknown action: save_build` | Old PoB fork | Update to latest `api-stdio` branch |
| HTTP 403 on character import | Private profile | Set `POE_SESSION_ID` |
| HTTP 404 on character import | Wrong account/character name | Include discriminator (account#1234) |
| HTTP 429 on trade API | Rate limited | Wait a moment and retry |
