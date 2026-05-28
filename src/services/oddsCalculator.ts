/**
 * Crafting roll-odds calculator.
 *
 * Computes the probability of hitting target modifiers when rolling an item,
 * using the real spawn weights from PoB's ModItem.lua (which originate from
 * the game's data bundles). The model is exact for the cases it covers:
 *
 *   - Mods are drawn from the prefix/suffix pool weighted by spawn weight.
 *   - Drawing a mod removes its entire mod-GROUP from the pool (only one mod
 *     per group can roll), i.e. sampling without replacement at group level.
 *   - Prefixes and suffixes are independent given a fixed affix count per
 *     side (the caller supplies prefix_count / suffix_count rather than us
 *     guessing PoE's per-orb affix-count distribution).
 *
 * What it does NOT model (out of scope — see calculate_mod_odds docs):
 *   fossil weight biasing, harvest reforge, meta-craft sequences, exact
 *   per-orb affix-count variance, and currency-cost EV.
 */

import { searchMods, resolveWeightForTags, type PobMod } from "./pobModDataLoader.js";
import { getBase, type PobBase } from "./pobBaseDataLoader.js";

export interface GroupInfo {
  group: string;
  /** Total spawn weight of the group on the base (sum over its mods). */
  totalWeight: number;
  /** The group's mods (on this base, eligible at ilvl), sorted top tier first. */
  mods: PobMod[];
}

export interface EligiblePool {
  prefixes: GroupInfo[];
  suffixes: GroupInfo[];
  prefixWeight: number;
  suffixWeight: number;
}

/**
 * Build the eligible natural-roll pool for a base at a given ilvl. A mod is
 * eligible iff: affixed (has a real prefix/suffix name — excludes Hellscape/
 * synthesis/implicit entries), spawn weight > 0 on the base's tag chain, and
 * mod level <= ilvl. Grouped by mod-group with summed weights.
 */
export function buildEligiblePool(base: PobBase, ilvl: number): EligiblePool {
  const all = searchMods({ itemTags: base.tags, limit: 0 });
  const prefixMap = new Map<string, GroupInfo>();
  const suffixMap = new Map<string, GroupInfo>();

  for (const mod of all) {
    if (!mod.affix || mod.affix.length === 0) continue;
    if (!mod.group) continue;
    if (mod.level > ilvl) continue;
    const w = resolveWeightForTags(mod, base.tags);
    if (w <= 0) continue;
    const type = mod.type.toLowerCase();
    const target = type === "prefix" ? prefixMap : type === "suffix" ? suffixMap : null;
    if (!target) continue;
    const gi = target.get(mod.group) ?? { group: mod.group, totalWeight: 0, mods: [] };
    gi.totalWeight += w;
    gi.mods.push(mod);
    target.set(mod.group, gi);
  }

  const finalize = (m: Map<string, GroupInfo>): GroupInfo[] => {
    const arr = Array.from(m.values());
    for (const gi of arr) gi.mods.sort((a, b) => b.level - a.level);
    return arr;
  };

  const prefixes = finalize(prefixMap);
  const suffixes = finalize(suffixMap);
  return {
    prefixes,
    suffixes,
    prefixWeight: prefixes.reduce((s, g) => s + g.totalWeight, 0),
    suffixWeight: suffixes.reduce((s, g) => s + g.totalWeight, 0),
  };
}

/**
 * Exact probability that ALL target group ids appear within K weighted draws
 * without replacement from `groups`. At each draw, the chance of selecting a
 * remaining group is its weight / total remaining weight; the selected group
 * leaves the pool.
 *
 * Pure function (no PoB data) — unit-tested against hand-computable cases.
 * For equal weights it reduces to the hypergeometric result P = K/n for a
 * single target.
 */
export function probAllTargetsDrawn(
  groups: Array<{ id: string; weight: number }>,
  targetIds: string[],
  K: number
): number {
  const needed = new Set(targetIds);
  // Targets not present in the pool can never be drawn.
  for (const t of needed) {
    if (!groups.some((g) => g.id === t)) return 0;
  }

  function recurse(remaining: Array<{ id: string; weight: number }>, drawsLeft: number, need: Set<string>): number {
    if (need.size === 0) return 1;
    if (drawsLeft === 0) return 0;
    if (need.size > drawsLeft) return 0;
    let total = 0;
    for (const g of remaining) total += g.weight;
    if (total <= 0) return 0;
    let p = 0;
    for (let i = 0; i < remaining.length; i++) {
      const g = remaining[i];
      if (g.weight <= 0) continue;
      const pPick = g.weight / total;
      const newRemaining = remaining.slice(0, i).concat(remaining.slice(i + 1));
      let newNeed = need;
      if (need.has(g.id)) {
        newNeed = new Set(need);
        newNeed.delete(g.id);
      }
      p += pPick * recurse(newRemaining, drawsLeft - 1, newNeed);
    }
    return p;
  }

  return recurse(groups, K, needed);
}
