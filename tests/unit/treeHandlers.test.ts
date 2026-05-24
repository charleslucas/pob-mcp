import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { handleCompareTrees, handleGetNearbyNodes, handleFindPath } from '../../src/handlers/treeHandlers';
import type { TreeHandlerContext } from '../../src/handlers/treeHandlers';
import type { PassiveTreeData } from '../../src/types';

function makeTreeData(): PassiveTreeData {
  return {
    version: '3_26',
    nodes: new Map([
      ['A', { skill: 1, name: 'Start', out: ['B'], in: [] }],
      ['B', { skill: 2, name: 'Travel B', out: ['C'], in: ['A'] }],
      ['C', { skill: 3, name: 'Notable C', isNotable: true, stats: ['+10 Str'], out: [], in: ['B'] }],
      ['D', { skill: 4, name: 'Keystone D', isKeystone: true, stats: ['No mana cost'], out: [], in: ['A'] }],
    ]),
    classes: [],
    groups: [],
  };
}

function makeContext(overrides: Partial<TreeHandlerContext> = {}): TreeHandlerContext {
  return {
    buildService: {
      readBuild: jest.fn<() => Promise<any>>().mockResolvedValue({}),
      parseAllocatedNodes: jest.fn<() => string[]>().mockReturnValue(['A']),
      extractBuildVersion: jest.fn<() => string>().mockReturnValue('3_26'),
      getActiveSpec: jest.fn<() => any>().mockReturnValue({ nodes: ['A'] }),
    } as any,
    treeService: {
      getTreeData: jest.fn<() => Promise<PassiveTreeData>>().mockResolvedValue(makeTreeData()),
      analyzePassiveTree: jest.fn<() => Promise<any>>().mockResolvedValue({
        allocatedNodes: [{ skill: 1, name: 'Start' }],
        totalPoints: 1,
        archetype: 'Life-based',
        keystones: [],
        notables: [],
      }),
      findNearbyNodes: jest.fn<() => any[]>().mockReturnValue([]),
      findShortestPaths: jest.fn<() => any[]>().mockReturnValue([{ nodes: ['B', 'C'], cost: 2 }]),
    } as any,
    getLuaClient: jest.fn<() => null>().mockReturnValue(null),
    ...overrides,
  };
}

// ── handleCompareTrees ────────────────────────────────────────────────────────

describe('handleCompareTrees', () => {
  it('returns comparison output for two builds', async () => {
    const ctx = makeContext();
    const build1: any = { Build: {}, passive: {} };
    const build2: any = { Build: {}, passive: {} };
    (ctx.buildService.readBuild as jest.Mock<() => Promise<any>>)
      .mockResolvedValueOnce(build1)
      .mockResolvedValueOnce(build2);
    (ctx.treeService.analyzePassiveTree as jest.Mock<() => Promise<any>>)
      .mockResolvedValueOnce({ allocatedNodes: [{ skill: 1, name: 'A' }], totalPoints: 1, archetype: 'Life-based', keystones: [], notables: [] })
      .mockResolvedValueOnce({ allocatedNodes: [{ skill: 2, name: 'B' }], totalPoints: 1, archetype: 'Life-based', keystones: [], notables: [] });

    const result = await handleCompareTrees(ctx, 'build1.xml', 'build2.xml');
    expect(result.content[0].text).toBeTruthy();
    expect(typeof result.content[0].text).toBe('string');
  });

  it('throws when build file cannot be read', async () => {
    const ctx = makeContext();
    (ctx.buildService.readBuild as jest.Mock<() => Promise<any>>).mockRejectedValue(new Error('File not found'));
    await expect(handleCompareTrees(ctx, 'missing.xml', 'other.xml')).rejects.toThrow();
  });

  it('throws when tree analysis returns null', async () => {
    const ctx = makeContext();
    (ctx.treeService.analyzePassiveTree as jest.Mock<() => Promise<any>>).mockResolvedValue(null);
    await expect(handleCompareTrees(ctx, 'b1.xml', 'b2.xml')).rejects.toThrow('lack passive tree data');
  });
});

// ── handleGetNearbyNodes ──────────────────────────────────────────────────────

describe('handleGetNearbyNodes', () => {
  it('returns no-nodes message when tree service finds nothing', async () => {
    const ctx = makeContext();
    (ctx.treeService.findNearbyNodes as jest.Mock).mockReturnValue([]);
    const result = await handleGetNearbyNodes(ctx, 'build.xml');
    expect(result.content[0].text).toContain('No notable');
  });

  it('lists nearby nodes when found', async () => {
    const ctx = makeContext();
    (ctx.treeService.findNearbyNodes as jest.Mock).mockReturnValue([
      { node: { name: 'Notable C', isNotable: true, stats: ['+10 Str'] }, nodeId: 'C', distance: 2, pathCost: 2 },
    ]);
    const result = await handleGetNearbyNodes(ctx, 'build.xml');
    expect(result.content[0].text).toContain('Notable C');
  });

  it('returns no-allocation message when no nodes found and no lua client', async () => {
    const ctx = makeContext();
    (ctx.buildService.parseAllocatedNodes as jest.Mock).mockReturnValue([]);
    const result = await handleGetNearbyNodes(ctx, undefined);
    expect(result.content[0].text).toContain('No allocated nodes');
  });

  it('falls back to lua client for allocation', async () => {
    const luaClient = {
      getTree: jest.fn<() => Promise<any>>().mockResolvedValue({ nodes: ['A'], treeVersion: '3_26' }),
    };
    const ctx = makeContext({ getLuaClient: jest.fn<() => any>().mockReturnValue(luaClient) });
    (ctx.treeService.findNearbyNodes as jest.Mock).mockReturnValue([
      { node: { name: 'Notable C', isNotable: true, stats: [] }, nodeId: 'C', distance: 2, pathCost: 2 },
    ]);
    const result = await handleGetNearbyNodes(ctx, undefined);
    expect(luaClient.getTree).toHaveBeenCalled();
    expect(result.content[0].text).toContain('Notable C');
  });

  it('passes max_distance to findNearbyNodes', async () => {
    const ctx = makeContext();
    await handleGetNearbyNodes(ctx, 'build.xml', 7);
    expect(ctx.treeService.findNearbyNodes).toHaveBeenCalledWith(
      expect.any(Set), expect.anything(), 7, undefined
    );
  });
});

// ── handleFindPath ────────────────────────────────────────────────────────────

describe('handleFindPath', () => {
  it('returns path when found', async () => {
    const ctx = makeContext();
    const result = await handleFindPath(ctx, 'build.xml', 'C');
    expect(result.content[0].text).toContain('C');
  });

  it('returns error when target node not in tree data', async () => {
    const ctx = makeContext();
    const result = await handleFindPath(ctx, 'build.xml', 'NONEXISTENT');
    expect(result.content[0].text).toMatch(/Error|not found/i);
  });

  it('returns no-allocation message when no nodes found', async () => {
    const ctx = makeContext();
    (ctx.buildService.parseAllocatedNodes as jest.Mock).mockReturnValue([]);
    const result = await handleFindPath(ctx, undefined, 'C');
    expect(result.content[0].text).toContain('No allocated nodes');
  });

  it('throws on explicit build_name when file read fails', async () => {
    const ctx = makeContext();
    (ctx.buildService.readBuild as jest.Mock<() => Promise<any>>).mockRejectedValue(new Error('not found'));
    (ctx.buildService.getActiveSpec as jest.Mock).mockReturnValue(null);
    const result = await handleFindPath(ctx, 'bad.xml', 'C');
    expect(result.content[0].text).toMatch(/Error/i);
  });

  it('falls back to lua client when no build_name given', async () => {
    const luaClient = {
      getTree: jest.fn<() => Promise<any>>().mockResolvedValue({ nodes: ['A'], treeVersion: '3_26' }),
    };
    const ctx = makeContext({ getLuaClient: jest.fn<() => any>().mockReturnValue(luaClient) });
    await handleFindPath(ctx, undefined, 'C');
    expect(luaClient.getTree).toHaveBeenCalled();
  });
});
