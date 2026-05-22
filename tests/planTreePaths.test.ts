import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { handlePlanTreePaths } from '../src/handlers/treeHandlers';
import type { TreeHandlerContext } from '../src/handlers/treeHandlers';
import type { PassiveTreeData } from '../src/types';

// Minimal PassiveTreeData factory for tests.
// Nodes: A(start, allocated) -- B(travel) -- C(notable) -- D(notable), plus E(isolated)
// Adjacency (bidirectional): A↔B, B↔C, B↔D
function makeTreeData(): PassiveTreeData {
  return {
    version: '3_26',
    nodes: new Map([
      ['A', { skill: 1, name: 'Start', out: ['B'], in: [] }],
      ['B', { skill: 2, name: 'Travel B', out: ['C', 'D'], in: ['A'] }],
      ['C', { skill: 3, name: 'Notable C', isNotable: true, stats: ['+10 Str'], out: [], in: ['B'] }],
      ['D', { skill: 4, name: 'Notable D', isNotable: true, stats: ['+10 Dex'], out: [], in: ['B'] }],
      ['E', { skill: 5, name: 'Isolated E', isNotable: true, out: [], in: [] }],
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
    } as any,
    treeService: {
      getTreeData: jest.fn<() => Promise<PassiveTreeData>>().mockResolvedValue(makeTreeData()),
      findShortestPaths: jest.fn<() => Array<{ nodes: string[]; cost: number }>>(),
    } as any,
    getLuaClient: jest.fn<() => null>().mockReturnValue(null),
    ...overrides,
  };
}

describe('handlePlanTreePaths', () => {
  describe('input validation', () => {
    it('returns early when target list is empty', async () => {
      const ctx = makeContext();
      const result = await handlePlanTreePaths(ctx, undefined, []);
      expect(result.content[0].text).toContain('No target node IDs provided');
    });

    it('returns error when no allocated nodes can be found', async () => {
      const ctx = makeContext();
      (ctx.buildService.parseAllocatedNodes as jest.Mock).mockReturnValue([]);
      (ctx.getLuaClient as jest.Mock).mockReturnValue(null);

      const result = await handlePlanTreePaths(ctx, undefined, ['C']);
      expect(result.content[0].text).toContain('No allocated nodes found');
    });
  });

  describe('target states', () => {
    it('marks a target as already allocated', async () => {
      const ctx = makeContext();
      // A is in the allocated set
      const result = await handlePlanTreePaths(ctx, 'build.xml', ['A']);
      expect(result.content[0].text).toContain('already allocated');
    });

    it('marks an unknown node ID as not found', async () => {
      const ctx = makeContext();
      (ctx.treeService.findShortestPaths as jest.Mock).mockReturnValue([]);

      const result = await handlePlanTreePaths(ctx, 'build.xml', ['UNKNOWN']);
      expect(result.content[0].text).toContain('not found in tree data');
    });

    it('marks a reachable node as not found when findShortestPaths returns empty', async () => {
      const ctx = makeContext();
      // E exists in the tree but is isolated — BFS returns no path
      (ctx.treeService.findShortestPaths as jest.Mock).mockReturnValue([]);

      const result = await handlePlanTreePaths(ctx, 'build.xml', ['E']);
      expect(result.content[0].text).toContain('not found in tree data');
    });
  });

  describe('single target', () => {
    it('returns path nodes and cost summary for one reachable notable', async () => {
      const ctx = makeContext();
      (ctx.treeService.findShortestPaths as jest.Mock).mockReturnValue([
        { nodes: ['B', 'C'], cost: 2 },
      ]);

      const result = await handlePlanTreePaths(ctx, 'build.xml', ['C']);
      const text = result.content[0].text;

      expect(text).toContain('Notable C');
      expect(text).toContain('2 node(s)');
      expect(text).toContain('Cost summary');
      // Combined node list JSON should be present
      expect(text).toContain('["B","C"]');
    });

    it('includes notable stat lines in the output', async () => {
      const ctx = makeContext();
      (ctx.treeService.findShortestPaths as jest.Mock).mockReturnValue([
        { nodes: ['B', 'C'], cost: 2 },
      ]);

      const result = await handlePlanTreePaths(ctx, 'build.xml', ['C']);
      expect(result.content[0].text).toContain('+10 Str');
    });
  });

  describe('multiple targets with shared nodes', () => {
    it('deduplicates shared path nodes and reports savings', async () => {
      const ctx = makeContext();
      // C and D both require B; individual cost = 4, merged = 3
      (ctx.treeService.findShortestPaths as jest.Mock)
        .mockReturnValueOnce([{ nodes: ['B', 'C'], cost: 2 }])
        .mockReturnValueOnce([{ nodes: ['B', 'D'], cost: 2 }]);

      const result = await handlePlanTreePaths(ctx, 'build.xml', ['C', 'D']);
      const text = result.content[0].text;

      expect(text).toContain('Sum of individual paths: 4');
      expect(text).toContain('After merging shared prefixes: 3');
      expect(text).toContain('Points saved by merging: 1');
    });

    it('lists shared node IDs in the shared summary', async () => {
      const ctx = makeContext();
      (ctx.treeService.findShortestPaths as jest.Mock)
        .mockReturnValueOnce([{ nodes: ['B', 'C'], cost: 2 }])
        .mockReturnValueOnce([{ nodes: ['B', 'D'], cost: 2 }]);

      const result = await handlePlanTreePaths(ctx, 'build.xml', ['C', 'D']);
      expect(result.content[0].text).toContain('Shared path nodes');
      expect(result.content[0].text).toContain('B');
    });

    it('combined node list contains all unique path nodes', async () => {
      const ctx = makeContext();
      (ctx.treeService.findShortestPaths as jest.Mock)
        .mockReturnValueOnce([{ nodes: ['B', 'C'], cost: 2 }])
        .mockReturnValueOnce([{ nodes: ['B', 'D'], cost: 2 }]);

      const result = await handlePlanTreePaths(ctx, 'build.xml', ['C', 'D']);
      const text = result.content[0].text;
      // The combined node list is the last line: a JSON array like ["B","C","D"]
      const lines = text.split('\n').filter(l => l.trim().startsWith('['));
      const jsonLine = lines[lines.length - 1].trim();
      const nodeList: string[] = JSON.parse(jsonLine);
      expect(nodeList.sort()).toEqual(['B', 'C', 'D']);
    });

    it('omits savings line when no sharing occurs', async () => {
      const ctx = makeContext();
      // Two completely disjoint paths
      (ctx.treeService.findShortestPaths as jest.Mock)
        .mockReturnValueOnce([{ nodes: ['B', 'C'], cost: 2 }])
        .mockReturnValueOnce([{ nodes: ['D'], cost: 1 }]);

      const result = await handlePlanTreePaths(ctx, 'build.xml', ['C', 'D']);
      expect(result.content[0].text).not.toContain('Points saved by merging');
    });
  });

  describe('data source fallback', () => {
    it('falls back to Lua client when no build_name and no file allocation', async () => {
      const mockLuaClient = {
        getTree: jest.fn<() => Promise<any>>().mockResolvedValue({
          nodes: ['A'],
          treeVersion: '3_26',
        }),
      };
      const ctx = makeContext({
        getLuaClient: jest.fn<() => any>().mockReturnValue(mockLuaClient),
      });
      // No build name — buildService not consulted for allocation
      (ctx.treeService.findShortestPaths as jest.Mock).mockReturnValue([
        { nodes: ['B', 'C'], cost: 2 },
      ]);

      const result = await handlePlanTreePaths(ctx, undefined, ['C']);
      expect(mockLuaClient.getTree).toHaveBeenCalled();
      expect(result.content[0].text).toContain('Notable C');
    });

    it('uses build file allocation when build_name is supplied', async () => {
      const ctx = makeContext();
      (ctx.treeService.findShortestPaths as jest.Mock).mockReturnValue([
        { nodes: ['B', 'C'], cost: 2 },
      ]);

      await handlePlanTreePaths(ctx, 'my-build.xml', ['C']);
      expect(ctx.buildService.readBuild).toHaveBeenCalledWith('my-build.xml');
    });
  });

  describe('error handling', () => {
    it('returns error message when buildService throws', async () => {
      const ctx = makeContext();
      (ctx.buildService.readBuild as jest.Mock<() => Promise<any>>).mockRejectedValue(new Error('File not found'));

      const result = await handlePlanTreePaths(ctx, 'missing.xml', ['C']);
      expect(result.content[0].text).toContain('Error:');
      expect(result.content[0].text).toContain('File not found');
    });
  });
});
