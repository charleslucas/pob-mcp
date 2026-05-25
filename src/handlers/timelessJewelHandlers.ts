/**
 * Handler for the Timeless-Jewel-aware analysis tool.
 *
 * Phase-1 scope: identify WHICH allocated nodes are being transformed by the
 * build's socketed Timeless Jewels. Does NOT yet render the per-node
 * transformed stats — that requires the game-data extraction pipeline
 * documented in pob-mcp/TODO.md.
 *
 * Useful as-is: when Claude sees an in-game tooltip that doesn't match the
 * data from `get_tree_node`, this tool answers "is this node being
 * transformed by a jewel?" — preventing false patch reports (the Endurance
 * leech case from 2026-05-25).
 */

import type { AnyLuaClient } from "../pobLuaBridge.js";
import {
  findAffectedNodes,
  type JewelSocketInfo,
} from "../services/timelessJewelService.js";
import { getPobNode } from "../services/pobTreeDataLoader.js";

export interface TimelessJewelHandlerContext {
  getLuaClient: () => AnyLuaClient | null;
  ensureLuaClient: () => Promise<void>;
}

/**
 * Parse a jewel's raw item text into a flat array of mod lines.
 * Skips the "Rarity:", "Implicits:", and other header lines, keeping just
 * the stat lines we care about for pattern matching.
 */
function jewelModLines(rawItemText: string | undefined): string[] {
  if (!rawItemText) return [];
  const lines = rawItemText.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const skipPrefixes = [
    "Rarity:",
    "Implicits:",
    "Item Level:",
    "LevelReq:",
    "Sockets:",
    "Quality:",
    "Selected Variant:",
    "Has Variants:",
    "Unique ID:",
    "--------",
  ];
  return lines.filter((l) => !skipPrefixes.some((p) => l.startsWith(p)));
}

/**
 * Extract the jewel socket node ID from a slot string like "Jewel 26196".
 * Returns null if the slot doesn't look like a tree-jewel slot.
 */
function extractSocketId(slot: string | undefined): string | null {
  if (!slot) return null;
  const m = slot.match(/^Jewel\s+(\d+)\s*$/);
  return m ? m[1] : null;
}

export async function handleFindJewelAffectedNodes(
  context: TimelessJewelHandlerContext
) {
  await context.ensureLuaClient();
  const luaClient = context.getLuaClient();
  if (!luaClient) {
    return {
      content: [
        {
          type: "text",
          text: "Error: PoB Lua client not initialized. Use `lua_start` or `lua_load_build` first.",
        },
      ],
      isError: true,
    };
  }

  let items: Array<{ slot?: string; name?: string; raw?: string; id?: number }>;
  let treeRaw: { nodes?: number[] };
  try {
    items = (await luaClient.getItems()) as typeof items;
    treeRaw = (await luaClient.getTree()) as typeof treeRaw;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error reading build state: ${msg}` }],
      isError: true,
    };
  }

  const allocatedNodes = new Set<string>(
    (treeRaw?.nodes ?? []).map((n) => String(n))
  );

  // Collect equipped jewels with parseable socket node IDs.
  const equippedJewels: JewelSocketInfo[] = [];
  for (const item of items ?? []) {
    if (!item || !item.name) continue;
    const socketId = extractSocketId(item.slot);
    if (!socketId) continue;
    equippedJewels.push({
      socketNodeId: socketId,
      jewelName: item.name,
      mods: jewelModLines(item.raw),
    });
  }

  const result = findAffectedNodes(equippedJewels, allocatedNodes);

  // Format output
  const lines: string[] = [];
  lines.push("=== Timeless Jewel Transformation Analysis ===");
  lines.push("");

  if (result.timelessJewels.length === 0) {
    lines.push("No Timeless Jewels socketed in this build.");
    lines.push("");
    lines.push("(Looked at jewels: " + equippedJewels.map((j) => `${j.jewelName} @ ${j.socketNodeId}`).join(", ") + ")");
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  lines.push(`Found ${result.timelessJewels.length} Timeless Jewel(s):`);
  for (const tj of result.timelessJewels) {
    const j = tj.jewel;
    const socketNode = getPobNode(tj.socketNodeId);
    const socketLabel = socketNode
      ? `${socketNode.name ?? "Jewel Socket"} (#${tj.socketNodeId})`
      : `socket #${tj.socketNodeId}`;
    lines.push("");
    lines.push(`• ${j.jewelType} — seed ${j.seed}, leader: ${j.historicCharacter}`);
    lines.push(`  Socket: ${socketLabel}`);
    lines.push(`  Radius: ${j.radius} units (${j.radiusClass})`);
    lines.push(`  Affected ALLOCATED nodes: ${tj.affectedAllocated.length}`);
    if (tj.affectedAllocated.length > 0) {
      const names = tj.affectedAllocated.slice(0, 30).map((id) => {
        const n = getPobNode(id);
        return n ? `${id} (${n.name ?? "?"})` : id;
      });
      lines.push(`    ${names.join(", ")}${tj.affectedAllocated.length > 30 ? ` ... +${tj.affectedAllocated.length - 30} more` : ""}`);
    }
    lines.push(`  Also affecting ${tj.affectedUnallocated.length} unallocated nodes in radius (not listed).`);
  }

  // Per-node summary if any nodes are affected
  const nodeIds = Object.keys(result.byNode);
  if (nodeIds.length > 0) {
    lines.push("");
    lines.push("=== Per-node summary (allocated only) ===");
    lines.push("");
    for (const nodeId of nodeIds.slice(0, 50)) {
      const rec = result.byNode[nodeId];
      const node = getPobNode(nodeId);
      const nodeLabel = node
        ? `${nodeId} (${node.name ?? "?"}${node.isNotable ? ", Notable" : node.isKeystone ? ", Keystone" : ""})`
        : nodeId;
      const jewels = rec.affectingJewels
        .map((aj) => `${aj.jewel.jewelType}/${aj.jewel.historicCharacter}`)
        .join(", ");
      lines.push(`• ${nodeLabel} ← ${jewels}`);
    }
    if (nodeIds.length > 50) {
      lines.push(`... +${nodeIds.length - 50} more affected nodes`);
    }
  }

  lines.push("");
  lines.push("---");
  lines.push("⚠ Phase-1 scope: this tool identifies WHICH nodes are being");
  lines.push("transformed but does NOT yet render the transformed stats. For");
  lines.push("specific transformations, paste the in-game tooltip (it differs");
  lines.push("from `get_tree_node` output by the jewel's effect). Phase-2 will");
  lines.push("add programmatic transformation rendering via game-data extraction");
  lines.push("(see pob-mcp/TODO.md \"Comprehensive jewel-awareness roadmap\").");
  lines.push("");
  lines.push("This tool's primary value today: when a tooltip discrepancy shows");
  lines.push("up, this tool tells you whether to attribute it to a jewel (no");
  lines.push("patch needed) or to a stale data source (patch may be warranted).");

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
