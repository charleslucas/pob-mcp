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
