# pob-mcp — Future Work

## Console Bidirectional Communication

Register a custom `claude` console command in PoB using SimpleGraphic's `ConRegisterFunc` (or equivalent) in `TcpServer.lua`. When the user types `claude <message>` in PoB's in-game console (`~` key), the message is queued. A new MCP action `poll_console_messages` returns any queued messages, allowing Claude to see notes the user typed directly from PoB.

**Approach:**
- `ConRegisterFunc("claude", handler)` in TcpServer.lua to capture typed commands
- Store in a Lua table queue
- New Lua action `poll_console_messages` returns and clears the queue
- Claude calls it at the start of each session or periodically via `start_watching`

**Use case:** User types `claude this build feels squishy, can you fix defenses` without switching windows.

---

## Any-Node-to-Any-Node Tree Routing (`find_path_between_nodes`)

The current `find_path_to_node` seeds its BFS from all **currently allocated** nodes, so it finds the cheapest connection from the existing build frontier to the target. Useful for "how do I reach node X?" but can't answer "what is the path between two arbitrary unallocated nodes?"

**Proposed change:** Add an optional `from_node_id` parameter to `find_path_to_node`. When provided, the BFS is seeded from that single node rather than the build's allocation. This allows:
- Route between any two nodes regardless of current build
- Measure distance between keystones ("how many nodes separate RT and IR?")
- Plan paths across disconnected parts of the tree

**Implementation:** Three lines in `treeHandlers.ts` + schema update (see below). Everything else reuses the existing BFS in `treeService.findShortestPaths`.

**Information returned per node in path:**
- Node ID and name
- Type: Keystone / Notable / Small (travel) / Jewel Socket / Mastery / Ascendancy
- Full stat lines (mod descriptions)
- Ascendancy name if applicable
- Path summary: total nodes, notable/keystone count, travel node count

**Schema change:**
```typescript
// Add to find_path_to_node inputSchema:
from_node_id: {
  type: "string",
  description: "Route from this specific node ID instead of the build's allocated frontier. Enables any-node-to-any-node routing independent of the current build."
}
```

**Handler change (`treeHandlers.ts`):**
```typescript
// When from_node_id is provided, override allocatedNodes:
if (fromNodeId) {
  allocatedNodes = new Set([fromNodeId]);
}
```

---

## Skilltree Patches MCP Tools — ✅ SHIPPED

**Status:** `get_tree_node`, `report_tree_node_discrepancy`, `list_tree_patches`, and `get_tree_node_patch` are all live (commits `fac7c93` and `b246376`). Pivoted away from the original "GGG data + overlay" plan to sourcing structural data from PoB community's `tree.lua` (via `luaparse`), with the patches overlay reserved for the rare edge cases where even PoB is wrong.

Service modules: `src/services/pobTreeDataLoader.ts`, `src/services/skilltreePatchesService.ts`.
Handlers: `src/handlers/pobTreeDataHandlers.ts`, `src/handlers/skilltreePatchesHandlers.ts`.
Schemas + routing in `src/server/`. 21 new unit tests, 416 tests total.

The Endurance-leech example from earlier in this doc turned out to be a Lethal Pride Karui transformation, not a stale-export miss — see `legal_considerations.md` and the journal entry in MirageSixFingeredMan's `journal.md` for the full debugging trail. PATCHES.md inside the skilltree fork captures the verification protocol (the blank-line tooltip convention and the controlled-removal test) that catches this kind of error.

### Original spec (preserved below for reference)

### Tool 1: `get_tree_node`

Returns merged node data with provenance.

**Input:**
```typescript
{
  node_id: string  // e.g. "11730"
}
```

**Output:**
```typescript
{
  node_id: string,
  name: string,
  stats: string[],                    // merged stats
  in: string[],                       // adjacency (from data.json, never patched)
  out: string[],
  flags: {                            // isNotable, isKeystone, isJewelSocket, isMastery, ascendancyName
    is_notable: boolean,
    is_keystone: boolean,
    is_jewel_socket: boolean,
    is_mastery: boolean,
    ascendancy_name: string | null
  },
  source: "ggg" | "patched" | "pob",  // where the final data came from
  patch_metadata?: {                  // present only when source === "patched"
    verified_from: string,
    verified_date: string,
    verified_by: string,
    note?: string
  },
  ggg_pob_disagree?: boolean          // true if PoB's bundled data has different stats than GGG export — likely indicates stale GGG
}
```

**Behavior:**
1. Load `reference_data/skilltree/data.json` (cached in memory).
2. Load `reference_data/skilltree/data_patches.json` if it exists.
3. If the node has a patch entry, apply `stats_add` / `stats_replace` / `name_replace` / `flags_set` per the rules in `PATCHES.md`. Set `source = "patched"`.
4. Otherwise, optionally cross-check against PoB's bundled tree data (`PathOfBuilding/src/TreeData/`). If PoB has different stats than GGG, set `ggg_pob_disagree = true` so Claude knows to verify with the user.
5. Return the merged result.

### Tool 2: `report_tree_node_discrepancy`

Writes a new patch entry (or updates an existing one) in `data_patches.json`.

**Input:**
```typescript
{
  node_id: string,
  operation: "stats_add" | "stats_replace" | "name_replace",
  value: string | string[],          // shape depends on operation
  verified_from: "in-game tooltip" | "PoB tree data" | "PoB lua_get_passive_detail" | "wiki" | "reddit/forum",
  verified_by: string,                // account handle or "Claude"
  note?: string
}
```

**Behavior:**
1. Read existing `data_patches.json` (empty object if file missing).
2. If `node_id` already has an entry, merge intelligently — usually the new operation supersedes the old one. Preserve `verified_date` history if helpful.
3. Set `verified_date` to today's date.
4. Write back atomically.
5. Return the updated entry for the node.

### Implementation notes

- Both tools should live in `src/handlers/treeHandlers.ts` (or a new `passiveDataHandlers.ts`).
- File I/O is sync at startup, async per-request for the patch file (it's small).
- Cache `data.json` in memory at server startup; reload patches on every `report_tree_node_discrepancy` call.
- Add schemas to `src/server/toolSchemas.ts`.
- Add a small fixture test that round-trips a patch through both tools.

### Why this is worth doing

Right now, when a Claude session does tree analysis via inline Python, it must remember to merge patches itself — and the patches file may not even exist yet. With these tools:
- Claude calls `get_tree_node` instead of writing inline Python for the common single-node lookup.
- When Claude or the user notices a stat that doesn't match in-game, Claude calls `report_tree_node_discrepancy` and the patch lands automatically.
- Future sessions inherit the verified data with zero protocol to remember.

Inline Python via Bash is still appropriate for *topology* analysis (pendant detection, BFS, connectivity checks) — that work is too varied to schema cleanly. These tools cover the high-frequency "what does this node give me?" path.

### Open question

Whether to expose a third tool, `list_tree_patches`, that returns all current patches with their metadata — useful for periodically auditing what's been verified, what's stale, and what could be submitted upstream to GGG. Probably worth including in the initial implementation.

---

## Game Data Extraction Pipeline (data.json from local PoE install)

This is the larger sibling of the patches MCP tool. Instead of patching GGG's published `data.json`, generate it directly from the user's local PoE install — always current with the installed game version. The patches overlay becomes a fallback for rare edge cases rather than the primary correction mechanism. The architectural reasoning is in `reference_data/skilltree/legal_considerations.md`.

### What's already validated (proof-of-concept in `data-extraction-poc/`, gitignored)

- **`pathofexile-dat` (npm) works.** Installed via `npm install pathofexile-dat`. Config-driven extraction from a local Steam PoE install. Verified extracting:
  - `PassiveSkills.datc64` → JSON: 5,592 rows with `Id`, `Name`, `Stats` (foreignrow[] -> Stats), `Stat1Value`..`Stat5Value`, `IsNotable`, `IsKeystone`, `IsJewelSocket`, `IsAscendancyStartingNode`, `AscendancyKey`, `MasteryGroup`, `PassiveSkillGraphId`.
  - `Stats.datc64` → JSON: stat-ID definitions (the indices the `Stats` field references).
  - `AlternatePassiveSkills.datc64` → Timeless Jewel transformation rules (per jewel type, per node size).
  - `AlternatePassiveAdditions.datc64` → additive transformations like Lethal Pride's `+2 to Strength`.
  - `AlternateTreeVersions.datc64` → which Timeless Jewel is which.
  - `PassiveJewelRadii.datc64` → radius per jewel-type ID.
  - `PassiveSkillTrees.datc64` → which graph (.psg) file goes with each tree (default tree, atlas, royale, etc.).
  - `Metadata/StatDescriptions/passive_skill_stat_descriptions.txt` → text rendering templates.
- **`Metadata/PassiveSkillGraph.psg`** (binary, 76 KB) extracted via pathofexile-dat. Contains tree topology.
- **dat-schema** (community-maintained at `poe-tool-dev/dat-schema`) is the source of truth for column schemas. Downloaded as `data-extraction-poc/poe-schema.json`. 1,401 tables defined.

### PSG parser: deprecated approach

Initial plan was to parse `Metadata/PassiveSkillGraph.psg` directly. We started porting PoB's `src/Export/psg.lua` to TypeScript. Hit format drift: PSG header is now 10 bytes (not 7 as PoB documents) and per-group records grew beyond the documented schema. Then we discovered **PoB community itself has abandoned `psg.lua`** — the 3.28 tree commit (`fcae41cb`) added `tree.lua` directly without touching any Export tools. PoB devs have an offline workflow we don't have access to.

**Better path discovered: use PoB's `tree.lua` directly.** See next section. The partial PSG parser in `data-extraction-poc/psg-parser.mjs` is kept as a reference but won't be the production approach.

### The actual path forward: parse PoB's tree.lua

PoB community maintains `PathOfBuilding/src/TreeData/{ver}/tree.lua` (~2.9 MB Lua table per PoE version, updated each league via PR). The schema is **identical to GGG's published data.json** — same readable field names (`name`, `stats`, `group`, `orbit`, `orbitIndex`, `isNotable`, etc.), same node structure, same in/out connection format.

**Proof-of-concept in `data-extraction-poc/tree-from-pob.mjs`** already validates this end-to-end:

- Parses `PathOfBuilding/src/TreeData/3_28/tree.lua` (~2.9 MB) in ~70 ms using `luaparse` (npm)
- Emits 1.4 MB JSON matching GGG's data.json schema
- Spot-check on node 11730 "Endurance" — every field matches GGG's published version EXCEPT `group` (PoB uses 109, GGG uses 136 — they use different internal group numbering).
- Pipeline: `tree.lua` → luaparse AST → JS object → minor coercion (empty Lua tables → empty arrays) → JSON.

**Known difference: group renumbering.** PoB reassigns group IDs in their own order. Node IDs are stable across both, but `groups` indexing differs. Workarounds:
- Build a remapping table: for each PoB group, look up which node IDs it contains, find those IDs in GGG's data.json, derive the corresponding GGG group ID.
- Or: accept PoB's numbering and document the difference (tools doing group-by-group analysis would need to use the PoB-flavored output consistently).

**Why this is better than bundle extraction:**
- No Oodle DLL dependency (lighter, more portable)
- No `.datc64` schema maintenance (those schemas drift, PoB's tree.lua schema is stable)
- No PSG binary parsing
- No stat description rendering (PoB already did it; stats arrive pre-rendered)
- PoB ships the data publicly — using it is provably safer than direct extraction (see `reference_data/skilltree/legal_considerations.md`)

**Trade-off:** depends on PoB community keeping `tree.lua` current. They typically update within days of each PoE league launch (the 3.28 update landed within ~3 weeks of game release). If we need data faster than PoB ships, we'd fall back to extraction. For the vast majority of cases, PoB's pace is sufficient.

### Recommended implementation

A new module `pob-mcp/src/services/treeDataLoader.ts` that:
1. Reads `PathOfBuilding/src/TreeData/{POE_VERSION}/tree.lua` from the submodule (use `POE_VERSION` env var or default to latest dir alphabetically).
2. Uses `luaparse` (npm) to parse the Lua table → JS object.
3. Coerces empty Lua `{}` tables to `[]` for fields known to be arrays (`stats`, `in`, `out`, etc.).
4. Caches the parsed result in memory keyed by version + file mtime.
5. Provides a `getNode(nodeId)` API for the MCP tool layer.

Total: probably 200-300 lines including the Lua-to-JS conversion (which we've already validated in the PoC).

The `get_tree_node` MCP tool described earlier in this doc then layers on top: it reads from `treeDataLoader` (always-current PoB data), falls back to GGG's published `data.json` if PoB hasn't updated yet, and applies `data_patches.json` overrides on top for edge cases.

### Full pipeline once PSG is parsed

1. `pathofexile-dat` extracts `.datc64` tables and `passive_skill_stat_descriptions.txt`.
2. PSG parser reads `PassiveSkillGraph.psg` → groups, node positions, in/out edges.
3. Merge: each `PassiveSkillGraphId` from the table joins with its PSG-side entry (orbit, orbitIndex, in/out, group).
4. Stat description resolver: for each node's `Stats` field, look up the stat name in `Stats.json`, then apply the template from `passive_skill_stat_descriptions.txt` with `Stat1Value`..`Stat5Value` to produce the rendered string.
5. Emit a JSON file in GGG's `data.json` format (same schema, same field names).

Output goes to the fork's `data.json`. Anyone running the extraction can refresh the fork; the fork stays as a shareable cache + cross-platform fallback for users without PoE installed.

### What stays runtime-only (per `legal_considerations.md`)

These get extracted and used in-memory but are **never committed to any public repo**:
- `passive_skill_stat_descriptions.txt` (the raw template file)
- `AlternatePassiveSkills.datc64` / `AlternatePassiveAdditions.datc64` (Timeless Jewel transformations)
- `Mods.datc64`, `BaseItemTypes.datc64`, `SkillGems.datc64`, and other content-rich tables
- Art, audio, anything from `Bundles2/Art/` or `Bundles2/Audio/`

The data.json that *is* committed to the fork contains the same kinds of fields GGG already publishes in their export (structure + names + integer stat values + rendered stat strings via the templates).

### Timeless-Jewel-aware MCP tool (downstream of extraction) — NEXT MEATY FEATURE

The "no more user tooltip pastes for Timeless Jewel transformations" goal.

**Scope clarification:** this layer is specifically for **Timeless Jewels** (Lethal Pride, Glorious Vanity, Militant Faith, Brutal Restraint, Elegant Hubris) — the only jewel type whose effects appear *as transformed stats inside a passive node's tooltip*. Other jewel types (Cluster, Threshold, "effect in radius" uniques) need different tools — see the **Comprehensive jewel-awareness roadmap** section below.

**Why this is the next priority:** the current `get_tree_node` tool returns PoB's base data, which is what GGG publishes. Any in-game tooltip on a node within a Timeless Jewel's radius will differ from this (we caught the Endurance case earlier this week). Today the only way to verify is to ask the user for the in-game tooltip. The Timeless-Jewel-aware tool eliminates that round-trip.

**Proposed tool:** `get_tree_node_with_timeless_jewels(node_id, build_name?)` — returns the node's stats *as transformed by the build's socketed Timeless Jewels*.

**Building blocks needed (in dependency order):**

1. **Game-data extractor service** (new module, ~150-200 lines).
   - Wrapper around `pathofexile-dat` (already validated in `data-extraction-poc/`).
   - Spawns the CLI in a user-local cache dir (suggest `pob-mcp/.cache/jewel-data/` — gitignored per `legal_considerations.md`).
   - Extracts on first use, cached thereafter keyed by PoE install mtime.
   - Tables to extract: `AlternatePassiveSkills`, `AlternatePassiveAdditions`, `PassiveJewelRadii`, `Stats`, `AlternateTreeVersions`, `LegionFactions`.
   - Files to extract: `Metadata/StatDescriptions/passive_skill_stat_descriptions.txt`.
   - **Per `legal_considerations.md`:** these go to user-local cache only, NEVER to any committed repo. Add `pob-mcp/.cache/` to `.gitignore`.

2. **Seed-to-historic-character resolver** (~50 lines).
   - Each Timeless Jewel type has 5 historic characters keyed by seed range.
   - Lethal Pride (Karui): Akoya/Kaom/Rakiata/etc. by seed range.
   - Glorious Vanity (Vaal), Militant Faith (Templar), Brutal Restraint (Maraketh), Elegant Hubris (Eternal).
   - Algorithm is well-documented publicly. Hardcode the mapping table.

3. **Radius check** (~30 lines).
   - Get the jewel socket's group position (use existing `pobTreeDataLoader.ts`).
   - Get the candidate node's group position.
   - Compute Euclidean distance vs the jewel's radius (Small=800, Medium=1200, Large=1500 — confirmable via `PassiveJewelRadii`).
   - Note: actual node position = group center + orbit offset; for first-cut, group-center distance is a good enough approximation.

4. **Transformation engine** (~100 lines).
   - For (jewel_type, historic_character, node_size, node_id), look up the replacement in `AlternatePassiveSkills`.
   - Additions: look up in `AlternatePassiveAdditions`.
   - Apply: replace or append to the node's `stats` array.

5. **Stat description template renderer** (~200-400 lines, the hardest piece).
   - `passive_skill_stat_descriptions.txt` is a domain-specific template file with conditionals, ranges, plural forms, and value substitutions.
   - Community parsers exist (PyPoE has one, PoB has Lua logic). Worth porting from PoB's `src/Modules/StatDesc.lua` rather than RE'ing.
   - **Alternative shortcut:** for jewel-transformed nodes, look up the rendered stat from PoB's `tree.lua` for nodes in the AlternatePassiveSkills table. This avoids reimplementing the template engine for the common case. Falls back to template rendering only for nodes PoB hasn't pre-rendered (rare).

6. **MCP tool wiring** (~50 lines).
   - Schema, handler, router case.
   - Output: the node's stats with a "jewel-modified" marker indicating which jewel and historic character is transforming it.

**Estimated effort:** 1-2 focused days. The template renderer (item 5) is the longest single piece; the rest is straightforward integration.

**Open architectural decision:** the game-data extractor introduces a new dependency layer (pathofexile-dat + Oodle DLL from the user's PoE install). Options:
- (a) Add as a pob-mcp dep; ship the suite with everything needed in one place. Heavier suite.
- (b) Build as a separate sibling package (`game-data-extractor/`) that pob-mcp shells out to. Cleaner separation, more files.
- (c) Make extraction optional — only the jewel-aware tool requires it; `get_tree_node` keeps working without.

Recommend (c): keep the existing tools dependency-free, gate the new feature on whether the cache has been populated. Surface a clear "run the extractor once" instruction in the tool description.

### Why this matters (re-stated for clarity)

- Patches workflow becomes mostly vestigial: extraction is always current with the user's install, so the canonical `data.json` is always right.
- "Ask the user for a tooltip paste" becomes unnecessary: the Timeless-Jewel-aware tool computes transformations programmatically.
- Forks stay valuable as **cross-platform caches** (anyone without PoE installed can still use the suite).
- The work isolates cleanly: extraction pipeline first, Timeless-Jewel-aware tool second. Both are well-bounded.

---

## Comprehensive jewel-awareness roadmap (long-term)

The Timeless-Jewel-aware tool above is the *first* piece of a broader goal: making the suite fully aware of how every socketed jewel in a build affects the passive tree. Any comprehensive tree analysis (tree-analysis.md, build-comparison.md, dps-analysis.md) will eventually need this. The four pieces, in priority order:

### 1. Timeless-Jewel-aware tool — `get_tree_node_with_timeless_jewels`
Scoped in detail above. Transforms per-node tooltips for jewels in Lethal Pride / Glorious Vanity / Militant Faith / Brutal Restraint / Elegant Hubris radii. **First because it's the only category that misleads Claude about what a node actually provides.**

### 2. Threshold-Jewel evaluator — `evaluate_threshold_jewels(build_name?)`
Threshold jewels (Brawn, Lethal Assault, Inertia, Conqueror's Efficiency, etc.) apply a *global* effect conditional on having a specific amount of an attribute or particular notables within the jewel's radius. They don't change node tooltips, but they *do* turn on or off based on the surrounding tree state.

Tool behavior:
- Read the build's socketed jewels.
- For each Threshold Jewel, find its socket position and radius.
- Sum the relevant attribute (or count the relevant notables) in radius.
- Report: "Brawn at socket 26196 requires +40 Strength in radius; currently +30 — NOT triggered, missing 10 Str."

Useful for jewel shopping ("would this fit in my tree?") and for diagnosing missing build effects ("you think you have +6% inc Reservation Efficiency from Conqueror's Efficiency, but the threshold isn't met").

Data needed: just `data.json` (to look up node positions and attribute values in radius) + the unique jewel's mod text (already in the build's item data). No `pathofexile-dat` extraction required — this is implementable today on top of `get_tree_node`.

**Estimated effort:** half a day.

### 3. Cluster-Jewel node surfacer — `list_cluster_jewel_nodes(build_name?)`
Cluster Jewels (Large/Medium/Small) generate entirely new passive nodes inside their socket area when allocated. PoB already computes these — the tool's job is just to surface them in a clean format so other tools (and Claude) can reason about them.

Tool behavior:
- Read the build's allocated cluster jewels and their generated passives.
- Report each cluster's notables, smalls, jewel sockets, and the small-passive-text enchant (e.g., "Added Small Passive Skills also grant 4% increased Cold Damage").
- For each generated notable, show its full stats (already rendered by PoB).

Useful for build-comparison.md (cluster differences are huge build-shape changes) and dps-analysis.md (cluster notables are often the highest-leverage stats).

Data needed: the build's live state via `lua_get_tree` and `get_equipped_items`. No extraction required.

**Estimated effort:** quarter to half a day.

### 4. Radius-effect-unique resolver — `compute_radius_buffs(build_name?)`
A grab-bag of unique jewels that modify the effective stats of allocated nodes in radius without changing the tooltip text. Examples: certain stats reading "Allocated Passives in radius also grant X% increased Y", Forbidden Power variants, Watchstones-as-jewels, etc.

Tool behavior:
- Read the build's socketed jewels.
- Identify those with "in radius" mod patterns.
- For each, compute which allocated nodes are in radius and what the effective bonus is.

Data needed: just the build's live state + a small dictionary of known "in radius" jewels and their mod patterns. The dictionary itself is small and can live in code.

**Estimated effort:** half a day, mostly cataloging which uniques have these mechanics.

### Cross-cutting infrastructure

Items 1-4 all share a need for a **`radiusUtils.ts`** helper:
- `getRadiusForJewel(jewelType)` — Small=800, Medium=1200, Large=1500.
- `getNodePosition(nodeId)` — group center + orbit offset (uses existing `pobTreeDataLoader`).
- `nodesInRadius(jewelSocketId, radius)` — returns node IDs within distance.
- `sumAttributeInRadius(jewelSocketId, radius, attribute)` — totals Strength/Dex/Int from allocated nodes in radius.

Build this helper once, share across all four jewel-aware tools. Probably ~150 lines.

### Suggested implementation order

1. `radiusUtils.ts` — foundation. ~150 lines.
2. Item 1 (Timeless-Jewel-aware) — highest payoff. ~1-2 days including the extraction wrapper.
3. Item 2 (Threshold evaluator) — easy win, no extraction needed. ~half day.
4. Item 3 (Cluster-Jewel surfacer) — also easy. ~quarter to half day.
5. Item 4 (Radius-effect uniques) — harder to scope (lots of edge cases). ~half day plus ongoing additions as new uniques surface.

Total for full jewel-awareness: roughly **3-4 focused days**. Each tool is independently shippable.
