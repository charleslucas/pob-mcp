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

## Skilltree Patches MCP Tool (`get_tree_node`, `report_tree_node_discrepancy`)

GGG's published skilltree export (`reference_data/skilltree/data.json`) lags real game state. Stats change between patches without the export being re-tagged. Today, ad-hoc Python scripts that read `data.json` see stale stats — e.g. node 11730 "Endurance" is missing its `0.4% of Attack Damage Leeched as Life` line as of 3.28.0 export.

The full overlay protocol is documented in `reference_data/skilltree/PATCHES.md`. This task implements the MCP surface for it.

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
