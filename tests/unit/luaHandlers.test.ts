import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import {
  handleLuaStart,
  handleLuaStop,
  handleLuaGetBuildInfo,
  handleLuaNewBuild,
  handleUpdateTreeDelta,
  handleSearchTreeNodes,
} from '../../src/handlers/luaHandlers';
import type { LuaHandlerContext } from '../../src/handlers/luaHandlers';

function makeContext(luaClient: any = null, overrides: Partial<LuaHandlerContext> = {}): LuaHandlerContext {
  return {
    pobDirectory: '/builds',
    luaEnabled: true,
    getLuaClient: jest.fn<() => any>().mockReturnValue(luaClient),
    ensureLuaClient: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    stopLuaClient: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeLuaClient(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    getBuildInfo: jest.fn<() => Promise<any>>().mockResolvedValue({ name: 'TestBuild', level: 90, className: 'Witch', ascendClassName: 'Occultist', treeVersion: '3_26' }),
    newBuild: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    updateTreeDelta: jest.fn<() => Promise<any>>().mockResolvedValue({ tree: { nodes: ['1', '2', '3'], ascendancyPointsUsed: 0 }, autoPathedNodes: [], skippedAscendancyNodes: [] }),
    searchNodes: jest.fn<() => Promise<any>>().mockResolvedValue({ nodes: [], count: 0 }),
    ...overrides,
  };
}

// ── handleLuaStart ────────────────────────────────────────────────────────────

describe('handleLuaStart', () => {
  it('calls ensureLuaClient and returns success message', async () => {
    const ctx = makeContext();
    const result = await handleLuaStart(ctx);
    expect(ctx.ensureLuaClient).toHaveBeenCalled();
    expect(result.content[0].text).toContain('started successfully');
  });

  it('includes the update-button warning in the response', async () => {
    const ctx = makeContext();
    const result = await handleLuaStart(ctx);
    expect(result.content[0].text).toContain('Update');
    expect(result.content[0].text).toContain('LaunchPoBWithAPI');
  });
});

// ── handleLuaStop ─────────────────────────────────────────────────────────────

describe('handleLuaStop', () => {
  it('calls stopLuaClient and returns success message', async () => {
    const ctx = makeContext();
    const result = await handleLuaStop(ctx);
    expect(ctx.stopLuaClient).toHaveBeenCalled();
    expect(result.content[0].text).toContain('stopped successfully');
  });
});

// ── handleLuaGetBuildInfo ─────────────────────────────────────────────────────

describe('handleLuaGetBuildInfo', () => {
  it('returns formatted build info', async () => {
    const client = makeLuaClient();
    const ctx = makeContext(client);
    const result = await handleLuaGetBuildInfo(ctx);
    const text = result.content[0].text;
    expect(text).toContain('TestBuild');
    expect(text).toContain('90');
    expect(text).toContain('Witch');
    expect(text).toContain('Occultist');
  });

  it('reports no build when getBuildInfo returns null', async () => {
    const client = makeLuaClient({ getBuildInfo: jest.fn<() => Promise<any>>().mockResolvedValue(null) });
    const ctx = makeContext(client);
    const result = await handleLuaGetBuildInfo(ctx);
    expect(result.content[0].text).toContain('No build');
  });

  it('throws when lua client not initialized', async () => {
    const ctx = makeContext(null);
    await expect(handleLuaGetBuildInfo(ctx)).rejects.toThrow(/not initialized/i);
  });
});

// ── handleLuaNewBuild ─────────────────────────────────────────────────────────

describe('handleLuaNewBuild', () => {
  it('creates build without class args', async () => {
    const client = makeLuaClient();
    const ctx = makeContext(client);
    const result = await handleLuaNewBuild(ctx);
    expect(client.newBuild).toHaveBeenCalledWith(undefined);
    expect(result.content[0].text).toContain('created');
  });

  it('creates build with class and ascendancy', async () => {
    const client = makeLuaClient();
    const ctx = makeContext(client);
    const result = await handleLuaNewBuild(ctx, 'Witch', 'Necromancer');
    expect(client.newBuild).toHaveBeenCalledWith({ className: 'Witch', ascendancy: 'Necromancer' });
    expect(result.content[0].text).toContain('Witch/Necromancer');
  });

  it('throws when lua client not initialized', async () => {
    const ctx = makeContext(null);
    await expect(handleLuaNewBuild(ctx, 'Witch')).rejects.toThrow(/not initialized/i);
  });
});

// ── handleUpdateTreeDelta ─────────────────────────────────────────────────────

describe('handleUpdateTreeDelta', () => {
  it('reports added and total node count', async () => {
    const client = makeLuaClient();
    const ctx = makeContext(client);
    const result = await handleUpdateTreeDelta(ctx, ['100', '200'], undefined);
    const text = result.content[0].text;
    expect(text).toContain('Added: 2');
    expect(text).toContain('Total allocated: 3');
  });

  it('reports removed nodes', async () => {
    const client = makeLuaClient({
      updateTreeDelta: jest.fn<() => Promise<any>>().mockResolvedValue({
        tree: { nodes: ['1'], ascendancyPointsUsed: 0 },
        autoPathedNodes: [],
        skippedAscendancyNodes: [],
      }),
    });
    const ctx = makeContext(client);
    const result = await handleUpdateTreeDelta(ctx, undefined, ['50']);
    expect(result.content[0].text).toContain('Removed: 1');
  });

  it('reports auto-pathed nodes when present', async () => {
    const client = makeLuaClient({
      updateTreeDelta: jest.fn<() => Promise<any>>().mockResolvedValue({
        tree: { nodes: ['1', '2', '3', '4'], ascendancyPointsUsed: 0 },
        autoPathedNodes: ['X', 'Y'],
        skippedAscendancyNodes: [],
      }),
    });
    const ctx = makeContext(client);
    const result = await handleUpdateTreeDelta(ctx, ['100'], undefined);
    expect(result.content[0].text).toContain('Auto-pathed 2');
  });

  it('warns when ascendancy cap exceeded', async () => {
    const client = makeLuaClient({
      updateTreeDelta: jest.fn<() => Promise<any>>().mockResolvedValue({
        tree: { nodes: ['1'], ascendancyPointsUsed: 10 },
        autoPathedNodes: [],
        skippedAscendancyNodes: [],
      }),
    });
    const ctx = makeContext(client);
    const result = await handleUpdateTreeDelta(ctx, ['999'], undefined);
    expect(result.content[0].text).toContain('ascendancy');
  });

  it('throws when neither add_nodes nor remove_nodes provided', async () => {
    const client = makeLuaClient();
    const ctx = makeContext(client);
    await expect(handleUpdateTreeDelta(ctx, undefined, undefined)).rejects.toThrow(/at least one/i);
  });
});

// ── handleSearchTreeNodes ─────────────────────────────────────────────────────

describe('handleSearchTreeNodes', () => {
  it('returns no-results message when nothing matches', async () => {
    const client = makeLuaClient();
    const ctx = makeContext(client);
    const result = await handleSearchTreeNodes(ctx, 'Nonexistent Stat');
    expect(result.content[0].text).toContain('No matching nodes');
  });

  it('throws on empty keyword', async () => {
    const client = makeLuaClient();
    const ctx = makeContext(client);
    await expect(handleSearchTreeNodes(ctx, '  ')).rejects.toThrow(/cannot be empty/i);
  });

  it('caps results at 30 regardless of maxResults arg', async () => {
    const client = makeLuaClient({
      searchNodes: jest.fn<() => Promise<any>>().mockResolvedValue({
        nodes: Array.from({ length: 5 }, (_, i) => ({ id: String(i), name: `Node ${i}`, type: 'notable', allocated: false })),
        count: 5,
      }),
    });
    const ctx = makeContext(client);
    await handleSearchTreeNodes(ctx, 'life', undefined, 100);
    const callArgs = (client.searchNodes as jest.Mock).mock.calls[0][0] as any;
    expect(callArgs.maxResults).toBeLessThanOrEqual(30);
  });

  it('lists found nodes in output', async () => {
    const client = makeLuaClient({
      searchNodes: jest.fn<() => Promise<any>>().mockResolvedValue({
        nodes: [{ id: '123', name: 'Heartseeker', type: 'notable', allocated: false }],
        count: 1,
      }),
    });
    const ctx = makeContext(client);
    const result = await handleSearchTreeNodes(ctx, 'Heartseeker');
    expect(result.content[0].text).toContain('Heartseeker');
  });
});
