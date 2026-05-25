/**
 * Handlers for the get_tree_node MCP tool, backed by pobTreeDataLoader.
 *
 * Reads from PoB community's TreeData/{ver}/tree.lua (always-current with
 * each PoE league). See pobTreeDataLoader.ts for the underlying mechanics.
 */

import { getPobNode, getLoadedVersion, type PobNode } from "../services/pobTreeDataLoader.js";

function nodeTypeLabel(n: PobNode): string {
  if (n.isKeystone) return "Keystone";
  if (n.isJewelSocket) return "Jewel Socket";
  if (n.isMastery) return "Mastery";
  if (n.isNotable) return "Notable";
  if (n.isAscendancyStart) return "Ascendancy Start";
  if (n.ascendancyName) return "Ascendancy";
  return "Travel";
}

export async function handleGetTreeNode(
  nodeId: string,
  treeVersion?: string,
  rawJson: boolean = false
) {
  if (!nodeId) {
    return {
      content: [{ type: "text", text: "Error: node_id is required." }],
      isError: true,
    };
  }

  let node: PobNode | null;
  let resolvedVersion: string;
  try {
    resolvedVersion = getLoadedVersion(treeVersion);
    node = getPobNode(nodeId, treeVersion);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text: `Error loading PoB tree data: ${msg}\n\nNote: this tool reads from PathOfBuilding/src/TreeData/<version>/tree.lua. Ensure the PathOfBuilding submodule is checked out and POB_DIRECTORY (if set) points at a valid PoB clone.`,
        },
      ],
      isError: true,
    };
  }

  if (!node) {
    return {
      content: [
        {
          type: "text",
          text: `Node ${nodeId} not found in PoB tree data (version ${resolvedVersion}).`,
        },
      ],
    };
  }

  if (rawJson) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ version: resolvedVersion, node }, null, 2),
        },
      ],
    };
  }

  // Human-readable summary
  const label = nodeTypeLabel(node);
  const lines: string[] = [];
  lines.push(`=== Node ${nodeId}: ${node.name ?? "?"} (${label}) ===`);
  lines.push(`Source: PoB tree.lua, version ${resolvedVersion}`);
  if (node.ascendancyName) lines.push(`Ascendancy: ${node.ascendancyName}`);
  lines.push("");
  if (node.stats && node.stats.length > 0) {
    lines.push("Stats:");
    for (const s of node.stats) lines.push(`  - ${s}`);
  } else {
    lines.push("Stats: (none)");
  }
  lines.push("");
  lines.push(`Position: group=${node.group} orbit=${node.orbit} orbitIndex=${node.orbitIndex}`);
  lines.push(`Connections: in=[${(node.in ?? []).join(", ")}]  out=[${(node.out ?? []).join(", ")}]`);
  if (node.recipe && node.recipe.length > 0) {
    lines.push(`Anointment recipe: ${node.recipe.join(" + ")}`);
  }
  if (node.passivePointsGranted) {
    lines.push(`Grants ${node.passivePointsGranted} passive point(s)`);
  }
  if (node.flavourText && node.flavourText.length > 0) {
    lines.push("");
    lines.push(`Flavour: ${node.flavourText.join(" ")}`);
  }
  lines.push("");
  lines.push("Caveat: `group` field uses PoB's internal numbering, which differs");
  lines.push("from GGG's published data.json. Node IDs and connection IDs are stable");
  lines.push("across both; the group field is not. See pob-mcp/TODO.md for context.");

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
