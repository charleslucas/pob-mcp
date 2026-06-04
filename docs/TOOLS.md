# pob-mcp — Tool Reference

MCP server for Path of Building. All tools are prefixed `mcp__pob__` in the Claude context.

---

## Build File Tools

| Tool | Description |
|------|-------------|
| `list_builds` | List all available PoB build XML files |
| `analyze_build` | Full build analysis: stats, skills, gear, keystones, archetype, suggestions |
| `compare_builds` | Compare two builds side by side |
| `compare_trees` | Show allocated node differences between two build trees |
| `get_build_stats` | Extract specific stats (Life, DPS, resistances, etc.) from a build file |
| `get_build_notes` | Read notes from a build's Notes tab |
| `set_build_notes` | Write/overwrite notes in a build's Notes tab |
| `export_build` | Copy a build to a new XML file |
| `save_tree` | Write tree changes from the Lua bridge back to an XML file |
| `snapshot_build` | Create a versioned backup snapshot of a build |
| `list_snapshots` | List all snapshots for a build |
| `restore_snapshot` | Restore a build from a snapshot |
| `export_build_summary` | Generate a shareable markdown summary of the loaded build |

---

## File Watching

| Tool | Description |
|------|-------------|
| `start_watching` | Watch the builds directory for changes |
| `stop_watching` | Stop watching |
| `watch_status` | Check if watching is active |
| `get_recent_changes` | List recently modified build files |
| `refresh_tree_data` | Force-refresh the passive tree data cache |

---

## Character Import

| Tool | Description |
|------|-------------|
| `lua_list_characters` | List characters on a PoE account via the official API (no bridge needed) |
| `lua_import_character` | Import a character's gear, gems, and tree into the loaded build |

---

## Lua Bridge — Connection & Build Lifecycle

These require the Lua bridge (`lua_start`) and, in TCP mode, a running PoB GUI launched via `LaunchPoBWithAPI.bat`.

| Tool | Description |
|------|-------------|
| `lua_start` | Start the headless Lua engine or connect to the PoB GUI via TCP |
| `lua_stop` | Disconnect/stop the Lua bridge |
| `lua_load_build` | Load a build file (TCP: opens it in the GUI) |
| `lua_new_build` | Create a blank build with a given class/ascendancy |
| `lua_close_build` | Close the current build and return to the PoB build list (TCP only) |
| `lua_save_build` | Save the in-memory build to disk |
| `lua_reload_build` | Reload the current build from disk |
| `lua_get_build_info` | Get build name, level, class, ascendancy, tree version |

---

## Lua Bridge — Stats & Tree

| Tool | Description |
|------|-------------|
| `lua_get_stats` | Get calculated stats (offense, defense, or all categories) |
| `get_stat_breakdown` | Explain WHY a stat has its value — tabulates every contributing modifier with source attribution (passive node names, items, config), grouped by BASE/INC/MORE/OVERRIDE/FLAG, plus the aggregate inc-sum/more-product (inc-vs-more diagnosis). `stat` is PoB's internal CamelCase mod name — resistances use the short form (`FireResist`/`ColdResist`/`LightningResist`/`ChaosResist`), attributes are `Str`/`Dex`/`Int`. Default (global) is complete for unconditional stats; pass `use_skill_config: true` to tabulate the MAIN skill's modList+config and capture skill-conditional mods (`Damage`, `FireDamage`, `AttackSpeed`, `CritChance`, …) with sources. Per-modifier attribution — for the whole damage pipeline use `get_calc_breakdown`. |
| `get_calc_breakdown` | Show PoB's OWN computed breakdown for an output stat — the Calcs-tab multiplier chain (base→added→conversion→increased→more→crit→ailment→total), relayed verbatim from the CALCS env (no math re-derived). The "why is my damage this number / which bucket is weak" view. `stat` is an output-stat key (`AverageDamage`, `TotalDPS`, `Speed`, `CritChance`, …); call with no stat to list the stats that currently have a breakdown (build-dependent). Complement to `get_stat_breakdown` (pipeline vs source attribution). |
| `lua_get_tree` | Get the current passive tree node allocation |
| `lua_set_tree` | Replace the full passive tree (all nodes must be connected to class start) |
| `update_tree_delta` | Add or remove specific nodes; auto-paths to connect them |
| `search_tree_nodes` | Search tree nodes by name or stat keyword |
| `get_nearby_nodes` | Find notable/keystone passives near the current tree |
| `plan_tree_paths` | Plan minimum combined node cost to reach multiple target notables; merges shared path prefixes and returns a combined node list for `lua_set_tree` |
| `find_path_to_node` | Find shortest passive path to a target node (or between any two nodes) |

---

## Passive Tree — Per-Node Data & Patches

Tools sourced from PoB community's `tree.lua` (always-current with each PoE league) and the community-fork `data_patches.json` overlay for the rare cases where even PoB's data is wrong. See `reference_data/skilltree/PATCHES.md` for the overlay protocol.

| Tool | Description |
|------|-------------|
| `get_tree_node` | Look up a single passive node's name, stats, type, position, and in/out connections from PoB tree.lua. Replaces ad-hoc Python BFS on `data.json` for single-node "what does this give me?" queries. |
| `get_tree_node_patch` | Read the current patch entry (if any) for a single node from `data_patches.json`. |
| `report_tree_node_discrepancy` | Record a verified correction to a node's stats. Writes to the skilltree fork's `data_patches.json` overlay; stamps the patch with today's date. Use ONLY after the verification protocol in PATCHES.md (notably: confirm the node is not jewel-transformed). |
| `list_tree_patches` | Audit the current patches with filters by source and age. Useful for finding stale entries after a GGG export refresh. |

---

## Passive Tree — Jewel Awareness

Comprehensive coverage of how socketed jewels affect the passive tree. Built on top of `pobTreeDataLoader` and the shared `radiusUtils` infrastructure.

| Tool | Description |
|------|-------------|
| `find_jewel_affected_nodes` | Identify which allocated nodes are being transformed by socketed Timeless Jewels (Lethal Pride, Glorious Vanity, Militant Faith, Brutal Restraint, Elegant Hubris). Reports per-jewel: which historic character is doing the transformation and which nodes are in radius. Phase-1 indicator tool. |
| `get_tree_node_with_timeless_jewels` | Return a single node's stats including any Timeless Jewel transformation. Reads PoB's already-computed post-transformation `node.sd` via the `get_node_state` Lua action — no game-data extraction or template rendering needed. Phase-2 of Timeless-Jewel awareness. |
| `evaluate_threshold_jewels` | Evaluate each socketed jewel's "With at least N <Attribute> in Radius" thresholds against the current tree allocation. Reports triggered/not-triggered with margin. Useful for jewel shopping (e.g., would this Brawn fit my tree?). |
| `list_cluster_jewel_nodes` | Summarize what each socketed Cluster Jewel (Large/Medium/Small) contributes — total passives, jewel sockets, small-passive enchant, notable list, additional bonuses. Cluster differences are often the biggest build-shape divergences in build comparisons. |
| `list_radius_effect_jewels` | Catch the long tail of "in Radius" uniques that aren't Timeless or threshold jewels — Energy From Within, Healthy Mind, Fertile Mind, Might of the Meek, Brute Force Solution, etc. Categorizes each (transform / grant / multiplier / other) and lists allocated nodes in the jewel's radius. |

---

## Atlas Tree Analysis

Read-only lookups against the atlas tree data in `reference_data/atlastree/`. Minimal parity with the passive-tree tools — atlas allocation isn't visible to the public PoE API, so there's no "from build frontier" pathing and no jewel-awareness layer (the atlas has no jewel-affects-nodes mechanic).

| Tool | Description |
|------|-------------|
| `get_atlas_node` | Look up a single atlas node by ID; returns name, stats, type, position, and in/out connections. Supports `default`/`league`/`ruthless`/`ruthless-league` variants. |
| `search_atlas_nodes` | Keyword/stat-text search of atlas nodes with optional type filter (notable, keystone, jewel, mastery, wormhole, ascendancy, normal). Useful for finding all atlas notables tied to a mechanic. |
| `find_atlas_path_to_node` | BFS shortest path between two atlas nodes. Requires both `target_node_id` and `from_node_id` since the atlas tree's allocated state isn't API-visible. |

---

## Crafting — Structured Mod Lookup

Concrete-numbers complement to `suggest_crafting` (which produces poedb-derived strategic advice). Sourced from PoB community data: `ModItem.lua` (natural mods), `Data/Bases/*.lua` (981 equipment bases), `ModMaster.lua` (bench crafts), `Essence.lua` (essences). Parsed once and cached; auto-reloads on submodule update.

| Tool | Description |
|------|-------------|
| `search_crafting_mods` | Search PoB's mod table with combinable filters: stat-text keyword, item-tag chain (e.g. `["body_armour","armour","str_armour"]` for an Astral Plate), Prefix/Suffix, ilvl range, mod group (conflict key), mod tags, affix name. Returns actual roll ranges, levels, mod groups, and per-tag spawn weights. |
| `list_craftable_mods_for_base` | Given a base name (e.g. `Astral Plate`, `Hubris Circlet`, `Sapphire Ring`) and optional ilvl, dump the entire craftable space for that base — every prefix and suffix that can roll, grouped by mod-group with the highest tier first. The tool reads the base's tag chain from `Data/Bases/` automatically and applies PoE's first-match-wins weight resolution per group. Output is split PREFIXES / SUFFIXES with `tiers_per_group` controlling how many tiers per group to show (default 1 = top tier only). |
| `analyze_item_mods` | Identify each mod line on an existing item and report its tier + next-tier upgrade. Two input modes: `mod_lines` (paste the item's explicit prefix/suffix text, one per entry) **or** `item_slot` (read a live equipped item straight from the open PoB build over TCP — e.g. 'Body Armour', 'Ring 1' — auto-deriving base_name + ilvl). For each line: matched mod ID, affix name, mod group, tier rank (e.g. T3 of 13), and the next tier's required ilvl + value range. Matches by stripping the rolled value and finding the tier whose range contains it; prefers affixed/naturally-rollable mods over Hellscape/influence range-overlaps. `{crafted}` lines match the bench-craft pool (ModMaster.lua); `{fractured}` the natural pool; `{enchanted}` reported but not indexed. Collapses hybrid-mod continuation lines. |
| `search_master_crafts` | Search the bench (master) craft pool (`Data/ModMaster.lua`) — deterministic mods addable at the crafting bench. Filters: `stat_contains`, `item_type` (PoE TYPE name like 'Body Armour'/'Ring'), `type` (Prefix/Suffix), `has_tags`. Answers "what can I bench-craft on this slot?". |
| `get_essence_detail` | Inspect essences (`Data/Essence.lua`). Mode 1: `essence_name` → exactly what mod that essence guarantees on each item type (resolved to real stat text from ModItem.lua). Mode 2: `stat_contains` → which essences provide that stat and on which item types. Answers "what does this essence guarantee?" and "which essences give +Life?". |
| `calculate_mod_odds` | Probability of hitting target mods when rolling a base, from the game's real spawn weights. Targets by `stat` keyword or `group`, optional `min_tier`. Methods: `chaos` (rare reroll, 3/3 slots), `alt` (magic 1/1), `essence` (forced mod pre-placed). Exact group-level without-replacement model; reports per-target weight share, P(prefix/suffix targets), combined probability, and ≈ rerolls (1/P). Does NOT model fossils/harvest/meta-crafts/affix-count variance/currency cost — for those use Craft of Exile. |

---

## Lua Bridge — Specs & Item Sets

| Tool | Description |
|------|-------------|
| `list_specs` | List all passive tree specs in the build |
| `select_spec` | Switch the active spec |
| `create_spec` | Create a new spec (optionally copy from existing) |
| `delete_spec` | Delete a spec |
| `rename_spec` | Rename a spec |
| `list_item_sets` | List all item sets |
| `select_item_set` | Switch the active item set |

---

## Lua Bridge — Gems & Skills

| Tool | Description |
|------|-------------|
| `get_skill_setup` | Show current gem groups (default: main DPS group only) |
| `set_main_skill` | Set which socket group is used for DPS calculations |
| `create_socket_group` | Create a new gem socket group |
| `add_gem` | Add a gem to a socket group |
| `set_gem_level` | Set a gem's level |
| `set_gem_quality` | Set a gem's quality |
| `set_gem_quality` | Set a gem's quality and quality type |
| `remove_gem` | Remove a gem from a socket group |
| `remove_skill` | Remove an entire socket group |
| `toggle_gem` | Enable/disable a specific gem |
| `toggle_socket_group` | Enable/disable an entire socket group |
| `setup_skill_with_gems` | Create a complete skill + supports in one call |

---

## Lua Bridge — Items & Flasks

| Tool | Description |
|------|-------------|
| `add_item` | Add an item from in-game clipboard text |
| `add_multiple_items` | Add multiple items at once |
| `get_equipped_items` | Get all equipped items with mod lines |
| `toggle_flask` | Enable/disable a flask |
| `set_character_level` | Set character level |

---

## Lua Bridge — Configuration

| Tool | Description |
|------|-------------|
| `get_config` | View current charges, conditions, enemy, and buff settings |
| `set_config` | Modify configuration (charges, conditions, bandit, pantheon, etc.) |
| `set_enemy_stats` | Configure the enemy for DPS calculations (map boss, Shaper, Maven, etc.) |
| `save_config_preset` | Save current config as a named preset |
| `load_config_preset` | Restore a saved config preset |
| `list_config_presets` | List all saved presets |

---

## Validation & Diagnostics

| Tool | Description |
|------|-------------|
| `validate_build` | Comprehensive check: resistances, life, defenses, mana, accuracy, flask immunities, DPS scaling (prefer over `get_build_issues` + `analyze_defenses` combined) |
| `get_build_issues` | Quick scan for critical issues (uncapped resists, low life, mana over-reservation) |
| `analyze_defenses` | Deep dive into defensive layers: EHP, suppression, evasion, block, armour, regen |
| `check_boss_readiness` | Check if the build meets thresholds for a specific endgame boss |

---

## Optimization & Suggestions

| Tool | Description |
|------|-------------|
| `get_passive_upgrades` | Simulate every unallocated notable and rank by actual DPS/EHP gain |
| `suggest_masteries` | Simulate every mastery effect option and rank by DPS/EHP impact |
| `find_best_anointment` | Rank all ~400 anointable notables by simulated DPS/EHP impact |
| `suggest_optimal_nodes` | AI-suggested passive node picks based on build goals |
| `optimize_tree` | Remove inefficient nodes and reallocate to better options |
| `analyze_items` | Evaluate gear and suggest improvements |
| `analyze_skill_links` | Evaluate current supports and identify synergy issues |
| `suggest_support_gems` | Ranked support gem recommendations for the build archetype |
| `optimize_skill_links` | Auto-generate best support gem combo for a skill |
| `find_optimal_links` | Find best supports within a budget |
| `gem_upgrade_path` | Shopping list for gem levels, quality, and Exceptional upgrades |
| `compare_gem_setups` | Compare multiple gem configurations |
| `validate_gem_quality` | Check gems for missing quality and Exceptional upgrade opportunities |
| `suggest_watchers_eye` | Recommend Watcher's Eye mods based on active auras |
| `suggest_crafting` | Recommend crafting method for a gear slot |
| `analyze_build_cluster_jewels` | Evaluate which cluster jewel notables synergize with the build |
| `plan_leveling` | Generate act-by-act leveling guide with gem progression and lab timing |
| `create_budget_build` | Create a league-start/budget-friendly version of a build |
| `find_item_upgrades` | Describe what to look for when upgrading a gear slot |

---

## Trade API

Require `POE_TRADE_ENABLED=true`. **All search tools return a clickable trade URL + total count (ExileExchange pattern) — they do not fetch listing details. User opens the URL in their browser.**

| Tool | Description |
|------|-------------|
| `search_trade_items` | Search the PoE trade site with filters; returns trade URL + total count |
| `find_weighted_trade_items` | Find upgrades using PoB's weighted-search engine (real DPS/EHP impact); returns trade URL + total count |
| `compare_trade_items` | Compare two trade item searches; returns trade URLs |
| `get_item_price` | Price check: named/unique items via poe.ninja (no GGG call); rare items return a trade URL |
| `get_leagues` | List active PoE leagues (raw trade-API passthrough) |
| `get_active_leagues` | League status with parent-league mapping and stale-`POE_LEAGUE` warning; pairs with `playbooks/league-transition.md` |
| `search_stats` | Look up trade stat/mod IDs by keyword |
| `search_cluster_jewels` | Search for cluster jewels with specific enchants/notables |
| `generate_shopping_list` | Prioritized gear upgrade shopping list within a budget |

---

## poe.ninja & Currency

Require `POE_TRADE_ENABLED=true`.

| Tool | Description |
|------|-------------|
| `get_currency_rates` | Current currency exchange rates from poe.ninja |
| `find_arbitrage` | Identify profitable currency trading loops |
| `calculate_trading_profit` | Calculate profit/loss for a specific trading chain |
