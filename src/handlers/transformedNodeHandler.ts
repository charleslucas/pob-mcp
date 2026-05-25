/**
 * Handler for the get_tree_node_with_timeless_jewels MCP tool.
 *
 * Returns a single node's stats as PoB currently has them — which means with
 * Timeless Jewel transformations applied if the node is in a jewel's radius.
 * Uses the `get_node_state` Lua action, which reads the post-transformation
 * `node.sd` from PoB's PassiveSpec.
 *
 * This is the Phase-2 piece for jewel awareness: where find_jewel_affected_nodes
 * tells you WHICH nodes are transformed, this tool tells you WHAT they
 * transform into — without needing tooltip pastes, game-data extraction, or a
 * stat-template renderer. PoB has already done the work; we just expose it.
 */

import type { AnyLuaClient } from "../pobLuaBridge.js";

export interface TransformedNodeHandlerContext {
  getLuaClient: () => AnyLuaClient | null;
  ensureLuaClient: () => Promise<void>;
}

interface NodeStateResult {
  id: number;
  dn?: string;
  type?: string;
  allocated?: boolean;
  sd?: string[];
  conqueredBy?: { seed?: number; conqueror_type?: string };
  ascendancyName?: string;
}

const CONQUEROR_TO_JEWEL: Record<string, string> = {
  karui: "Lethal Pride",
  vaal: "Glorious Vanity",
  templar: "Militant Faith",
  maraketh: "Brutal Restraint",
  eternal: "Elegant Hubris",
};

export async function handleGetTreeNodeWithTimelessJewels(
  context: TransformedNodeHandlerContext,
  nodeId: string
) {
  if (!nodeId) {
    return {
      content: [{ type: "text", text: "Error: node_id is required." }],
      isError: true,
    };
  }
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

  let node: NodeStateResult;
  try {
    node = (await luaClient.getNodeState({ node_id: nodeId })) as NodeStateResult;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error reading node state: ${msg}` }],
      isError: true,
    };
  }

  if (!node) {
    return {
      content: [{ type: "text", text: `Node ${nodeId} not found.` }],
    };
  }

  const lines: string[] = [];
  const dn = node.dn ?? "?";
  const typeLabel = node.type ? node.type.charAt(0).toUpperCase() + node.type.slice(1) : "?";
  lines.push(`=== Node ${node.id}: ${dn} (${typeLabel}) ===`);
  if (node.ascendancyName) lines.push(`Ascendancy: ${node.ascendancyName}`);
  lines.push(`Allocated: ${node.allocated ? "yes" : "no"}`);

  if (node.conqueredBy) {
    const jewelType =
      (node.conqueredBy.conqueror_type &&
        CONQUEROR_TO_JEWEL[node.conqueredBy.conqueror_type.toLowerCase()]) ||
      "Timeless Jewel";
    lines.push(
      `Transformed by: ${jewelType}` +
        (node.conqueredBy.seed ? ` (seed ${node.conqueredBy.seed})` : "")
    );
  }

  lines.push("");
  lines.push("Stats (as PoB currently renders them):");
  if (node.sd && node.sd.length > 0) {
    for (const line of node.sd) lines.push(`  - ${line}`);
  } else {
    lines.push("  (none)");
  }

  if (!node.conqueredBy) {
    lines.push("");
    lines.push(
      "Note: this node is NOT being transformed by a Timeless Jewel — the stats above " +
        "match the base data. For a jewel-transformed view, call this tool on a node " +
        "inside a Timeless Jewel's radius (see `find_jewel_affected_nodes`)."
    );
  } else {
    lines.push("");
    lines.push(
      "These stats already include the Timeless Jewel transformation — no tooltip " +
        "paste needed. Source: PoB's PassiveSpec, post-transformation."
    );
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
