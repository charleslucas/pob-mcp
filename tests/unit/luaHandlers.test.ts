import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import {
  handleLuaStart,
  handleLuaStop,
  handleLuaGetBuildInfo,
  handleLuaNewBuild,
  handleUpdateTreeDelta,
  handleSearchTreeNodes,
  handleCopyLoadout,
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
    updateTreeDelta: jest.fn<() => Promise<any>>().mockResolvedValue({ tree: { nodes: ['1', '2', '3'], ascendancyPointsUsed: 0 }, added: ['100', '200'], removed: [], autoPathedNodes: [], droppedNodes: [], skippedAscendancyNodes: [] }),
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
    expect(text).toContain('Added: 2 of 2 requested');
    expect(text).toContain('Total allocated: 3');
  });

  it('reports removed nodes', async () => {
    const client = makeLuaClient({
      updateTreeDelta: jest.fn<() => Promise<any>>().mockResolvedValue({
        tree: { nodes: ['1'], ascendancyPointsUsed: 0 },
        added: [], removed: ['50'],
        autoPathedNodes: [], droppedNodes: [], skippedAscendancyNodes: [],
      }),
    });
    const ctx = makeContext(client);
    const result = await handleUpdateTreeDelta(ctx, undefined, ['50']);
    expect(result.content[0].text).toContain('Removed: 1 of 1 requested');
  });

  it('reports auto-pathed nodes when present', async () => {
    const client = makeLuaClient({
      updateTreeDelta: jest.fn<() => Promise<any>>().mockResolvedValue({
        tree: { nodes: ['1', '2', '3', '4'], ascendancyPointsUsed: 0 },
        added: ['100'], removed: [],
        autoPathedNodes: ['X', 'Y'], droppedNodes: [], skippedAscendancyNodes: [],
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
        added: ['999'], removed: [],
        autoPathedNodes: [], droppedNodes: [], skippedAscendancyNodes: [],
      }),
    });
    const ctx = makeContext(client);
    const result = await handleUpdateTreeDelta(ctx, ['999'], undefined);
    expect(result.content[0].text).toContain('ascendancy');
  });

  // Regression: asking for one unreachable notable used to print "✅ ... Added: 1 node(s)"
  // while allocating nothing, because the handler echoed the REQUESTED count.
  it('flags a silent no-op instead of reporting success', async () => {
    const client = makeLuaClient({
      updateTreeDelta: jest.fn<() => Promise<any>>().mockResolvedValue({
        tree: { nodes: ['1', '2', '3'], ascendancyPointsUsed: 0 },
        added: [], removed: [],
        autoPathedNodes: [], droppedNodes: ['19897'], skippedAscendancyNodes: [],
      }),
    });
    const ctx = makeContext(client);
    const result = await handleUpdateTreeDelta(ctx, ['19897'], undefined);
    const text = result.content[0].text;
    expect(text).toContain('NO changes');
    expect(text).toContain('UNCHANGED');
    expect(text).not.toContain('✅');
    // The dropped node must be named so the caller can path to it.
    expect(text).toContain('19897');
    expect(text).toContain('find_path_to_node');
  });

  it('never reports the requested count as applied on a partial success', async () => {
    const client = makeLuaClient({
      updateTreeDelta: jest.fn<() => Promise<any>>().mockResolvedValue({
        tree: { nodes: ['1', '2'], ascendancyPointsUsed: 0 },
        added: ['100'], removed: [],
        autoPathedNodes: [], droppedNodes: ['200', '300'], skippedAscendancyNodes: [],
      }),
    });
    const ctx = makeContext(client);
    const result = await handleUpdateTreeDelta(ctx, ['100', '200', '300'], undefined);
    const text = result.content[0].text;
    expect(text).toContain('Added: 1 of 3 requested');
    expect(text).toContain('DROPPED 2');
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

// -- handleCopyLoadout ---------------------------------------------------------

function loadoutRow(name: string, id: number, active = false, extra: Record<string, any> = {}) {
  return {
    name,
    title: name,
    complete: true,
    active,
    treeSpec: { id, title: name },
    itemSet: { id, title: name },
    skillSet: { id, title: name },
    configSet: { id, title: name },
    ...extra,
  };
}

function makeLoadoutClient(loadouts: any[], familyTitles: string[] = []) {
  const titles = [...new Set([...loadouts.map((l) => l.name), ...familyTitles])];
  return {
    listLoadouts: jest.fn<() => Promise<any>>().mockResolvedValue({ loadouts }),
    listSpecs: jest.fn<() => Promise<any>>().mockResolvedValue({
      specs: titles.map((title, i) => ({ index: i + 1, title })),
    }),
    listItemSets: jest.fn<() => Promise<any>>().mockResolvedValue({
      itemSets: titles.map((title, i) => ({ id: i + 1, title })),
    }),
    listSkillSets: jest.fn<() => Promise<any>>().mockResolvedValue({
      skillSets: titles.map((title, i) => ({ id: i + 1, title })),
    }),
    listConfigSets: jest.fn<() => Promise<any>>().mockResolvedValue({
      configSets: titles.map((title, i) => ({ id: i + 1, title })),
    }),
    createLoadout: jest.fn<(params: any) => Promise<any>>().mockImplementation(async (params: any) => ({
      created: { spec: true, items: true, skills: true, config: true },
      selected: {
        name: params.title,
        complete: true,
        treeSpec: { id: 9, title: params.title },
        itemSet: { id: 9, title: params.title },
        skillSet: { id: 9, title: params.title },
        configSet: { id: 9, title: params.title },
      },
      loadouts: [],
    })),
  };
}

describe('handleCopyLoadout', () => {
  it('copies the named loadout even when a different one is active', async () => {
    const client = makeLoadoutClient([
      loadoutRow('ME', 1, true),
      loadoutRow('BUDGET', 2),
    ]);
    const ctx = makeContext(client);

    const result = await handleCopyLoadout(ctx, { from: 'budget', to: 'BUDGET 2' });

    expect(client.createLoadout).toHaveBeenCalledWith({
      title: 'BUDGET 2',
      copyFrom: { spec: 2, items: 2, skills: 2, config: 2 },
      activate: true,
    });
    expect(result.content[0].text).toContain('Copied loadout "BUDGET" → "BUDGET 2"');
    expect(result.content[0].text).toContain('Source loadout "BUDGET" is unchanged');
  });

  it('auto-names the copy and skips names already taken', async () => {
    const client = makeLoadoutClient(
      [loadoutRow('ME', 1, true)],
      ['ME (copy)'],
    );
    const ctx = makeContext(client);

    const result = await handleCopyLoadout(ctx, { from: 'ME' });

    expect(client.createLoadout).toHaveBeenCalledWith({
      title: 'ME (copy) 2',
      copyFrom: { spec: 1, items: 1, skills: 1, config: 1 },
      activate: true,
    });
    expect(result.content[0].text).toContain('"ME (copy) 2"');
  });

  it('accepts a numeric string as a 1-based index when no loadout is named like that', async () => {
    const client = makeLoadoutClient([
      loadoutRow('ME', 1, true),
      loadoutRow('BUDGET', 2),
    ]);
    const ctx = makeContext(client);

    await handleCopyLoadout(ctx, { from: '2' });

    expect(client.createLoadout).toHaveBeenCalledWith({
      title: 'BUDGET (copy)',
      copyFrom: { spec: 2, items: 2, skills: 2, config: 2 },
      activate: true,
    });
  });

  it('defaults the source to the active loadout', async () => {
    const client = makeLoadoutClient([
      loadoutRow('ME', 1, true),
      loadoutRow('BUDGET', 2),
    ]);
    const ctx = makeContext(client);

    await handleCopyLoadout(ctx, {});

    expect(client.createLoadout).toHaveBeenCalledWith({
      title: 'ME (copy)',
      copyFrom: { spec: 1, items: 1, skills: 1, config: 1 },
      activate: true,
    });
  });

  it('refuses a destination title that is already in use', async () => {
    const client = makeLoadoutClient([
      loadoutRow('ME', 1, true),
      loadoutRow('BUDGET', 2),
    ]);
    const ctx = makeContext(client);

    await expect(handleCopyLoadout(ctx, { from: 'ME', to: 'BUDGET' }))
      .rejects.toThrow(/already uses that title/i);
    expect(client.createLoadout).not.toHaveBeenCalled();
  });

  it('refuses to copy an incomplete loadout unless told otherwise', async () => {
    const broken = loadoutRow('BROKEN', 3, false, { skillSet: null, complete: false });
    const client = makeLoadoutClient([loadoutRow('ME', 1, true), broken]);
    const ctx = makeContext(client);

    await expect(handleCopyLoadout(ctx, { from: 'BROKEN', to: 'BROKEN 2' }))
      .rejects.toThrow(/incomplete/i);
    expect(client.createLoadout).not.toHaveBeenCalled();

    await handleCopyLoadout(ctx, { from: 'BROKEN', to: 'BROKEN 2', allowIncomplete: true });
    expect(client.createLoadout).toHaveBeenCalledWith({
      title: 'BROKEN 2',
      copyFrom: { spec: 3, items: 3, skills: undefined, config: 3 },
      activate: true,
    });
  });

  it('can copy without switching to the copy', async () => {
    const client = makeLoadoutClient([loadoutRow('ME', 1, true)]);
    const ctx = makeContext(client);

    const result = await handleCopyLoadout(ctx, { from: 'ME', to: 'ME ALT', activate: false });

    expect(client.createLoadout).toHaveBeenCalledWith({
      title: 'ME ALT',
      copyFrom: { spec: 1, items: 1, skills: 1, config: 1 },
      activate: false,
    });
    expect(result.content[0].text).toContain('not activated');
  });

  it('reports an ambiguous partial name instead of guessing', async () => {
    const client = makeLoadoutClient([
      loadoutRow('BUDGET A', 1, true),
      loadoutRow('BUDGET B', 2),
    ]);
    const ctx = makeContext(client);

    await expect(handleCopyLoadout(ctx, { from: 'BUDGET' })).rejects.toThrow(/ambiguous/i);
  });
});
