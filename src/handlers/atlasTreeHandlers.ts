/**
 * Atlas tree analysis handlers.
 *
 * Three tools backed by atlasTreeDataLoader:
 *   get_atlas_node          — single-node lookup (parallels get_tree_node)
 *   search_atlas_nodes      — keyword/stat-text search (parallels search_tree_nodes)
 *   find_atlas_path_to_node — BFS shortest path (parallels find_path_to_node)
 *
 * Scope difference from the passive tree tools: atlas state isn't accessible
 * via PoE's public API, so we can't read the "currently allocated" atlas
 * frontier from a character. find_atlas_path_to_node therefore requires an
 * explicit `from_node_id` argument — no "from build frontier" mode.
 */

import {
  getAtlasTreeData,
  getAtlasNode,
  type AtlasNode,
  type AtlasVariant,
} from "../services/atlasTreeDataLoader.js";

function nodeTypeLabel(n: AtlasNode): string {
  if (n.isKeystone) return "Keystone";
  if (n.isJewelSocket) return "Jewel Socket";
  if (n.isMastery) return "Mastery";
  if (n.isAtlasWormhole) return "Wormhole";
  if (n.isNotable) return "Notable";
  if (n.ascendancyName) return "Ascendancy";
  return "Travel";
}

function variantArg(input: unknown): AtlasVariant {
  if (typeof input !== "string") return "default";
  if (
    input === "default" ||
    input === "league" ||
    input === "ruthless" ||
    input === "ruthless-league"
  ) {
    return input;
  }
  return "default";
}

// ---------------------------------------------------------------------------
// get_atlas_node
// ---------------------------------------------------------------------------

export async function handleGetAtlasNode(
  nodeId: string,
  variant: AtlasVariant = "default",
  rawJson: boolean = false
) {
  if (!nodeId) {
    return {
      content: [{ type: "text", text: "Error: node_id is required." }],
      isError: true,
    };
  }
  let node: AtlasNode | null;
  try {
    node = getAtlasNode(nodeId, variant);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text: `Error loading atlas tree data: ${msg}\n\nNote: this tool reads from reference_data/atlastree/data.json. Ensure the atlastree submodule is checked out.`,
        },
      ],
      isError: true,
    };
  }
  if (!node) {
    return {
      content: [{ type: "text", text: `Atlas node ${nodeId} not found (variant: ${variant}).` }],
    };
  }
  if (rawJson) {
    return {
      content: [
        { type: "text", text: JSON.stringify({ variant, node }, null, 2) },
      ],
    };
  }
  const lines: string[] = [];
  lines.push(`=== Atlas Node ${nodeId}: ${node.name ?? "?"} (${nodeTypeLabel(node)}) ===`);
  lines.push(`Variant: ${variant}`);
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
  if (node.flavourText && node.flavourText.length > 0) {
    lines.push("");
    lines.push(`Flavour: ${node.flavourText.join(" ")}`);
  }
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// ---------------------------------------------------------------------------
// search_atlas_nodes
// ---------------------------------------------------------------------------

export async function handleSearchAtlasNodes(
  query: string,
  nodeType?: string,
  limit: number = 30,
  variant: AtlasVariant = "default"
) {
  if (!query || query.trim().length === 0) {
    return {
      content: [{ type: "text", text: "Error: query is required." }],
      isError: true,
    };
  }
  const tree = getAtlasTreeData(variant);
  const lq = query.toLowerCase();
  const typeFilter = nodeType && nodeType.toLowerCase() !== "any" ? nodeType.toLowerCase() : null;

  function classifyNode(n: AtlasNode): string {
    if (n.isKeystone) return "keystone";
    if (n.isJewelSocket) return "jewel";
    if (n.isMastery) return "mastery";
    if (n.isAtlasWormhole) return "wormhole";
    if (n.isNotable) return "notable";
    if (n.ascendancyName) return "ascendancy";
    return "normal";
  }

  const matches: Array<{ id: string; node: AtlasNode; type: string }> = [];
  for (const [id, node] of Object.entries(tree.nodes)) {
    if (matches.length >= limit) break;
    const t = classifyNode(node);
    if (typeFilter && t !== typeFilter) continue;
    const name = (node.name ?? "").toLowerCase();
    const statText = (node.stats ?? []).join(" ").toLowerCase();
    if (name.includes(lq) || statText.includes(lq)) {
      matches.push({ id, node, type: t });
    }
  }

  const lines: string[] = [];
  lines.push(`=== Atlas Tree Search ===`);
  lines.push(`Variant: ${variant}  |  query: "${query}"  |  type filter: ${typeFilter ?? "any"}`);
  lines.push(`Found ${matches.length} matching node${matches.length === 1 ? "" : "s"}` + (matches.length >= limit ? ` (limit ${limit} hit)` : "") + ":");
  for (const m of matches) {
    lines.push("");
    lines.push(`**${m.node.name ?? "?"}** [${m.type.toUpperCase()}] (node ${m.id})`);
    if (m.node.stats && m.node.stats.length > 0) {
      for (const s of m.node.stats) lines.push(`  - ${s}`);
    }
  }
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// ---------------------------------------------------------------------------
// find_atlas_path_to_node
// ---------------------------------------------------------------------------

export async function handleFindAtlasPathToNode(
  targetNodeId: string,
  fromNodeId: string,
  variant: AtlasVariant = "default"
) {
  if (!targetNodeId) {
    return {
      content: [{ type: "text", text: "Error: target_node_id is required." }],
      isError: true,
    };
  }
  if (!fromNodeId) {
    return {
      content: [
        {
          type: "text",
          text:
            "Error: from_node_id is required. The atlas tree has no API-visible 'allocated' state per character, so this tool only does fixed-source-to-fixed-target pathing — pass the source node ID explicitly.",
        },
      ],
      isError: true,
    };
  }

  const tree = getAtlasTreeData(variant);
  const source = tree.nodes[fromNodeId];
  const target = tree.nodes[targetNodeId];
  if (!source) {
    return {
      content: [{ type: "text", text: `Source node ${fromNodeId} not found in atlas tree.` }],
      isError: true,
    };
  }
  if (!target) {
    return {
      content: [{ type: "text", text: `Target node ${targetNodeId} not found in atlas tree.` }],
      isError: true,
    };
  }
  if (fromNodeId === targetNodeId) {
    return {
      content: [{ type: "text", text: "Source and target are the same node." }],
    };
  }

  // BFS over the undirected graph (combine in + out as neighbors).
  const visited = new Set<string>([fromNodeId]);
  const queue: Array<{ id: string; path: string[] }> = [{ id: fromNodeId, path: [fromNodeId] }];
  let found: string[] | null = null;
  while (queue.length > 0) {
    const { id, path } = queue.shift()!;
    if (id === targetNodeId) {
      found = path;
      break;
    }
    const node = tree.nodes[id];
    if (!node) continue;
    const neighbors = new Set([...(node.in ?? []), ...(node.out ?? [])]);
    for (const nb of neighbors) {
      if (visited.has(nb)) continue;
      visited.add(nb);
      queue.push({ id: nb, path: [...path, nb] });
    }
  }

  const lines: string[] = [];
  lines.push(`=== Atlas Path: ${fromNodeId} → ${targetNodeId} ===`);
  lines.push(`Variant: ${variant}`);
  if (!found) {
    lines.push(`No path found between these nodes.`);
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
  lines.push(`Total cost: ${found.length - 1} passive point${found.length === 2 ? "" : "s"}`);
  lines.push(`Nodes in path: ${found.length}`);
  lines.push("");
  for (let i = 0; i < found.length; i++) {
    const n = tree.nodes[found[i]];
    const label = n ? `${n.name ?? "?"} [${nodeTypeLabel(n)}]` : "?";
    const marker = i === 0 ? "FROM" : i === found.length - 1 ? "→ TARGET" : "    ↓";
    lines.push(`  ${marker}: ${found[i]} — ${label}`);
    if (n && n.stats && n.stats.length > 0 && (i === 0 || i === found.length - 1)) {
      for (const s of n.stats) lines.push(`        ${s}`);
    }
  }
  return { content: [{ type: "text", text: lines.join("\n") }] };
}
