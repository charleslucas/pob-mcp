/**
 * Handler for the evaluate_threshold_jewels MCP tool.
 *
 * Reads the live build's equipped jewels, filters to ones carrying threshold
 * mods ("With at least N <Attribute> in Radius, …"), and reports whether
 * each threshold is currently met by the allocated tree around the jewel.
 *
 * Useful for jewel shopping ("would this Brawn fit my tree?") and for
 * diagnosing missing build effects ("I think I have +6% Reservation
 * Efficiency from Conqueror's Efficiency, but the threshold isn't met").
 */

import type { AnyLuaClient } from "../pobLuaBridge.js";
import {
  evaluateBuildThresholds,
  type JewelThresholdSocketInfo,
  type ThresholdEvaluation,
} from "../services/thresholdJewelService.js";
import { getPobNode } from "../services/pobTreeDataLoader.js";

export interface ThresholdJewelHandlerContext {
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

function formatThresholdLine(e: ThresholdEvaluation): string {
  const symbol = e.triggered ? "✓" : "✗";
  const marginText =
    e.margin === 0
      ? "exactly at threshold"
      : e.margin > 0
        ? `+${e.margin} above threshold`
        : `${e.margin} short`;
  return (
    `  ${symbol} ${e.threshold.attribute} ≥ ${e.threshold.requiredAmount} ` +
    `(have ${e.attributeInRadius}, ${marginText})\n` +
    `      ${e.threshold.rawMod}`
  );
}

export async function handleEvaluateThresholdJewels(
  context: ThresholdJewelHandlerContext
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

  const jewels: JewelThresholdSocketInfo[] = [];
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

  const result = evaluateBuildThresholds(jewels, allocatedNodes);

  const lines: string[] = [];
  lines.push("=== Threshold Jewel Evaluation ===");
  lines.push("");
  lines.push(
    `Scanned ${result.jewelsScanned} jewel${result.jewelsScanned === 1 ? "" : "s"}; ` +
      `${result.jewelsWithThresholds} carry threshold mod${result.jewelsWithThresholds === 1 ? "" : "s"}.`
  );

  if (result.jewelsWithThresholds === 0) {
    lines.push("");
    lines.push(
      "No threshold mods detected. Threshold mods take the form " +
        "'With at least N <Strength|Dexterity|Intelligence> in Radius, …'."
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  lines.push("");
  let totalTriggered = 0;
  let totalNotTriggered = 0;
  for (const ev of result.evaluations) {
    totalTriggered += ev.triggered.length;
    totalNotTriggered += ev.notTriggered.length;
    const socketNode = getPobNode(ev.socketNodeId);
    const socketLabel = socketNode
      ? `${socketNode.name ?? "Jewel Socket"} (#${ev.socketNodeId})`
      : `socket #${ev.socketNodeId}`;
    lines.push(`• ${ev.jewelName} @ ${socketLabel}  [radius ${ev.radius}]`);
    for (const e of ev.triggered) lines.push(formatThresholdLine(e));
    for (const e of ev.notTriggered) lines.push(formatThresholdLine(e));
    lines.push("");
  }

  lines.push("---");
  lines.push(
    `Summary: ${totalTriggered} threshold${totalTriggered === 1 ? "" : "s"} triggered, ` +
      `${totalNotTriggered} not triggered.`
  );
  lines.push("");
  lines.push("Notes:");
  lines.push("- Radius defaults to 'Small' (800 units), which is the radius of");
  lines.push("  inner-tree basic jewel sockets where threshold jewels typically live.");
  lines.push("- Attribute sum is computed from ALLOCATED nodes in radius, matching");
  lines.push("  the game's actual threshold mechanic.");
  lines.push("- 'Total Attributes in Radius' and 'Notable Passives in Radius' style");
  lines.push("  thresholds aren't yet handled — those are Phase-2 material.");

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
