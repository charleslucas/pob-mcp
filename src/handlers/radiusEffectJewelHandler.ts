/**
 * Handler for the list_radius_effect_jewels MCP tool.
 *
 * Catches the long tail of "in Radius" jewels that aren't Timeless and aren't
 * attribute thresholds — Energy From Within, Healthy Mind, Fertile Mind,
 * Might of the Meek, Brute Force Solution, etc. Reports each one's radius
 * mods, the allocated nodes in radius, and a best-effort category label so
 * the caller can quickly judge what kind of effect is in play.
 */

import type { AnyLuaClient } from "../pobLuaBridge.js";
import {
  findRadiusEffectJewels,
  type JewelSocketInfo,
} from "../services/radiusEffectJewelService.js";
import { getPobNode } from "../services/pobTreeDataLoader.js";

export interface RadiusEffectJewelHandlerContext {
  getLuaClient: () => AnyLuaClient | null;
  ensureLuaClient: () => Promise<void>;
}

function extractSocketId(slot: string | undefined): string | null {
  if (!slot) return null;
  const m = slot.match(/^Jewel\s+(\d+)\s*$/);
  return m ? m[1] : null;
}

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

export async function handleListRadiusEffectJewels(
  context: RadiusEffectJewelHandlerContext
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

  let items: Array<{ slot?: string; name?: string; raw?: string }>;
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

  const jewels: JewelSocketInfo[] = [];
  for (const item of items ?? []) {
    if (!item || !item.name) continue;
    const socketId = extractSocketId(item.slot);
    if (!socketId) continue;
    jewels.push({
      socketNodeId: socketId,
      jewelName: item.name,
      mods: jewelModLines(item.raw),
    });
  }

  const result = findRadiusEffectJewels(jewels, allocatedNodes);

  const lines: string[] = [];
  lines.push("=== Radius-Effect Jewel Scan ===");
  lines.push("");
  lines.push(
    `Scanned ${result.jewelsScanned} jewel${result.jewelsScanned === 1 ? "" : "s"}; ` +
      `${result.jewelsWithRadiusEffects} carry radius-based effects ` +
      "(excluding Timeless Jewels and attribute thresholds — those have dedicated tools)."
  );

  if (result.jewels.length === 0) {
    lines.push("");
    lines.push("None found. The build's jewels either don't have radius mods,");
    lines.push("or all radius mods are already handled by:");
    lines.push("  - find_jewel_affected_nodes (Timeless Jewel transformations)");
    lines.push("  - evaluate_threshold_jewels (attribute thresholds)");
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  lines.push("");
  for (const j of result.jewels) {
    const socketNode = getPobNode(j.socketNodeId);
    const socketLabel = socketNode
      ? `${socketNode.name ?? "Jewel Socket"} (#${j.socketNodeId})`
      : `socket #${j.socketNodeId}`;
    lines.push(`• ${j.jewelName} @ ${socketLabel}  [radius ${j.radius}]`);
    for (const m of j.radiusMods) {
      lines.push(`  [${m.category}] ${m.line}`);
    }
    lines.push(
      `  Affected allocated nodes (${j.affectedAllocated.length}):`
    );
    if (j.affectedAllocated.length > 0) {
      const names = j.affectedAllocated.slice(0, 20).map((id) => {
        const n = getPobNode(id);
        return n ? `${id} (${n.name ?? "?"})` : id;
      });
      lines.push(
        `    ${names.join(", ")}` +
          (j.affectedAllocated.length > 20
            ? ` ... +${j.affectedAllocated.length - 20} more`
            : "")
      );
    } else {
      lines.push("    (none)");
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("Categories (best-effort labels):");
  lines.push("  transform   — converts one stat to another (e.g. Energy From Within: Life → ES)");
  lines.push("  grant       — adds a global bonus based on what's in radius");
  lines.push("  multiplier  — increases effect of in-radius passives (e.g. Might of the Meek)");
  lines.push("  other       — anything else; read the mod text");
  lines.push("");
  lines.push("This tool reports presence and scope. Numeric impact varies by");
  lines.push("unique — for the canonical ones (Energy From Within, Healthy");
  lines.push("Mind, Fertile Mind, Might of the Meek, etc.), PoB already");
  lines.push("applies the effect in lua_get_stats totals.");

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
