/**
 * Cluster Jewel service.
 *
 * Parses Cluster Jewel items (Large, Medium, Small) from a build's equipped
 * items list and surfaces what each cluster adds to the passive tree:
 *   - The number of passives the cluster contributes ("Adds N Passive Skills")
 *   - Of those, how many are jewel sockets ("X Added Passive Skills are Jewel Sockets")
 *   - The "small passive" enchant bonus (e.g. "Added Small Passive Skills
 *     grant: 12% increased Damage with Two Handed Weapons")
 *   - Any additional small-passive bonuses from explicit/implicit mods
 *   - The specific notables added (e.g. "1 Added Passive Skill is Devastator")
 *
 * PoB already generates the actual node entries for cluster jewels at runtime
 * — they show up as allocated nodes in lua_get_tree. This service complements
 * that by giving a high-level summary of WHAT each cluster contributes,
 * keyed by jewel socket location.
 *
 * Per legal_considerations.md: this service uses only the cluster jewel's
 * own item text (which the player already sees in-game) plus the build's
 * allocation state. No game-data extraction needed.
 */

export type ClusterSize = "Large" | "Medium" | "Small";

export interface ClusterJewelInfo {
  socketNodeId: string;        // jewel socket node ID where this cluster is socketed
  baseName: string;            // e.g. "Large Cluster Jewel"
  fullName: string;            // e.g. "Chimeric Spark, Large Cluster Jewel"
  size: ClusterSize;           // parsed from base
  addedPassiveCount: number;   // total passives added by the cluster
  addedSocketCount: number;    // of those, how many are jewel sockets
  smallPassiveEnchant: string | null;   // "Added Small Passive Skills grant: X" from the enchant line
  smallPassiveExplicitMods: string[];   // additional "Added Small Passive Skills also grant: X" from explicits/implicits
  notables: string[];          // names of notables added by "1 Added Passive Skill is X" mods
}

const SIZE_FROM_BASE: Array<[RegExp, ClusterSize]> = [
  [/Large Cluster Jewel/i, "Large"],
  [/Medium Cluster Jewel/i, "Medium"],
  [/Small Cluster Jewel/i, "Small"],
];

/**
 * Detect if an item line describes a Cluster Jewel and return its size.
 * Looks for "Large Cluster Jewel" / "Medium Cluster Jewel" / "Small Cluster
 * Jewel" anywhere in the provided text.
 */
export function detectClusterSize(text: string): ClusterSize | null {
  for (const [re, size] of SIZE_FROM_BASE) {
    if (re.test(text)) return size;
  }
  return null;
}

/**
 * Parse the cluster-jewel-specific fields from a list of mod text lines.
 * Designed to accept the flat list of strings already separated by line —
 * the caller is responsible for getting that out of the item.raw / item.mods
 * structure.
 *
 * The enchant line is a pipe-separated set of clauses (PoB's get_equipped_items
 * joins them with " | "), e.g.:
 *   "Adds 8 Passive Skills | 2 Added Passive Skills are Jewel Sockets | Added Small Passive Skills grant: 12% increased Damage with Two Handed Weapons"
 *
 * Plus there can be explicit mods like:
 *   "1 Added Passive Skill is Feed the Fury"
 *   "Added Small Passive Skills also grant: +3 to All Attributes"
 */
export function parseClusterJewelLines(modLines: string[]): {
  addedPassiveCount: number;
  addedSocketCount: number;
  smallPassiveEnchant: string | null;
  smallPassiveExplicitMods: string[];
  notables: string[];
} {
  let addedPassiveCount = 0;
  let addedSocketCount = 0;
  let smallPassiveEnchant: string | null = null;
  const smallPassiveExplicitMods: string[] = [];
  const notables: string[] = [];

  for (const rawLine of modLines) {
    // Strip PoB's mod-source prefixes like "{crafted}" / "{fractured}" /
    // "{tag:something}" and trailing "[fractured]" annotations, then split
    // on pipes (some sources join enchant clauses with " | ").
    const stripped = rawLine
      .replace(/^\{[^}]+\}/, "")
      .replace(/\s*\[[^\]]+\]\s*$/, "")
      .trim();
    if (!stripped) continue;
    const clauses = stripped.split(/\s*\|\s*/);
    for (const clause of clauses) {
      const c = clause.trim();
      if (!c) continue;

      const addedMatch = c.match(/^Adds (\d+) Passive Skills?/i);
      if (addedMatch) {
        addedPassiveCount = parseInt(addedMatch[1], 10);
        continue;
      }
      const socketMatch = c.match(/^(\d+) Added Passive Skills? (?:are|is) Jewel Sockets?/i);
      if (socketMatch) {
        addedSocketCount = parseInt(socketMatch[1], 10);
        continue;
      }
      const enchantSmall = c.match(/^Added Small Passive Skills grant:\s*(.+)$/i);
      if (enchantSmall) {
        smallPassiveEnchant = enchantSmall[1].trim();
        continue;
      }
      const alsoSmall = c.match(/^Added Small Passive Skills also grant:\s*(.+?)(?:\s*\[[^\]]+\])?$/i);
      if (alsoSmall) {
        smallPassiveExplicitMods.push(alsoSmall[1].trim());
        continue;
      }
      const notableMatch = c.match(/^1 Added Passive Skill is (.+?)(?:\s*\[[^\]]+\])?$/i);
      if (notableMatch) {
        notables.push(notableMatch[1].trim());
        continue;
      }
    }
  }

  return {
    addedPassiveCount,
    addedSocketCount,
    smallPassiveEnchant,
    smallPassiveExplicitMods,
    notables,
  };
}

/**
 * Build a ClusterJewelInfo from the metadata + mod lines of a single equipped
 * cluster jewel. Returns null if the item isn't a Cluster Jewel.
 */
export function clusterInfoFromItem(args: {
  socketNodeId: string;
  itemName: string;       // e.g. "Chimeric Spark"
  baseName: string;       // e.g. "Large Cluster Jewel"
  modLines: string[];
}): ClusterJewelInfo | null {
  const size = detectClusterSize(args.baseName) ?? detectClusterSize(args.itemName);
  if (!size) return null;

  const parsed = parseClusterJewelLines(args.modLines);
  return {
    socketNodeId: args.socketNodeId,
    baseName: args.baseName,
    fullName: args.itemName.includes(args.baseName)
      ? args.itemName
      : `${args.itemName}, ${args.baseName}`,
    size,
    ...parsed,
  };
}
