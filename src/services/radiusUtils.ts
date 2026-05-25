/**
 * Radius / position utilities for passive tree analysis.
 *
 * The PoE passive tree is laid out as groups (clusters) with circular orbits.
 * Each node sits at a specific (group, orbit, orbitIndex). Actual x/y position
 * is computed as group center + orbit_radius * (cos/sin of orbit_angle).
 *
 * Used by the jewel-awareness tools to determine which nodes are in radius of
 * each socketed jewel.
 *
 * Constants come from PoB's tree.lua (which mirrors GGG's published constants):
 *   orbitRadii    = [0, 82, 162, 335, 493, 662, 846]
 *   skillsPerOrbit = [1, 6, 16, 16, 40, 72, 72]
 *
 * Orbit 2/3 use a non-uniform angle distribution (changed in PoE 3.17). All
 * other orbits use uniform angles = 360° / skillsPerOrbit[orbit].
 */

import { getPobTreeData, type PobNode, type PobGroup } from "./pobTreeDataLoader.js";

// Angle (degrees) for each orbitIndex on orbits 2 and 3 (the irregular ones).
// Per PoE 3.17 changes: 16 positions per orbit but at non-uniform angles.
export const ORBIT_2_3_ANGLES: number[] = [
  0, 30, 45, 60, 90, 120, 135, 150, 180, 210, 225, 240, 270, 300, 315, 330,
];

// Lazy-loaded constants from tree.lua.
let cachedOrbitRadii: number[] | null = null;
let cachedSkillsPerOrbit: number[] | null = null;

function loadConstants(): { orbitRadii: number[]; skillsPerOrbit: number[] } {
  if (cachedOrbitRadii && cachedSkillsPerOrbit) {
    return { orbitRadii: cachedOrbitRadii, skillsPerOrbit: cachedSkillsPerOrbit };
  }
  const tree = getPobTreeData();
  const c = (tree.constants ?? {}) as {
    orbitRadii?: number[];
    skillsPerOrbit?: number[];
  };
  // Fallback to documented values if for some reason constants are missing.
  cachedOrbitRadii = c.orbitRadii ?? [0, 82, 162, 335, 493, 662, 846];
  cachedSkillsPerOrbit = c.skillsPerOrbit ?? [1, 6, 16, 16, 40, 72, 72];
  return { orbitRadii: cachedOrbitRadii, skillsPerOrbit: cachedSkillsPerOrbit };
}

/**
 * Compute the angle (degrees) for a given (orbit, orbitIndex).
 * Orbits 2 and 3 use the irregular ORBIT_2_3_ANGLES table; all others are
 * uniform around the circle.
 */
export function angleForOrbitIndex(orbit: number, orbitIndex: number): number {
  if (orbit === 2 || orbit === 3) {
    const a = ORBIT_2_3_ANGLES[orbitIndex];
    return a !== undefined ? a : 0;
  }
  const { skillsPerOrbit } = loadConstants();
  const count = skillsPerOrbit[orbit] ?? 1;
  if (count === 0) return 0;
  return ((orbitIndex % count) * 360) / count;
}

/**
 * Compute the absolute (x, y) position of a single node in PoE tree
 * coordinates. Returns null if the node can't be positioned (missing group,
 * etc.).
 */
export function getNodePosition(node: PobNode | null | undefined): { x: number; y: number } | null {
  if (!node) return null;
  const tree = getPobTreeData();
  const group = tree.groups[String(node.group)] as PobGroup | undefined;
  if (!group) return null;
  const { orbitRadii } = loadConstants();
  const orbit = node.orbit ?? 0;
  const orbitIndex = node.orbitIndex ?? 0;
  const radius = orbitRadii[orbit] ?? 0;
  // PoE's coord system: y grows downward, angles measured from 12 o'clock
  // (north), increasing clockwise. PoB's convention matches.
  const angleDeg = angleForOrbitIndex(orbit, orbitIndex);
  const angleRad = (angleDeg * Math.PI) / 180;
  // Standard "12 o'clock origin, clockwise positive" → x = sin, y = -cos
  const dx = Math.sin(angleRad) * radius;
  const dy = -Math.cos(angleRad) * radius;
  return { x: group.x + dx, y: group.y + dy };
}

/**
 * Convenience: look up a node by ID and return its position.
 */
export function getNodePositionById(nodeId: string): { x: number; y: number } | null {
  const tree = getPobTreeData();
  return getNodePosition(tree.nodes[nodeId]);
}

/**
 * Euclidean distance between two tree-coordinate points.
 */
export function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Jewel radius classes (in tree coordinate units).
 * Source: PassiveJewelRadii.datc64 (Small / Medium / Large), confirmed via
 * spot-checks during the 2026-05-25 Lethal Pride experiment. These are stable
 * across patches — they're tied to the jewel base type, not to mod rolls.
 *
 * All five Timeless Jewels use the LARGE radius.
 */
export const JEWEL_RADII = {
  small: 800,
  medium: 1200,
  large: 1500,
} as const;

export type JewelRadiusClass = keyof typeof JEWEL_RADII;

/**
 * Find all node IDs within `radius` units of a given jewel socket.
 * The jewel socket itself is a node — pass its node ID. Only returns node IDs
 * that exist in the tree.
 *
 * @param socketNodeId  ID of the jewel socket node (in PoB tree.lua coords)
 * @param radius        radius in tree-coordinate units
 * @param filter        optional callback to skip nodes (e.g., only allocated)
 */
export function nodesInRadius(
  socketNodeId: string,
  radius: number,
  filter?: (node: PobNode) => boolean
): string[] {
  const tree = getPobTreeData();
  const socketPos = getNodePositionById(socketNodeId);
  if (!socketPos) return [];

  const matches: string[] = [];
  for (const [nodeId, node] of Object.entries(tree.nodes)) {
    if (nodeId === socketNodeId) continue;
    if (filter && !filter(node)) continue;
    const pos = getNodePosition(node);
    if (!pos) continue;
    if (distance(socketPos, pos) <= radius) {
      matches.push(nodeId);
    }
  }
  return matches;
}

/**
 * Sum a specific base attribute (Strength/Dexterity/Intelligence) across all
 * nodes in radius. Used by threshold-jewel evaluation (e.g., does Brawn's
 * Strength threshold trigger?).
 *
 * Looks for stat patterns like "+10 to Strength" in each node's stats array.
 * This is a simple substring match; threshold-jewel evaluator should layer on
 * top with full stat-ID-aware logic when needed.
 */
export function sumAttributeInRadius(
  socketNodeId: string,
  radius: number,
  attribute: "Strength" | "Dexterity" | "Intelligence",
  allocatedNodes?: Set<string>
): number {
  const tree = getPobTreeData();
  const inRadius = nodesInRadius(socketNodeId, radius);
  let total = 0;
  const re = new RegExp(`\\+(\\d+)\\s+to\\s+${attribute}\\b`);
  for (const nodeId of inRadius) {
    if (allocatedNodes && !allocatedNodes.has(nodeId)) continue;
    const node = tree.nodes[nodeId];
    if (!node || !node.stats) continue;
    for (const stat of node.stats) {
      const m = stat.match(re);
      if (m) total += parseInt(m[1], 10);
    }
  }
  return total;
}
