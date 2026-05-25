/**
 * Handler for the list_cluster_jewel_nodes MCP tool.
 *
 * Reads the live build's equipped jewels, filters to Cluster Jewels (Large /
 * Medium / Small), and renders a clean summary of what each cluster contributes
 * to the passive tree: total passives, sockets, the small-passive enchant
 * bonus, additional small-passive bonuses from explicit mods, and the
 * specific notables added.
 *
 * Useful for build-comparison (cluster differences are often the highest-
 * leverage build-shape changes) and DPS analysis (cluster notables are
 * frequently the highest-value stats in a build).
 */

import type { AnyLuaClient } from "../pobLuaBridge.js";
import {
  clusterInfoFromItem,
  type ClusterJewelInfo,
} from "../services/clusterJewelService.js";

export interface ClusterJewelHandlerContext {
  getLuaClient: () => AnyLuaClient | null;
  ensureLuaClient: () => Promise<void>;
}

function extractSocketId(slot: string | undefined): string | null {
  if (!slot) return null;
  const m = slot.match(/^Jewel\s+(\d+)\s*$/);
  return m ? m[1] : null;
}

/**
 * Parse a jewel's raw item text into a flat array of mod lines, dropping
 * standard header lines. The enchant line is preserved as-is (pipe-separated)
 * so the cluster parser can split it.
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
    "Crafted:",
    "--------",
  ];
  return lines.filter((l) => !skipPrefixes.some((p) => l.startsWith(p)));
}

export async function handleListClusterJewelNodes(context: ClusterJewelHandlerContext) {
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

  let items: Array<{ slot?: string; name?: string; baseName?: string; raw?: string }>;
  try {
    items = (await luaClient.getItems()) as typeof items;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error reading equipped items: ${msg}` }],
      isError: true,
    };
  }

  const clusters: ClusterJewelInfo[] = [];
  for (const item of items ?? []) {
    if (!item || !item.name) continue;
    const socketId = extractSocketId(item.slot);
    if (!socketId) continue;
    const info = clusterInfoFromItem({
      socketNodeId: socketId,
      itemName: item.name,
      baseName: item.baseName ?? "",
      modLines: jewelModLines(item.raw),
    });
    if (info) clusters.push(info);
  }

  const lines: string[] = [];
  lines.push("=== Cluster Jewel Summary ===");
  lines.push("");

  if (clusters.length === 0) {
    lines.push("No Cluster Jewels socketed in this build.");
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // Group by size for readability.
  const bySize: Record<"Large" | "Medium" | "Small", ClusterJewelInfo[]> = {
    Large: [],
    Medium: [],
    Small: [],
  };
  for (const c of clusters) bySize[c.size].push(c);

  let totalPassives = 0;
  let totalSockets = 0;
  for (const c of clusters) {
    totalPassives += c.addedPassiveCount;
    totalSockets += c.addedSocketCount;
  }
  lines.push(
    `${clusters.length} cluster jewel${clusters.length === 1 ? "" : "s"} contributing ` +
      `${totalPassives} added passive${totalPassives === 1 ? "" : "s"} ` +
      `(${totalSockets} jewel socket${totalSockets === 1 ? "" : "s"})`
  );
  lines.push("");

  for (const size of ["Large", "Medium", "Small"] as const) {
    const group = bySize[size];
    if (group.length === 0) continue;
    lines.push(`--- ${size} Cluster Jewels (${group.length}) ---`);
    for (const c of group) {
      lines.push("");
      lines.push(`• ${c.fullName}  (socket #${c.socketNodeId})`);
      const nonSocketCount = Math.max(0, c.addedPassiveCount - c.addedSocketCount);
      lines.push(
        `  Adds ${c.addedPassiveCount} passive${c.addedPassiveCount === 1 ? "" : "s"}: ` +
          `${c.notables.length} notable${c.notables.length === 1 ? "" : "s"}, ` +
          `${c.addedSocketCount} jewel socket${c.addedSocketCount === 1 ? "" : "s"}, ` +
          `${Math.max(0, nonSocketCount - c.notables.length)} small${nonSocketCount - c.notables.length === 1 ? "" : "s"}`
      );
      if (c.notables.length > 0) {
        lines.push(`  Notables: ${c.notables.join(", ")}`);
      }
      if (c.smallPassiveEnchant) {
        lines.push(`  Small-passive enchant: ${c.smallPassiveEnchant}`);
      }
      if (c.smallPassiveExplicitMods.length > 0) {
        for (const m of c.smallPassiveExplicitMods) {
          lines.push(`  Small-passive bonus: ${m}`);
        }
      }
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("PoB also stores the actual generated node entries in lua_get_tree.");
  lines.push("This tool surfaces what each cluster CONTRIBUTES at a high level —");
  lines.push("useful for build comparison, DPS analysis, and cluster shopping.");

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
