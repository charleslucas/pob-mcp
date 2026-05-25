/**
 * Radius-Effect-Unique Jewel Service.
 *
 * Detects "in Radius" mods on socketed jewels that are NOT handled by the
 * dedicated tools (Timeless transformations, attribute thresholds). Surfaces
 * the mod text alongside the allocated nodes in the jewel's radius so the
 * caller can reason about impact.
 *
 * Examples this catches:
 *   - "Increases and Reductions to Life in Radius are Transformed to apply
 *     to Energy Shield" (Energy From Within)
 *   - "Increases and Reductions to Intelligence in Radius are Transformed
 *     to apply to Mana" (Healthy Mind)
 *   - "Notable Passive Skills in Radius grant nothing" / "50% increased Effect
 *     of non-Keystone Passive Skills in Radius" (Might of the Meek)
 *   - "Notable Passives in Radius are conquered by..." — caught here, but
 *     timelessJewelService handles the actual transformation
 *
 * Excluded (handled by other tools):
 *   - Timeless Jewels (Lethal Pride / Glorious Vanity / Militant Faith /
 *     Brutal Restraint / Elegant Hubris) — see timelessJewelService.
 *   - Attribute thresholds ("With at least N <Strength/Dex/Int> in Radius, …")
 *     — see thresholdJewelService.
 *
 * Phase-1 scope: detection + reporting. Does not yet compute the numeric
 * impact (that requires per-unique semantics — Energy From Within transforms
 * Life→ES, Healthy Mind transforms Life→Mana via Strength conversion, etc.).
 * The reported info is enough for a human or Claude to interpret.
 */

import { JEWEL_RADII, nodesInRadius } from "./radiusUtils.js";

const RADIUS_PATTERN = /\bin\s+(?:the\s+)?radius\b/i;

const TIMELESS_INDICATORS: RegExp[] = [
  /conquered by the karui/i,
  /conquered by vaal/i,
  /conquered by the eternal/i,
  /conquered by the templars/i,
  /conquered by the maraketh/i,
  /commanded leadership over \d+ warriors under/i,
  /denoted service of \d+ dekhara/i,
  /carved to glorify \d+ new faithful/i,
  /commissioned \d+ coins to commemorate/i,
];

const THRESHOLD_PATTERN =
  /with(?:\s+at\s+least)?\s+\d+\s+(strength|dexterity|intelligence)\s+in\s+(?:the\s+)?radius/i;

function stripModSourcePrefix(line: string): string {
  return line
    .replace(/^\{[^}]+\}/, "")
    .replace(/\s*\[[^\]]+\]\s*$/, "")
    .trim();
}

/**
 * Decide whether a single mod line is a "radius-effect" mod that this service
 * should report — i.e., it mentions "in radius" but isn't a Timeless Jewel
 * signature or an attribute threshold.
 */
export function isRadiusEffectMod(rawLine: string): boolean {
  const line = stripModSourcePrefix(rawLine);
  if (!line) return false;
  if (!RADIUS_PATTERN.test(line)) return false;
  if (TIMELESS_INDICATORS.some((p) => p.test(line))) return false;
  if (THRESHOLD_PATTERN.test(line)) return false;
  return true;
}

export type RadiusCategory = "transform" | "grant" | "multiplier" | "other";

/**
 * Best-effort categorization of what KIND of radius effect a mod is. Useful
 * for grouping output but not load-bearing — callers should still read the
 * mod text.
 */
export function categorizeRadiusMod(rawLine: string): RadiusCategory {
  const line = stripModSourcePrefix(rawLine).toLowerCase();
  if (/are transformed to|are converted to/.test(line)) return "transform";
  if (/grant(?:s|ing|ed)?\b/.test(line)) return "grant";
  if (/double|triple|increased effect of/.test(line)) return "multiplier";
  return "other";
}

export interface JewelRadiusEffectInfo {
  /** Jewel socket node ID. */
  socketNodeId: string;
  /** Jewel display name. */
  jewelName: string;
  /** Mod lines matched by isRadiusEffectMod, cleaned of source prefixes. */
  radiusMods: Array<{ line: string; category: RadiusCategory }>;
  /** Radius used for the node-in-radius lookup (in tree-coord units). */
  radius: number;
  /** Allocated node IDs in radius — those that the radius mods would affect. */
  affectedAllocated: string[];
}

export interface JewelSocketInfo {
  socketNodeId: string;
  jewelName: string;
  mods: string[];
  /** Radius override; defaults to small (800) for inner-tree basic sockets. */
  radius?: number;
}

export interface FindRadiusEffectsResult {
  jewelsScanned: number;
  jewelsWithRadiusEffects: number;
  jewels: JewelRadiusEffectInfo[];
}

/**
 * Find all jewels in the build that have non-Timeless, non-Threshold "in
 * Radius" mods. For each, list the affected allocated nodes.
 */
export function findRadiusEffectJewels(
  jewels: JewelSocketInfo[],
  allocatedNodes: Set<string>
): FindRadiusEffectsResult {
  const out: FindRadiusEffectsResult = {
    jewelsScanned: jewels.length,
    jewelsWithRadiusEffects: 0,
    jewels: [],
  };
  for (const j of jewels) {
    const matchedMods = j.mods
      .map(stripModSourcePrefix)
      .filter((l) => l.length > 0 && isRadiusEffectMod(l));
    if (matchedMods.length === 0) continue;
    out.jewelsWithRadiusEffects++;

    const radius = j.radius ?? JEWEL_RADII.small;
    const inRadius = nodesInRadius(j.socketNodeId, radius);
    const affectedAllocated = inRadius.filter((id) => allocatedNodes.has(id));

    out.jewels.push({
      socketNodeId: j.socketNodeId,
      jewelName: j.jewelName,
      radiusMods: matchedMods.map((line) => ({
        line,
        category: categorizeRadiusMod(line),
      })),
      radius,
      affectedAllocated,
    });
  }
  return out;
}
