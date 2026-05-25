/**
 * Threshold-Jewel evaluator.
 *
 * Threshold jewels (Brawn, Lethal Assault, Inertia, Healthy Mind, Conqueror's
 * Efficiency, etc.) have effects gated on the surrounding tree state — most
 * commonly "With at least N <attribute> in Radius, …". They don't change
 * passive tooltips; instead, the conditional bonus turns on or off based on
 * the allocated nodes within the jewel's radius.
 *
 * This service:
 *   - Parses threshold-style mod patterns from a jewel's mod text.
 *   - Given the build's allocation, evaluates each threshold against the
 *     attribute sum in the jewel's radius (via radiusUtils.sumAttributeInRadius).
 *   - Reports whether each threshold is met, and by how much margin.
 *
 * Per legal_considerations.md: relies only on the jewel's own mod text plus
 * the build's tree state. No game-data extraction required.
 *
 * Phase-1 scope:
 *   - Attribute thresholds: Strength, Dexterity, Intelligence.
 *   - Assumes "Basic Jewel Socket" radius (800 units) by default; can be
 *     overridden per call when the socket type differs.
 *   - Does NOT yet parse "Notable Passive Skills in Radius" patterns or
 *     "Total Attributes in Radius" — those are rarer and Phase-2 material.
 */

import { JEWEL_RADII, sumAttributeInRadius } from "./radiusUtils.js";

export type Attribute = "Strength" | "Dexterity" | "Intelligence";

export interface ThresholdMod {
  /** The threshold attribute (e.g. "Strength"). */
  attribute: Attribute;
  /** The minimum number required in radius (e.g. 40). */
  requiredAmount: number;
  /** The full mod text — for display. */
  rawMod: string;
}

/**
 * Match patterns the game uses for attribute thresholds. Examples:
 *   "With at least 40 Strength in Radius, 1% increased Strength per 20 Strength"
 *   "With 40 Intelligence in Radius, 20% increased Effect of Auras…"
 *   "With at least 40 Dexterity in Radius, …"
 */
const THRESHOLD_PATTERN = /With(?:\s+at\s+least)?\s+(\d+)\s+(Strength|Dexterity|Intelligence)\s+in\s+Radius,?\s*(.*)/i;

export function parseThresholdMods(modLines: string[]): ThresholdMod[] {
  const results: ThresholdMod[] = [];
  for (const rawLine of modLines) {
    // Strip mod-source prefixes (`{crafted}` etc.) and trailing source tags.
    const cleaned = rawLine
      .replace(/^\{[^}]+\}/, "")
      .replace(/\s*\[[^\]]+\]\s*$/, "")
      .trim();
    if (!cleaned) continue;
    const m = cleaned.match(THRESHOLD_PATTERN);
    if (m) {
      const requiredAmount = parseInt(m[1], 10);
      const attribute = (m[2].charAt(0).toUpperCase() +
        m[2].slice(1).toLowerCase()) as Attribute;
      results.push({
        attribute,
        requiredAmount,
        rawMod: cleaned,
      });
    }
  }
  return results;
}

export interface ThresholdEvaluation {
  threshold: ThresholdMod;
  attributeInRadius: number;
  triggered: boolean;
  /** How far above or below the threshold; positive = over (triggered with margin), negative = short. */
  margin: number;
  /** Radius used for the evaluation (in tree-coord units). */
  radius: number;
}

/**
 * Evaluate a single threshold against the current build state.
 *
 * @param threshold        Parsed threshold mod.
 * @param socketNodeId     Node ID of the jewel socket containing the jewel.
 * @param allocatedNodes   The build's allocated node IDs.
 * @param radius           Override radius in tree units. Defaults to "Small"
 *                         (800) which is the radius of inner-tree basic jewel
 *                         sockets where threshold jewels typically live.
 */
export function evaluateThreshold(
  threshold: ThresholdMod,
  socketNodeId: string,
  allocatedNodes: Set<string>,
  radius: number = JEWEL_RADII.small
): ThresholdEvaluation {
  const inRadius = sumAttributeInRadius(
    socketNodeId,
    radius,
    threshold.attribute,
    allocatedNodes
  );
  return {
    threshold,
    attributeInRadius: inRadius,
    triggered: inRadius >= threshold.requiredAmount,
    margin: inRadius - threshold.requiredAmount,
    radius,
  };
}

export interface JewelThresholdSocketInfo {
  socketNodeId: string;
  jewelName: string;
  mods: string[];
  /** Optional radius override (in tree units). If omitted, JEWEL_RADII.small is used. */
  radius?: number;
}

export interface EvaluateBuildResult {
  jewelsScanned: number;
  jewelsWithThresholds: number;
  evaluations: Array<{
    socketNodeId: string;
    jewelName: string;
    radius: number;
    triggered: ThresholdEvaluation[];
    notTriggered: ThresholdEvaluation[];
  }>;
}

export function evaluateBuildThresholds(
  jewels: JewelThresholdSocketInfo[],
  allocatedNodes: Set<string>
): EvaluateBuildResult {
  const out: EvaluateBuildResult = {
    jewelsScanned: jewels.length,
    jewelsWithThresholds: 0,
    evaluations: [],
  };
  for (const j of jewels) {
    const thresholds = parseThresholdMods(j.mods);
    if (thresholds.length === 0) continue;
    out.jewelsWithThresholds++;
    const radius = j.radius ?? JEWEL_RADII.small;
    const evals = thresholds.map((t) =>
      evaluateThreshold(t, j.socketNodeId, allocatedNodes, radius)
    );
    out.evaluations.push({
      socketNodeId: j.socketNodeId,
      jewelName: j.jewelName,
      radius,
      triggered: evals.filter((e) => e.triggered),
      notTriggered: evals.filter((e) => !e.triggered),
    });
  }
  return out;
}
