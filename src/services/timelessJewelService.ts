/**
 * Timeless Jewel service.
 *
 * Parses Timeless Jewel mod text from an equipped jewel to extract the seed
 * and historic character, then computes which allocated passive nodes fall
 * within the jewel's radius (and are therefore being transformed in-game).
 *
 * This Phase-1 implementation IDENTIFIES affected nodes but does NOT yet
 * compute the per-node transformed stats. That requires extracting the
 * AlternatePassiveSkills / AlternatePassiveAdditions tables from the user's
 * local PoE install (see pob-mcp/TODO.md "Comprehensive jewel-awareness
 * roadmap" for the planned approach).
 *
 * The five Timeless Jewel types and their mod patterns:
 *   Lethal Pride     "Commanded leadership over N warriors under {Karui}"
 *   Glorious Vanity  "Denoted service of N dekhara in the akhara of {Vaal}"
 *   Militant Faith   "Carved to glorify N new faithful converted by High Templar {Templar}"
 *   Brutal Restraint "Denoted service of N dekhara in the akhara of {Maraketh}"   <-- check
 *   Elegant Hubris   "Commissioned N coins to commemorate {Eternal}"
 *
 * (The Brutal Restraint / Glorious Vanity wording is similar; canonical
 * patterns differ by exact verbs. See in-game text for authoritative wording;
 * we match by jewel name primarily and only use mod text for seed extraction.)
 *
 * Per legal_considerations.md: this service uses only the structural data
 * in PoB's tree.lua (which mirrors GGG's published format). The historic-
 * character mapping comes from the user's own jewel mod text, not from any
 * private game-data extraction.
 */

import { nodesInRadius, JEWEL_RADII } from "./radiusUtils.js";

/** The five Timeless Jewel types. */
export type TimelessJewelType =
  | "Lethal Pride"
  | "Glorious Vanity"
  | "Militant Faith"
  | "Brutal Restraint"
  | "Elegant Hubris";

const TIMELESS_JEWEL_NAMES: ReadonlySet<string> = new Set<string>([
  "Lethal Pride",
  "Glorious Vanity",
  "Militant Faith",
  "Brutal Restraint",
  "Elegant Hubris",
]);

/**
 * Each Timeless Jewel's mod text encodes both a numeric seed and a historic
 * character (one of 5-7 leaders per jewel type). We parse the mod text rather
 * than computing the leader algorithmically — the in-game text is the
 * authoritative source for which leader applies.
 *
 * Pattern matches the canonical wordings observed in current PoE.
 */
const SEED_LEADER_PATTERNS: Array<{
  jewelType: TimelessJewelType;
  pattern: RegExp;
}> = [
  {
    // Lethal Pride: "Commanded leadership over N warriors under <Karui leader>"
    jewelType: "Lethal Pride",
    pattern: /Commanded leadership over (\d+) warriors under (\w[\w\s'-]*?)$/m,
  },
  {
    // Glorious Vanity: "Denoted service of N dekhara in the akhara of <Vaal leader>"
    jewelType: "Glorious Vanity",
    pattern: /Denoted service of (\d+) dekhara in the akhara of (\w[\w\s'-]*?)$/m,
  },
  {
    // Militant Faith: "Carved to glorify N new faithful converted by High Templar <name>"
    jewelType: "Militant Faith",
    pattern: /Carved to glorify (\d+) new faithful converted by High Templar (\w[\w\s'-]*?)$/m,
  },
  {
    // Brutal Restraint: "Denoted service of N dekhara in the akhara of <Maraketh leader>"
    // Pattern is structurally identical to Glorious Vanity; we distinguish by
    // jewel name (see parseTimelessJewelMod below) rather than the verb here.
    jewelType: "Brutal Restraint",
    pattern: /Denoted service of (\d+) dekhara in the akhara of (\w[\w\s'-]*?)$/m,
  },
  {
    // Elegant Hubris: "Commissioned N coins to commemorate <Eternal leader>"
    jewelType: "Elegant Hubris",
    pattern: /Commissioned (\d+) coins to commemorate (\w[\w\s'-]*?)$/m,
  },
];

export interface TimelessJewelInfo {
  jewelType: TimelessJewelType;
  seed: number;
  historicCharacter: string;
  radiusClass: "large"; // All Timeless Jewels use Large radius.
  radius: number; // numeric units
}

/**
 * Given a jewel's display name and mod text, return Timeless Jewel info if
 * recognized; otherwise null (not a Timeless Jewel).
 *
 * @param jewelName   The jewel's name as shown in-game (e.g., "Lethal Pride").
 *                    Used to distinguish Glorious Vanity from Brutal Restraint,
 *                    which share a mod text structure.
 * @param mods        The jewel's mod text lines.
 */
export function parseTimelessJewelMod(
  jewelName: string,
  mods: string[]
): TimelessJewelInfo | null {
  // First: check if the name itself indicates a Timeless Jewel.
  let matchedType: TimelessJewelType | null = null;
  for (const t of TIMELESS_JEWEL_NAMES) {
    if (jewelName === t || jewelName.includes(t)) {
      matchedType = t as TimelessJewelType;
      break;
    }
  }
  if (!matchedType) return null;

  // Pick the parser for the matched type and run it against each mod line.
  const matcher = SEED_LEADER_PATTERNS.find((p) => p.jewelType === matchedType);
  if (!matcher) return null;

  for (const modLine of mods) {
    const m = modLine.match(matcher.pattern);
    if (m) {
      const seed = parseInt(m[1], 10);
      const historicCharacter = m[2].trim();
      return {
        jewelType: matchedType,
        seed,
        historicCharacter,
        radiusClass: "large",
        radius: JEWEL_RADII.large,
      };
    }
  }
  // Name matched but mod text didn't — return null rather than partial info.
  return null;
}

/**
 * Identifies which Timeless Jewels (if any) are in a set of equipped jewels,
 * and computes which allocated nodes each one is affecting.
 *
 * @param equippedJewels  Array of (socket_node_id, name, mods) describing each
 *                        jewel currently socketed in the tree.
 * @param allocatedNodes  The set of allocated node IDs (used to filter results
 *                        to nodes the user actually has — unallocated nodes in
 *                        radius are still transformed in-game, but matter less
 *                        for analysis).
 */
export interface JewelSocketInfo {
  socketNodeId: string;
  jewelName: string;
  mods: string[];
}

export interface AffectedNodeRecord {
  nodeId: string;
  affectingJewels: Array<{
    socketNodeId: string;
    jewel: TimelessJewelInfo;
  }>;
}

export interface FindAffectedResult {
  timelessJewels: Array<{
    socketNodeId: string;
    jewel: TimelessJewelInfo;
    affectedAllocated: string[];
    affectedUnallocated: string[];
  }>;
  /** Per-node summary: which jewels are transforming each allocated node. */
  byNode: Record<string, AffectedNodeRecord>;
}

export function findAffectedNodes(
  equippedJewels: JewelSocketInfo[],
  allocatedNodes: Set<string>
): FindAffectedResult {
  const result: FindAffectedResult = {
    timelessJewels: [],
    byNode: {},
  };

  for (const j of equippedJewels) {
    const info = parseTimelessJewelMod(j.jewelName, j.mods);
    if (!info) continue;

    const inRadius = nodesInRadius(j.socketNodeId, info.radius);
    const affectedAllocated: string[] = [];
    const affectedUnallocated: string[] = [];
    for (const nodeId of inRadius) {
      if (allocatedNodes.has(nodeId)) {
        affectedAllocated.push(nodeId);
        if (!result.byNode[nodeId]) {
          result.byNode[nodeId] = { nodeId, affectingJewels: [] };
        }
        result.byNode[nodeId].affectingJewels.push({
          socketNodeId: j.socketNodeId,
          jewel: info,
        });
      } else {
        affectedUnallocated.push(nodeId);
      }
    }
    result.timelessJewels.push({
      socketNodeId: j.socketNodeId,
      jewel: info,
      affectedAllocated,
      affectedUnallocated,
    });
  }

  return result;
}
