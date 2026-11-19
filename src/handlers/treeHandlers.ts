import type { BuildService } from "../services/buildService.js";
import type { TreeService } from "../services/treeService.js";
import type { TreeAnalysisResult, TreeComparison, PassiveTreeNode, AllocationChange, PassiveTreeData } from "../types.js";
import type { AnyLuaClient } from "../pobLuaBridge.js";
import { handleGetBuildIssues } from "./buildGoalsHandlers.js";
import { SteinerSolver } from "../services/steinerSolver.js";

/**
 * DPS/EHP exactly as a calcWith candidate reports them: player hit DPS, else the main
 * skill's minion DPS (calcWith nests minion output under `Minion` and never computes
 * Full DPS -- that costs minutes per call on big minion builds).
 */
const simDPS = (o: any): number =>
  Number(o?.CombinedDPS) || Number(o?.TotalDPS) || Number(o?.Minion?.CombinedDPS) || Number(o?.Minion?.TotalDPS) || 0;
const simEHP = (o: any): number => Number(o?.TotalEHP) || Number(o?.Life) || 0;

/**
 * Baseline measured through the SAME calcWith path as the candidates (an empty
 * masteryEffects map runs the simulation with nothing changed), so base and candidate
 * are one measurement. `mainSkillDps` is 0 when the build's MAIN skill deals no damage --
 * calcWith scores the main skill only, so DPS cannot rank at all; callers must say so
 * rather than print "Base DPS: 1" (the divisor floor) as if it were a value.
 */
async function simBaseline(luaClient: any, fallback: Record<string, any>): Promise<{ dps: number; ehp: number; mainSkillDps: number; isMinionMain: boolean }> {
  const out = await luaClient.calcWith({ masteryEffects: {} }).catch(() => null);
  const dps = simDPS(out) || Number(fallback.CombinedDPS) || Number(fallback.TotalDPS) || Number(fallback.MinionTotalDPS) || 0;
  const ehp = simEHP(out) || Number(fallback.TotalEHP) || Number(fallback.Life) || 0;
  // The main skill's damage comes from minions when the player deals none of it.
  const playerDps = Number(out?.CombinedDPS) || Number(out?.TotalDPS) || 0;
  const minionDps = Number(out?.Minion?.CombinedDPS) || Number(out?.Minion?.TotalDPS) || 0;
  return { dps: dps || 1, ehp: ehp || 1, mainSkillDps: dps, isMinionMain: playerDps === 0 && minionDps > 0 };
}

/** Shown when the main skill deals no damage, so only EHP can rank. */
const NO_MAIN_SKILL_DPS_NOTE =
  '⚠️  DPS NOT RANKED: the main skill deals no damage in PoB (often an aura/movement group, which ' +
  'imports tend to select). Candidates are scored on EHP only. Set the main skill to your damage ' +
  'skill (set_main_skill) and re-run. Full DPS is never simulated per candidate (minutes per call).';

export interface TreeHandlerContext {
  buildService: BuildService;
  treeService: TreeService;
  getLuaClient?: () => AnyLuaClient | null;
}

export interface PassiveUpgradesContext {
  getLuaClient: () => AnyLuaClient | null;
  ensureLuaClient: () => Promise<void>;
}

export async function handleCompareTrees(
  context: TreeHandlerContext,
  build1Name: string,
  build2Name: string
) {
  try {
    const build1 = await context.buildService.readBuild(build1Name);
    const build2 = await context.buildService.readBuild(build2Name);

    const analysis1 = await context.treeService.analyzePassiveTree(build1);
    const analysis2 = await context.treeService.analyzePassiveTree(build2);

    if (!analysis1 || !analysis2) {
      throw new Error('One or both builds lack passive tree data');
    }

    // Calculate differences
    const nodes1Ids = new Set(analysis1.allocatedNodes.map(n => String(n.skill)));
    const nodes2Ids = new Set(analysis2.allocatedNodes.map(n => String(n.skill)));

    const uniqueToBuild1 = analysis1.allocatedNodes.filter(n => !nodes2Ids.has(String(n.skill)));
    const uniqueToBuild2 = analysis2.allocatedNodes.filter(n => !nodes1Ids.has(String(n.skill)));
    const sharedNodes = analysis1.allocatedNodes.filter(n => nodes2Ids.has(String(n.skill)));

    const pointDifference = analysis1.totalPoints - analysis2.totalPoints;

    let archetypeDifference = '';
    if (analysis1.archetype !== analysis2.archetype) {
      archetypeDifference = `Build 1: ${analysis1.archetype} vs Build 2: ${analysis2.archetype}`;
    } else {
      archetypeDifference = `Both builds: ${analysis1.archetype}`;
    }

    const comparison: TreeComparison = {
      build1: { name: build1Name, analysis: analysis1 },
      build2: { name: build2Name, analysis: analysis2 },
      differences: {
        uniqueToBuild1,
        uniqueToBuild2,
        sharedNodes,
        pointDifference,
        archetypeDifference
      }
    };

    const output = formatTreeComparison(comparison);

    return {
      content: [
        {
          type: "text" as const,
          text: output,
        },
      ],
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to compare trees: ${errorMsg}`);
  }
}


export async function handleGetNearbyNodes(
  context: TreeHandlerContext,
  buildName: string | undefined,
  maxDistance?: number,
  filter?: string
) {
  try {
    let allocatedNodeIds: string[] = [];
    let treeVersion = 'Unknown';

    // Try file-based path first
    if (buildName) {
      try {
        const build = await context.buildService.readBuild(buildName);
        allocatedNodeIds = context.buildService.parseAllocatedNodes(build);
        treeVersion = context.buildService.extractBuildVersion(build);
      } catch {
        // Fall through to Lua fallback
      }
    }

    // Lua bridge fallback when no file or file read failed
    if (allocatedNodeIds.length === 0 && context.getLuaClient) {
      const luaClient = context.getLuaClient();
      if (luaClient) {
        const treeResult = await luaClient.getTree();
        allocatedNodeIds = (treeResult.nodes || []).map(String);
        treeVersion = treeResult.treeVersion || 'Unknown';
      }
    }

    if (allocatedNodeIds.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: "No allocated nodes found. Provide a build_name or load a build with lua_load_build first.",
        }],
      };
    }

    const allocatedNodes = new Set<string>(allocatedNodeIds);
    const treeData = await context.treeService.getTreeData(treeVersion);

    const distance = maxDistance || 3;

    // Find nearby nodes using TreeService
    const nearbyNodes = context.treeService.findNearbyNodes(
      allocatedNodes,
      treeData,
      distance,
      filter
    );

    if (nearbyNodes.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No notable or keystone nodes found within ${distance} nodes of your current tree.\n\nTry increasing max_distance or removing the filter.`,
          },
        ],
      };
    }

    const textLines: string[] = [
      `=== Nearby Nodes (within ${distance} nodes) ===`,
      '',
      `Build: ${buildName || '(build open in PoB)'}`,
      `Found ${nearbyNodes.length} nodes`,
      '',
    ];

    // Group by distance
    const byDistance = new Map<number, typeof nearbyNodes>();
    for (const node of nearbyNodes) {
      const existing = byDistance.get(node.distance) || [];
      existing.push(node);
      byDistance.set(node.distance, existing);
    }

    for (const [dist, nodes] of Array.from(byDistance.entries()).sort((a, b) => a[0] - b[0])) {
      textLines.push(`**Distance ${dist}** (${nodes.length} nodes):`);
      for (const { node, nodeId } of nodes.slice(0, 10)) {
        let line = `- ${node.name || 'Unnamed'} [${nodeId}]`;
        if (node.isKeystone) line += ' (KEYSTONE)';
        textLines.push(line);
        if (node.stats && node.stats.length > 0) {
          textLines.push(`  ${node.stats.slice(0, 2).join('; ')}`);
        }
      }
      if (nodes.length > 10) {
        textLines.push(`  ... and ${nodes.length - 10} more`);
      }
      textLines.push('');
    }

    return {
      content: [
        {
          type: "text" as const,
          text: textLines.join('\n'),
        },
      ],
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text" as const,
          text: `Error: ${errorMsg}`,
        },
      ],
    };
  }
}

export async function handleFindPath(
  context: TreeHandlerContext,
  buildName: string | undefined,
  targetNodeId: string,
  showAlternatives?: boolean,
  fromNodeId?: string
) {
  try {
    let allocatedNodeIds: string[] = [];
    let treeVersion = 'Unknown';

    // Try file-based path first
    if (buildName) {
      try {
        const build = await context.buildService.readBuild(buildName);
        const spec = context.buildService.getActiveSpec(build);
        if (!spec) {
          throw new Error("Build has no passive tree data");
        }
        allocatedNodeIds = context.buildService.parseAllocatedNodes(build);
        treeVersion = context.buildService.extractBuildVersion(build);
      } catch (fileErr) {
        // Fall through to Lua fallback
        if (buildName) throw fileErr; // Re-throw if explicitly requested
      }
    }

    // Lua bridge fallback when no file or file read failed
    if (allocatedNodeIds.length === 0 && context.getLuaClient) {
      const luaClient = context.getLuaClient();
      if (luaClient) {
        const treeResult = await luaClient.getTree();
        allocatedNodeIds = (treeResult.nodes || []).map(String);
        treeVersion = treeResult.treeVersion || 'Unknown';
      }
    }

    if (allocatedNodeIds.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: "No allocated nodes found. Provide a build_name or load a build with lua_load_build first.",
        }],
      };
    }

    let allocatedNodes = new Set<string>(allocatedNodeIds);
    const treeData = await context.treeService.getTreeData(treeVersion);

    // Check if target node exists
    const targetNode = treeData.nodes.get(targetNodeId);
    if (!targetNode) {
      throw new Error(`Node ${targetNodeId} not found in tree data`);
    }

    // Check if target is already allocated
    if (allocatedNodes.has(targetNodeId)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Node ${targetNodeId} (${targetNode.name || "Unknown"}) is already allocated in this build.`,
          },
        ],
      };
    }

    // If from_node_id is provided, route from that specific node instead of
    // the build frontier — enables any-node-to-any-node routing.
    if (fromNodeId) {
      if (!treeData.nodes.has(fromNodeId)) {
        throw new Error(`from_node_id ${fromNodeId} not found in tree data`);
      }
      allocatedNodes = new Set([fromNodeId]);
      treeVersion = treeVersion; // keep for header
    }

    // Find shortest path(s) using TreeService
    const paths = context.treeService.findShortestPaths(
      allocatedNodes,
      targetNodeId,
      treeData,
      showAlternatives ? 3 : 1
    );

    if (paths.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No path found to node ${targetNodeId} (${targetNode.name || "Unknown"}).\n\nThis node may be unreachable from your current tree (e.g., different class starting area or ascendancy nodes).`,
          },
        ],
      };
    }

    // Format output
    const routeDesc = fromNodeId
      ? `from node ${fromNodeId} to ${targetNode.name || targetNodeId}`
      : `to ${targetNode.name || "Node " + targetNodeId}`;
    const textLines: string[] = [
      `=== Path ${routeDesc} ===`,
      '',
    ];
    if (fromNodeId) {
      const fromNode = treeData.nodes.get(fromNodeId);
      textLines.push(`From: ${fromNode?.name || "Unknown"} [${fromNodeId}]`);
    } else {
      textLines.push(`Build: ${buildName}`);
    }
    textLines.push(`Target: ${targetNode.name || "Unknown"} [${targetNodeId}]`);
    if (targetNode.isKeystone) textLines.push('Type: KEYSTONE');
    else if (targetNode.isNotable) textLines.push('Type: Notable');
    textLines.push('');

    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];
      const pathLabel = paths.length > 1 ? `Path ${i + 1} (Alternative ${i === 0 ? "- Shortest" : i})` : "Shortest Path";

      const keystones = path.nodes.filter(id => treeData.nodes.get(id)?.isKeystone).length;
      const notables  = path.nodes.filter(id => { const n = treeData.nodes.get(id); return n?.isNotable && !n?.isKeystone; }).length;
      const travel    = path.nodes.length - keystones - notables;

      textLines.push(`**${pathLabel}**`);
      textLines.push(`Total Cost: ${path.cost} passive points`);
      textLines.push(`Nodes to Allocate: ${path.nodes.length}  (${keystones > 0 ? keystones + ' keystone, ' : ''}${notables} notable, ${travel} travel)`, '');

      textLines.push('Allocation Order:');
      for (let j = 0; j < path.nodes.length; j++) {
        const nodeId = path.nodes[j];
        const node = treeData.nodes.get(nodeId);
        if (!node) continue;

        const isTarget = nodeId === targetNodeId;
        const prefix = isTarget ? "→ TARGET: " : `  ${j + 1}. `;

        textLines.push(`${prefix}${node.name || "Travel Node"} [${nodeId}]`);

        if (node.stats && node.stats.length > 0) {
          for (const stat of node.stats) {
            textLines.push(`      ${stat}`);
          }
        } else if (!isTarget) {
          textLines.push('      (Travel node - no stats)');
        }

        if (j < path.nodes.length - 1) textLines.push('');
      }

      if (i < paths.length - 1) textLines.push('', '='.repeat(50), '');
    }

    textLines.push('', '**Next Steps:**');
    textLines.push('Use lua_set_tree to allocate these nodes and recalculate stats.');

    return {
      content: [
        {
          type: "text" as const,
          text: textLines.join('\n'),
        },
      ],
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text" as const,
          text: `Error: ${errorMsg}`,
        },
      ],
    };
  }
}


export async function handlePlanTreePaths(
  context: TreeHandlerContext,
  buildName: string | undefined,
  targetNodeIds: string[],
) {
  try {
    if (!targetNodeIds || targetNodeIds.length === 0) {
      return { content: [{ type: "text" as const, text: "No target node IDs provided." }] };
    }

    let allocatedNodeIds: string[] = [];
    let treeVersion = 'Unknown';

    if (buildName) {
      try {
        const build = await context.buildService.readBuild(buildName);
        allocatedNodeIds = context.buildService.parseAllocatedNodes(build);
        treeVersion = context.buildService.extractBuildVersion(build);
      } catch (fileErr) {
        if (buildName) throw fileErr;
      }
    }

    if (allocatedNodeIds.length === 0 && context.getLuaClient) {
      const luaClient = context.getLuaClient();
      if (luaClient) {
        const treeResult = await luaClient.getTree();
        allocatedNodeIds = (treeResult.nodes || []).map(String);
        treeVersion = treeResult.treeVersion || 'Unknown';
      }
    }

    if (allocatedNodeIds.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No allocated nodes found. Load a build first." }],
      };
    }

    const allocatedNodes = new Set<string>(allocatedNodeIds);
    const treeData = await context.treeService.getTreeData(treeVersion);

    // Find path to each target; collect per-target results
    const perTarget: Array<{
      nodeId: string;
      name: string;
      pathNodes: string[];
      cost: number;
      alreadyAllocated: boolean;
      notFound: boolean;
    }> = [];

    for (const nodeId of targetNodeIds) {
      const node = treeData.nodes.get(nodeId);
      if (!node) {
        perTarget.push({ nodeId, name: "NOT FOUND", pathNodes: [], cost: 0, alreadyAllocated: false, notFound: true });
        continue;
      }
      if (allocatedNodes.has(nodeId)) {
        perTarget.push({ nodeId, name: node.name || nodeId, pathNodes: [], cost: 0, alreadyAllocated: true, notFound: false });
        continue;
      }
      const paths = context.treeService.findShortestPaths(allocatedNodes, nodeId, treeData, 1);
      if (paths.length === 0) {
        perTarget.push({ nodeId, name: node.name || nodeId, pathNodes: [], cost: 0, alreadyAllocated: false, notFound: true });
      } else {
        perTarget.push({ nodeId, name: node.name || nodeId, pathNodes: paths[0].nodes, cost: paths[0].cost, alreadyAllocated: false, notFound: false });
      }
    }

    // Union all path nodes — deduplication is automatic via Set
    const unionNodes = new Set<string>();
    for (const t of perTarget) {
      for (const n of t.pathNodes) unionNodes.add(n);
    }

    // Track which nodes appear in multiple paths (shared)
    const nodePathCount = new Map<string, number>();
    for (const t of perTarget) {
      for (const n of t.pathNodes) nodePathCount.set(n, (nodePathCount.get(n) ?? 0) + 1);
    }
    const sharedNodes = [...nodePathCount.entries()]
      .filter(([, count]) => count > 1)
      .map(([id]) => id);

    const totalIndividual = perTarget.reduce((s, t) => s + t.cost, 0);
    const totalMerged = unionNodes.size;
    const saved = totalIndividual - totalMerged;

    const lines: string[] = [
      `=== Plan: ${targetNodeIds.length} target node(s) ===`,
      '',
    ];

    // Per-target breakdown
    lines.push('**Per-target paths:**');
    for (let i = 0; i < perTarget.length; i++) {
      const t = perTarget[i];
      if (t.notFound) {
        lines.push(`  ${i + 1}. ⚠️  ${t.nodeId} — not found in tree data`);
      } else if (t.alreadyAllocated) {
        lines.push(`  ${i + 1}. ✓  ${t.name} [${t.nodeId}] — already allocated`);
      } else {
        const node = treeData.nodes.get(t.nodeId);
        const typeTag = node?.isKeystone ? 'KEYSTONE' : node?.isNotable ? 'notable' : 'travel';
        const sharedCount = t.pathNodes.filter(n => sharedNodes.includes(n) && n !== t.nodeId).length;
        const sharedNote = sharedCount > 0 ? ` (${sharedCount} node(s) shared with other paths)` : '';
        lines.push(`  ${i + 1}. ${t.name} [${t.nodeId}] (${typeTag}) — ${t.cost} node(s)${sharedNote}`);
        // Show compact path
        const pathStr = t.pathNodes
          .map(n => {
            const nd = treeData.nodes.get(n);
            const label = nd?.isNotable || nd?.isKeystone ? `**${nd.name || n}**` : n;
            return label;
          })
          .join(' → ');
        lines.push(`     ${pathStr}`);
      }
    }
    lines.push('');

    // Shared nodes summary
    if (sharedNodes.length > 0) {
      lines.push(`**Shared path nodes (${sharedNodes.length}):** ${sharedNodes.join(', ')}`);
      lines.push('');
    }

    // Cost summary
    lines.push('**Cost summary:**');
    lines.push(`  Sum of individual paths: ${totalIndividual} nodes`);
    lines.push(`  After merging shared prefixes: ${totalMerged} nodes`);
    if (saved > 0) {
      lines.push(`  Points saved by merging: ${saved}`);
    }
    lines.push('');

    // Notable stats summary
    const notableIds = [...unionNodes].filter(n => {
      const nd = treeData.nodes.get(n);
      return nd?.isNotable || nd?.isKeystone;
    });
    if (notableIds.length > 0) {
      lines.push('**Notables/keystones included:**');
      for (const nid of notableIds) {
        const nd = treeData.nodes.get(nid);
        if (!nd) continue;
        const tag = nd.isKeystone ? 'KEYSTONE' : 'Notable';
        lines.push(`  - ${nd.name || nid} [${nid}] (${tag})`);
        if (nd.stats) {
          for (const s of nd.stats) lines.push(`      ${s}`);
        }
      }
      lines.push('');
    }

    // Combined node list for lua_set_tree
    const nodeList = [...unionNodes];
    lines.push('**Combined node list (add these to your lua_set_tree call):**');
    lines.push(JSON.stringify(nodeList));

    return { content: [{ type: "text" as const, text: lines.join('\n') }] };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text" as const, text: `Error: ${errorMsg}` }] };
  }
}

export async function handleGetPassiveUpgrades(
  context: PassiveUpgradesContext,
  focus: 'dps' | 'defence' | 'both' = 'both',
  maxResults: number = 10
) {
  await context.ensureLuaClient();
  const luaClient = context.getLuaClient();
  if (!luaClient) throw new Error('Lua bridge not active. Use lua_start and lua_load_build first.');

  // Step 1: get current base stats and issues to determine search keywords
  const { issues, stats: baseStats } = await handleGetBuildIssues(context);

  const { dps: baseDPS, ehp: baseEHP, mainSkillDps, isMinionMain } = await simBaseline(luaClient, baseStats);

  // Step 2: map focus + issues to search keywords
  // Use broad keywords that cover attack, spell, and generic damage scaling.
  // Avoid "critical" alone — at 100% crit it adds nothing.
  const keywords: string[] = [];

  if (focus === 'dps' || focus === 'both') {
    // A minion main skill scales off minion stats; attack/accuracy notables can never
    // move it, and searching them left every minion notable unevaluated.
    if (isMinionMain) keywords.push('minion', 'offering');
    else keywords.push('damage', 'attack speed', 'accuracy', 'physical');
  }

  if (focus === 'defence' || focus === 'both') {
    keywords.push('life', 'energy shield');
    const hasResistIssue = issues.some(i => i.category === 'resistance' && (i.severity === 'error' || i.severity === 'warning'));
    if (hasResistIssue) {
      keywords.push('resistance');
    }
  }

  // Step 3: search for notable candidates
  const seen = new Set<string>();
  const candidates: any[] = [];

  for (const keyword of keywords.slice(0, 5)) {
    try {
      const results = await luaClient.searchNodes({
        keyword,
        nodeType: 'notable',
        // 'minion' is the one keyword a minion build relies on; give it room.
        maxResults: keyword === 'minion' ? 30 : 12,
        includeAllocated: false,
      });
      if (results && results.nodes) {
        for (const node of results.nodes) {
          const id = String(node.id);
          if (!seen.has(id)) {
            seen.add(id);
            candidates.push(node);
          }
        }
      }
    } catch { /* skip failed searches */ }
  }

  // search_nodes matches the whole tree, including other classes' ascendancies and
  // Blight notables (anoint-only, never reachable with a passive point). Ranking one of
  // those first sends the caller hunting for a path that does not exist. (Upstream b36a9b4.)
  const ownAscendancy = (await luaClient.getBuildInfo().catch(() => null))?.ascendClassName ?? '';
  const isSimulatable = (node: any): boolean => {
    const ascendancy = node.ascendancy ?? node.ascendancyName ?? '';
    const isForeignAscendancy = ascendancy !== '' && ascendancy !== ownAscendancy;
    const isMastery = node.isMastery === true || node.type === 'Mastery';
    const isAnointOnly = node.isBlighted === true;
    return !isForeignAscendancy && !isMastery && !isAnointOnly;
  };
  const before = candidates.length;
  candidates.splice(0, candidates.length, ...candidates.filter(isSimulatable));
  const skippedForeign = before - candidates.length;

  if (candidates.length === 0) {
    return {
      content: [{
        type: 'text' as const,
        text: `=== Passive Upgrades (focus: ${focus}) ===\n\nNo unallocated notable candidates found. Make sure a build is loaded.\n`,
      }],
    };
  }

  // Step 4: simulate each candidate with calcWith
  interface ScoredNode {
    node: any;
    dpsDelta: number;
    ehpDelta: number;
    score: number;
  }

  const scored: ScoredNode[] = [];

  for (const node of candidates) {
    try {
      const out = await luaClient.calcWith({ addNodes: [node.id] });
      if (!out) continue;

      // calcWith returns raw Lua output; minion stats are nested under out.Minion
      // (unlike getStats() which remaps them to MinionTotalDPS etc.)
      const outDPS = simDPS(out) || baseDPS;
      const outEHP = simEHP(out) || baseEHP;

      const dpsDelta = outDPS - baseDPS;
      const ehpDelta = outEHP - baseEHP;

      // Relative score weighted by focus
      let score: number;
      if (focus === 'dps') {
        score = dpsDelta / baseDPS;
      } else if (focus === 'defence') {
        score = ehpDelta / baseEHP;
      } else {
        score = (dpsDelta / baseDPS) + (ehpDelta / baseEHP);
      }

      scored.push({ node, dpsDelta, ehpDelta, score });
    } catch { /* skip nodes that fail calcWith */ }
  }

  // Step 5: sort and return top N
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, maxResults);

  const textLines: string[] = [
    `=== Passive Upgrades (focus: ${focus}) ===`,
    '',
    `Base DPS: ${mainSkillDps > 0 ? `${Math.round(baseDPS).toLocaleString("en-US")} (main skill)` : 'n/a'}  |  Base EHP: ${Math.round(baseEHP).toLocaleString("en-US")}`,
    ...(mainSkillDps > 0 ? [] : [NO_MAIN_SKILL_DPS_NOTE]),
    `Evaluated ${candidates.length} candidate notables, showing top ${top.length}:`,
    ...(skippedForeign > 0
      ? [`(skipped ${skippedForeign} node(s) this build cannot allocate: other ascendancies, masteries, or anoint-only Blight notables)`]
      : []),
    '',
  ];

  for (let i = 0; i < top.length; i++) {
    const { node, dpsDelta, ehpDelta, score } = top[i];
    textLines.push(`${i + 1}. **${node.name}** [${node.id}]`);
    let scoreLine = `   Score: ${score.toFixed(4)}`;
    if (dpsDelta !== 0) scoreLine += `  |  DPS Δ: ${dpsDelta > 0 ? '+' : ''}${Math.round(dpsDelta).toLocaleString("en-US")}`;
    if (ehpDelta !== 0) scoreLine += `  |  EHP Δ: ${ehpDelta > 0 ? '+' : ''}${Math.round(ehpDelta).toLocaleString("en-US")}`;
    textLines.push(scoreLine);
    if (node.stats && node.stats.length > 0) {
      for (const stat of (node.stats as string[]).slice(0, 2)) {
        textLines.push(`   - ${stat}`);
      }
    }
    textLines.push('');
  }

  if (top.length === 0) {
    textLines.push('No results after simulation. Try a different focus or ensure a build is loaded.');
  } else {
    textLines.push('', '💡 Use lua_set_tree to allocate the top node and recalculate stats.');
  }

  return {
    content: [{ type: 'text' as const, text: textLines.join('\n') }],
  };
}

interface ScoredEffect {
  stat: string;
  dpsDelta: number;
  ehpDelta: number;
}

export async function handleSuggestMasteries(context: PassiveUpgradesContext) {
  await context.ensureLuaClient();
  const luaClient = context.getLuaClient();
  if (!luaClient) throw new Error('Lua bridge not active. Use lua_load_build first.');

  const data = await luaClient.getMasteryOptions();
  // Lua returns: { masteries: [{ nodeId, name, options: [{ effectId, stats: string[], selected: bool }] }] }
  const allMasteries: any[] = data?.masteries ?? [];

  // Only show masteries that have a selected effect (i.e. the node is allocated and an effect chosen)
  const masteries = allMasteries.filter((m: any) =>
    (m.options ?? []).some((o: any) => o.selected)
  );

  if (masteries.length === 0) {
    return {
      content: [{ type: 'text' as const, text: '=== Mastery Suggestions ===\n\nNo allocated mastery effects found in the current build.\n' }],
    };
  }

  // Get base stats for scoring
  const baseStats = await luaClient.getStats(['TotalDPS', 'CombinedDPS', 'MinionTotalDPS', 'TotalEHP', 'Life']);
  const { dps: baseDPS, ehp: baseEHP, mainSkillDps } = await simBaseline(luaClient, baseStats);

  // Current mastery effect map: { nodeId: effectId } from selected options
  const currentMasteryEffects: Record<number, number> = {};
  for (const m of allMasteries) {
    const selected = (m.options ?? []).find((o: any) => o.selected);
    if (selected) currentMasteryEffects[m.nodeId] = selected.effectId;
  }

  const outputLines: string[] = ['=== Mastery Node Suggestions ===', '', ...(mainSkillDps > 0 ? [] : [NO_MAIN_SKILL_DPS_NOTE, ''])];

  for (const mastery of masteries) {
    const options: any[] = mastery.options ?? [];
    const currentOption = options.find((o: any) => o.selected);
    const currentStat = currentOption?.stats?.join(' / ') ?? String(currentOption?.effectId ?? '?');

    outputLines.push(`**${mastery.name ?? 'Mastery'}** (node ${mastery.nodeId})`);
    outputLines.push(`  Current: ${currentStat}`);

    // Simulate each alternative effect choice
    const scored: ScoredEffect[] = [];
    for (const effect of options) {
      try {
        const newMasteryEffects = { ...currentMasteryEffects, [mastery.nodeId]: effect.effectId };
        const out = await luaClient.calcWith({ masteryEffects: newMasteryEffects });
        if (!out) continue;
        const outDPS = simDPS(out) || baseDPS;
        const outEHP = simEHP(out) || baseEHP;
        const statStr = effect.stats?.join(' / ') ?? String(effect.effectId);
        scored.push({ stat: statStr, dpsDelta: outDPS - baseDPS, ehpDelta: outEHP - baseEHP });
      } catch { /* skip effects that fail simulation */ }
    }

    scored.sort((a, b) =>
      ((b.dpsDelta / baseDPS) + (b.ehpDelta / baseEHP)) -
      ((a.dpsDelta / baseDPS) + (a.ehpDelta / baseEHP))
    );
    if (scored.length === 0) {
      outputLines.push('  (simulation unavailable for this mastery)');
    }
    for (const s of scored.slice(0, 3)) {
      const dpsStr = s.dpsDelta !== 0 ? ` | DPS ${s.dpsDelta > 0 ? '+' : ''}${Math.round(s.dpsDelta)}` : '';
      const ehpStr = s.ehpDelta !== 0 ? ` | EHP ${s.ehpDelta > 0 ? '+' : ''}${Math.round(s.ehpDelta)}` : '';
      const marker = s.stat === currentStat ? ' ← current' : '';
      outputLines.push(`  - ${s.stat}${dpsStr}${ehpStr}${marker}`);
    }
    outputLines.push('');
  }

  return { content: [{ type: 'text' as const, text: outputLines.join('\n') }] };
}

// Helper function
function formatTreeComparison(comparison: TreeComparison): string {
  const lines: string[] = [
    '=== Passive Tree Comparison ===',
    '',
    `Build 1: ${comparison.build1.name}`,
    `Build 2: ${comparison.build2.name}`,
    '',
    '=== Point Allocation ===',
    `Build 1: ${comparison.build1.analysis.totalPoints} points`,
    `Build 2: ${comparison.build2.analysis.totalPoints} points`,
    `Difference: ${Math.abs(comparison.differences.pointDifference)} points ` +
      (comparison.differences.pointDifference > 0 ? '(Build 1 has more)' : '(Build 2 has more)'),
    '',
    '=== Archetype Comparison ===',
    comparison.differences.archetypeDifference,
    '',
    '=== Keystones Comparison ===',
    `Build 1 Keystones: ${comparison.build1.analysis.keystones.map(k => k.name).join(', ') || 'None'}`,
    `Build 2 Keystones: ${comparison.build2.analysis.keystones.map(k => k.name).join(', ') || 'None'}`,
  ];

  // Unique keystones
  const uniqueKeystones1 = comparison.differences.uniqueToBuild1.filter(n => n.isKeystone);
  const uniqueKeystones2 = comparison.differences.uniqueToBuild2.filter(n => n.isKeystone);

  if (uniqueKeystones1.length > 0) {
    lines.push('\nUnique to Build 1:');
    for (const ks of uniqueKeystones1) {
      lines.push(`- ${ks.name}`);
    }
  }

  if (uniqueKeystones2.length > 0) {
    lines.push('\nUnique to Build 2:');
    for (const ks of uniqueKeystones2) {
      lines.push(`- ${ks.name}`);
    }
  }

  // Notables comparison
  lines.push(
    '',
    '=== Notable Passives Comparison ===',
    `Build 1: ${comparison.build1.analysis.notables.length} notables`,
    `Build 2: ${comparison.build2.analysis.notables.length} notables`
  );

  const uniqueNotables1 = comparison.differences.uniqueToBuild1.filter(n => n.isNotable);
  const uniqueNotables2 = comparison.differences.uniqueToBuild2.filter(n => n.isNotable);

  if (uniqueNotables1.length > 0) {
    lines.push('\nTop 5 Unique Notables to Build 1:');
    for (const notable of uniqueNotables1.slice(0, 5)) {
      lines.push(`- ${notable.name || 'Unnamed'}`);
    }
  }

  if (uniqueNotables2.length > 0) {
    lines.push('\nTop 5 Unique Notables to Build 2:');
    for (const notable of uniqueNotables2.slice(0, 5)) {
      lines.push(`- ${notable.name || 'Unnamed'}`);
    }
  }

  // Pathing efficiency
  lines.push(
    '',
    '=== Pathing Efficiency ===',
    `Build 1: ${comparison.build1.analysis.pathingEfficiency}`,
    `Build 2: ${comparison.build2.analysis.pathingEfficiency}`,
    '',
    '=== Shared Nodes ===',
    `${comparison.differences.sharedNodes.length} nodes are allocated in both builds`
  );

  return lines.join('\n');
}

export async function handleGetNodePower(
  context: TreeHandlerContext,
  mode?: string,
  filter?: string,
  maxDepth?: number,
  limit?: number,
  recalculate?: boolean,
) {
  const luaClient = context.getLuaClient?.();
  if (!luaClient) {
    return {
      content: [{ type: "text" as const, text: "No live PoB connection. Launch PoB via LaunchPoBWithAPI.bat and connect first." }],
    };
  }

  const params: Record<string, any> = {};
  if (mode) params.mode = mode;
  if (filter) params.filter = filter;
  if (maxDepth !== undefined) params.max_depth = maxDepth;
  if (limit !== undefined) params.limit = limit;
  if (recalculate !== undefined) params.recalculate = recalculate;

  const data = await (luaClient as any).getNodePower(params);

  if (!data.has_data) {
    const pending = data.recalc_pending;
    const lines = ["=== Node Power ===", ""];
    if (pending) {
      lines.push(
        "Recalculation in progress — PoB is computing node power in the background.",
        "Call this tool again in a few seconds to see results.",
      );
    } else {
      lines.push(
        "No power data available. Either:",
        "  1. Enable 'Show Node Power' in PoB's Tree tab, or",
        "  2. Call this tool with recalculate=true to trigger computation.",
      );
    }
    lines.push("", `Filter: ${data.filter}  |  Mode: ${data.mode}`);
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }

  const effectiveMode = data.mode as string;
  const effectiveFilter = data.filter as string;
  const nodes = data.nodes as any[];
  const powerMax = data.power_max as { offence: number; defence: number };

  const modeLabel = effectiveMode === "offence" ? "Offence" : effectiveMode === "defence" ? "Defence" : "Combined";
  const filterLabel = effectiveFilter === "unallocated" ? "Unallocated" : effectiveFilter === "allocated" ? "Allocated" : "All";
  const depthLabel = maxDepth !== undefined ? ` | Max depth: ${maxDepth}` : "";

  const lines: string[] = [
    "=== Node Power Rankings ===",
    "",
    `Sort: ${modeLabel}  |  Filter: ${filterLabel}${depthLabel}  |  Showing: ${nodes.length} of ${data.total}`,
    `Power max — Offence: ${powerMax.offence.toFixed(4)}  Defence: ${powerMax.defence.toFixed(4)}`,
    "",
  ];

  // Column header
  lines.push(
    `${"Rank".padEnd(5)} ${"Node".padEnd(34)} ${"Type".padEnd(12)} ${"Off".padStart(8)} ${"Def".padStart(8)} ${"Comb".padStart(8)}${maxDepth !== undefined ? "  Depth" : ""}`,
    `${"----".padEnd(5)} ${"----".padEnd(34)} ${"----".padEnd(12)} ${"---".padStart(8)} ${"---".padStart(8)} ${"----".padStart(8)}${maxDepth !== undefined ? "  -----" : ""}`,
  );

  nodes.forEach((node: any, i: number) => {
    const rank = String(i + 1).padEnd(5);
    const name = (node.name as string).slice(0, 34).padEnd(34);
    const type = (node.type as string).slice(0, 12).padEnd(12);
    const off = (node.offence as number).toFixed(4).padStart(8);
    const def = (node.defence as number).toFixed(4).padStart(8);
    const comb = (node.combined as number).toFixed(4).padStart(8);
    const depth = node.depth !== null && node.depth !== undefined ? `  ${String(node.depth).padStart(5)}` : "";
    lines.push(`${rank} ${name} ${type} ${off} ${def} ${comb}${maxDepth !== undefined ? depth : ""}`);
  });

  if (data.recalc_pending) {
    lines.push("", "(Recalculation still in progress — call again for more complete results.)");
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}

// ---------------------------------------------------------------------------
// connect_nodes: cheapest connected tree through a set of target nodes
// ---------------------------------------------------------------------------

const ALLOCATED_HUB = '__allocated__';
const CLASS_START_NAMES = new Set(['Scion', 'Marauder', 'Ranger', 'Witch', 'Duelist', 'Templar', 'Shadow']);
const MAX_CONNECT_TARGETS = 40;

/** Stats reported when validating the result with calcWith. */
const CONNECT_VALIDATION_STATS: Array<[string, string]> = [
  ['CombinedDPS', 'Combined DPS'],
  ['TotalDPS', 'Total DPS'],
  ['Life', 'Life'],
  ['EnergyShield', 'Energy Shield'],
  ['TotalEHP', 'Total EHP'],
  ['FireResist', 'Fire resist'],
  ['ColdResist', 'Cold resist'],
  ['LightningResist', 'Lightning resist'],
  ['ChaosResist', 'Chaos resist'],
];

interface ConnectNodesContext extends TreeHandlerContext {
  pobDirectory?: string;
  ensureLuaClient?: () => Promise<void>;
}

/**
 * Build the graph the solver works on: every allocated node collapsed into one
 * free hub, with nodes PoB cannot path through (other classes' start nodes,
 * masteries, ascendancies that are neither allocated nor targeted) removed.
 */
function buildConnectGraph(treeData: PassiveTreeData, allocated: Set<string>, targets: string[]): PassiveTreeData {
  const allowedAscendancies = new Set<string>();
  for (const id of [...allocated, ...targets]) {
    const asc = treeData.nodes.get(id)?.ascendancyName;
    if (asc) allowedAscendancies.add(asc);
  }
  const eligible = (id: string): boolean => {
    const node = treeData.nodes.get(id);
    if (!node || node.isMastery) return false;
    if (allocated.has(id)) return true; // folded into the hub below
    if (node.name && CLASS_START_NAMES.has(node.name) && !node.stats?.length) return false;
    if (node.ascendancyName && !allowedAscendancies.has(node.ascendancyName)) return false;
    return true;
  };

  // Symmetric adjacency: the tree lists most edges on both ends, not all.
  const neighbors = new Map<string, Set<string>>();
  for (const [id, node] of treeData.nodes) {
    for (const other of [...(node.out ?? []), ...(node.in ?? [])]) {
      if (!treeData.nodes.has(other)) continue;
      if (!neighbors.has(id)) neighbors.set(id, new Set());
      if (!neighbors.has(other)) neighbors.set(other, new Set());
      neighbors.get(id)!.add(other);
      neighbors.get(other)!.add(id);
    }
  }

  const nodes = new Map<string, PassiveTreeNode>();
  const hubOut = new Set<string>();
  for (const [id, node] of treeData.nodes) {
    if (allocated.has(id) || !eligible(id)) continue;
    const out = new Set<string>();
    for (const other of neighbors.get(id) ?? []) {
      if (!eligible(other)) continue;
      if (allocated.has(other)) {
        out.add(ALLOCATED_HUB);
        hubOut.add(id);
      } else {
        out.add(other);
      }
    }
    nodes.set(id, { skill: node.skill, name: node.name, out: [...out], in: [] });
  }
  nodes.set(ALLOCATED_HUB, { skill: -1, name: 'allocated tree', out: [...hubOut], in: [] });
  return { nodes, version: treeData.version };
}

export async function handleConnectNodes(
  context: ConnectNodesContext,
  buildName: string | undefined,
  targetNodeIds: string[],
  validate: boolean = true
) {
  try {
    const targets = [...new Set((targetNodeIds ?? []).map(String))];
    if (targets.length === 0) throw new Error('target_node_ids must contain at least one node ID');
    if (targets.length > MAX_CONNECT_TARGETS) {
      throw new Error(`Too many targets (${targets.length}); the maximum is ${MAX_CONNECT_TARGETS}`);
    }

    let allocatedIds: string[] = [];
    let treeVersion: string | undefined;
    let luaClient: AnyLuaClient | null = null;

    if (buildName) {
      const build = await context.buildService.readBuild(buildName);
      allocatedIds = context.buildService.parseAllocatedNodes(build);
      treeVersion = context.buildService.extractBuildVersion(build);
      // The stat preview runs against the build open in PoB; a named file build is
      // only previewed when no build_name is given (TCP mode cannot switch builds).
      luaClient = null;
    } else {
      if (context.ensureLuaClient) await context.ensureLuaClient();
      luaClient = context.getLuaClient?.() ?? null;
      if (!luaClient) throw new Error('Provide a build_name, or load a build with lua_load_build first.');
      const tree = await luaClient.getTree();
      allocatedIds = (tree.nodes || []).map(String);
      treeVersion = tree.treeVersion;
    }
    if (allocatedIds.length === 0) throw new Error('The build has no allocated passive nodes to connect from.');

    const treeData = await context.treeService.getTreeData(treeVersion);
    const missing = targets.filter(id => !treeData.nodes.has(id));
    if (missing.length > 0) throw new Error(`Node(s) not found in tree data: ${missing.join(', ')}`);

    const allocated = new Set(allocatedIds.filter(id => treeData.nodes.has(id)));
    const masteries = targets.filter(id => treeData.nodes.get(id)?.isMastery);
    if (masteries.length > 0) {
      throw new Error(`Mastery nodes are selected through their parent notable, not pathed to: ${masteries.join(', ')}`);
    }
    const alreadyAllocated = targets.filter(id => allocated.has(id));
    const pending = targets.filter(id => !allocated.has(id));
    const label = (id: string) => `${treeData.nodes.get(id)?.name || 'Node'} [${id}]`;

    const lines: string[] = ['=== Cheapest Connection ===', '', `Build: ${buildName || '(in-memory build)'}`, `Targets: ${targets.length}`];
    if (alreadyAllocated.length > 0) {
      lines.push(`Already allocated: ${alreadyAllocated.map(label).join(', ')}`);
    }
    if (pending.length === 0) {
      lines.push('', 'Every target is already allocated; nothing to connect.');
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    }

    const graph = buildConnectGraph(treeData, allocated, pending);
    const solver = new SteinerSolver(graph, new Set([ALLOCATED_HUB, ...pending]));
    const result = solver.solve();

    const unreachable = result.unreachable.filter(id => id !== ALLOCATED_HUB);
    if (result.unreachable.includes(ALLOCATED_HUB) || result.terminalCount < 2) {
      lines.push('', 'No target can be reached from the allocated tree (different class region or an ascendancy you have not started).');
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    }

    const chosen = new Set([...result.nodes].filter(id => id !== ALLOCATED_HUB));
    // Allocation order: breadth-first outward from the allocated tree.
    const ordered: string[] = [];
    const seen = new Set<string>([ALLOCATED_HUB]);
    let frontier: string[] = [ALLOCATED_HUB];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const nb of graph.nodes.get(id)?.out ?? []) {
          if (!seen.has(nb) && chosen.has(nb)) {
            seen.add(nb);
            ordered.push(nb);
            next.push(nb);
          }
        }
      }
      frontier = next;
    }

    // Baseline: price each target on its own with no sharing between paths.
    let separate = 0;
    for (const id of pending) {
      if (unreachable.includes(id)) continue;
      const single = new SteinerSolver(graph, new Set([ALLOCATED_HUB, id])).solve();
      separate += single.nodes.size - 1;
    }

    const method = result.method === 'exact'
      ? 'exact (proven minimum)'
      : result.method === 'reduced-dp'
        ? 'dynamic programming on the shortest-path corridor (near-optimal, not proven)'
        : `KMB approximation (at most about 2x the minimum travel)${result.timedOut ? '; the exact search timed out' : ''}`;
    const targetCount = ordered.filter(id => pending.includes(id)).length;
    lines.push(
      `Method: ${method}`,
      `Passive points to spend: ${ordered.length} (${ordered.length - targetCount} travel + ${targetCount} target)`,
      `Separate shortest paths with no sharing would cost: ${separate} (saved ${separate - ordered.length})`,
      ''
    );
    if (unreachable.length > 0) {
      lines.push(`Unreachable targets (skipped): ${unreachable.map(label).join(', ')}`, '');
    }
    lines.push('Allocation order:');
    ordered.forEach((id, i) => {
      const isTarget = pending.includes(id);
      lines.push(`  ${i + 1}. ${label(id)}${isTarget ? ' <- TARGET' : ''}`);
      if (isTarget) for (const stat of treeData.nodes.get(id)?.stats ?? []) lines.push(`       ${stat}`);
    });
    lines.push('', `Node IDs: ${ordered.join(', ')}`);

    if (validate && luaClient) {
      try {
        const { output, base } = await luaClient.calcWithDetail({
          addNodes: ordered.map(Number),
          fields: CONNECT_VALIDATION_STATS.map(([key]) => key),
        });
        const deltas: string[] = [];
        for (const [key, title] of CONNECT_VALIDATION_STATS) {
          const before = base?.[key];
          const after = output?.[key];
          if (typeof before !== 'number' || typeof after !== 'number' || before === after) continue;
          const diff = after - before;
          deltas.push(`  ${title}: ${Math.round(before).toLocaleString("en-US")} -> ${Math.round(after).toLocaleString("en-US")} (${diff > 0 ? '+' : ''}${Math.round(diff).toLocaleString("en-US")})`);
        }
        // Minion builds: the player's DPS is 0, the minions' is what moves.
        const mBefore = base?.Minion?.CombinedDPS;
        const mAfter = output?.Minion?.CombinedDPS;
        if (typeof mBefore === 'number' && typeof mAfter === 'number' && mBefore !== mAfter) {
          const diff = mAfter - mBefore;
          deltas.unshift(`  Minion DPS: ${Math.round(mBefore).toLocaleString("en-US")} -> ${Math.round(mAfter).toLocaleString("en-US")} (${diff > 0 ? '+' : ''}${Math.round(diff).toLocaleString("en-US")})`);
        }
        lines.push('', '=== Stat change if allocated (PoB calcWith) ===');
        lines.push(...(deltas.length > 0 ? deltas : ['  No change in the tracked stats.']));
      } catch (e) {
        console.error('[connect_nodes] calcWith validation skipped:', e);
        lines.push('', `Stat validation skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (validate) {
      lines.push('', buildName
        ? 'Stat preview skipped: it runs on the build open in PoB. Omit build_name to path and preview the loaded build.'
        : 'Stat preview skipped: the Lua bridge is not running.');
    }
    lines.push('', 'To apply: update_tree_delta with add_nodes set to the Node IDs above.');

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  } catch (error) {
    return {
      content: [{ type: 'text' as const, text: `Error connecting nodes: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}
