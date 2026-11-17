import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import {
  handleGetConfig,
  handleSetConfig,
} from '../../src/handlers/configHandlers';
import type { ConfigHandlerContext } from '../../src/handlers/configHandlers';

// `applyWrites: false` simulates PoB accepting a write but not storing it — the silent
// failure mode that made unsupported config options look like they applied.
function makeLuaClient(
  config: Record<string, any> = {},
  stats: Record<string, any> = {},
  applyWrites = true,
) {
  const state = { ...config };
  return {
    getConfig: jest.fn<() => Promise<any>>().mockImplementation(async () => ({ ...state })),
    getConfigLabels: jest.fn<() => Promise<Record<string, string>>>().mockImplementation(async () =>
      (state.bandit === 'None' ? { bandit: 'Kill all' } : {}) as Record<string, string>,
    ),
    setConfig: jest.fn<(p: Record<string, any>) => Promise<void>>().mockImplementation(async (p) => {
      if (applyWrites) Object.assign(state, p);
    }),
    setConfigDetail: jest.fn<(p: Record<string, any>) => Promise<any>>().mockImplementation(async (p) => {
      const unparsed = typeof p.customMods === 'string'
        ? p.customMods.split('\n').filter((l: string) => l.includes('frobnication'))
        : [];
      if (applyWrites) {
        for (const [k, v] of Object.entries(p)) {
          if (k === 'customMods') continue; // lives in a Custom Modifiers group, not the inputs
          if (v === '__unset__') delete state[k]; else state[k] = v;
        }
      }
      return {
        config: { ...state },
        applied: applyWrites ? { ...p } : {},
        rejected: unparsed.length ? { customModsUnparsed: unparsed } : undefined,
      };
    }),
    getStats: jest.fn<() => Promise<any>>().mockResolvedValue(stats),
  };
}

function makeContext(luaClient: any = null): ConfigHandlerContext {
  return {
    getLuaClient: jest.fn<() => any>().mockReturnValue(luaClient),
    ensureLuaClient: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

// ── handleGetConfig ───────────────────────────────────────────────────────────

describe('handleGetConfig', () => {
  it('throws when lua client not active', async () => {
    const ctx = makeContext(null);
    await expect(handleGetConfig(ctx)).rejects.toThrow(/not active/i);
  });

  it('calls getConfig on the lua client', async () => {
    const client = makeLuaClient({ usePowerCharges: true, bandit: 'Alira' });
    const ctx = makeContext(client);
    await handleGetConfig(ctx);
    expect(client.getConfig).toHaveBeenCalled();
  });

  it('returns formatted config output', async () => {
    const client = makeLuaClient({ bandit: 'Alira', usePowerCharges: true });
    const ctx = makeContext(client);
    const result = await handleGetConfig(ctx);
    expect(result.content[0].text).toBeTruthy();
    expect(typeof result.content[0].text).toBe('string');
  });

  it('shows the GUI label for dropdown values (bandit None reads Kill all)', async () => {
    const client = makeLuaClient({ bandit: 'None' });
    const result = await handleGetConfig(makeContext(client));
    expect(result.content[0].text).toContain('Bandit: Kill all (None)');
  });

  it('still renders when labels are unavailable', async () => {
    const client = makeLuaClient({ bandit: 'Alira' });
    client.getConfigLabels.mockRejectedValue(new Error('old fork'));
    const result = await handleGetConfig(makeContext(client));
    expect(result.content[0].text).toContain('Bandit: Alira');
  });
});

// ── handleSetConfig ───────────────────────────────────────────────────────────

describe('handleSetConfig', () => {
  it('throws when lua client not active', async () => {
    const ctx = makeContext(null);
    await expect(handleSetConfig(ctx, { config_name: 'bandit', value: 'Oak' })).rejects.toThrow(/not active/i);
  });

  it('calls setConfig with the provided name/value', async () => {
    const client = makeLuaClient({ bandit: 'None' }, { TotalDPS: 50000 });
    const ctx = makeContext(client);
    await handleSetConfig(ctx, { config_name: 'bandit', value: 'Alira' });
    expect(client.setConfigDetail).toHaveBeenCalledWith({ bandit: 'Alira' });
  });

  it('shows old, requested and stored values in output', async () => {
    const client = makeLuaClient({ usePowerCharges: false }, {});
    const ctx = makeContext(client);
    const result = await handleSetConfig(ctx, { config_name: 'usePowerCharges', value: true });
    const text = result.content[0].text;
    expect(text).toContain('usePowerCharges');
    expect(text).toContain('Old Value');
    expect(text).toContain('Requested');
    expect(text).toContain('Stored');
    expect(text).toContain('Configuration Updated');
  });

  it('verifies the write and WARNS when PoB did not store the value', async () => {
    // Regression guard: the handler used to echo the requested value as if it applied,
    // so silently-ignored options produced sims based on stale config.
    const client = makeLuaClient({ minionbuffUnholyMight: false }, {}, /* applyWrites */ false);
    const ctx = makeContext(client);
    const result = await handleSetConfig(ctx, { config_name: 'minionbuffUnholyMight', value: true });
    const text = result.content[0].text;
    expect(text).toContain('NOT applied');
    expect(text).toMatch(/do NOT trust/i);
  });

  it('includes post-change DPS when stats contain TotalDPS', async () => {
    const client = makeLuaClient({ usePowerCharges: false }, { TotalDPS: 120000, Life: 5000 });
    const ctx = makeContext(client);
    const result = await handleSetConfig(ctx, { config_name: 'usePowerCharges', value: true });
    expect(result.content[0].text).toContain('DPS');
  });

  it('omits stats section when TotalDPS is absent', async () => {
    const client = makeLuaClient({ bandit: 'None' }, { Life: 5000 });
    const ctx = makeContext(client);
    const result = await handleSetConfig(ctx, { config_name: 'bandit', value: 'Oak' });
    expect(result.content[0].text).not.toContain('Total DPS');
  });

  it('treats customMods as applied (it lives in a Custom Modifiers group) and warns on unparsed lines', async () => {
    const client = makeLuaClient({});
    const ctx = makeContext(client);
    const result = await handleSetConfig(ctx, { config_name: 'customMods', value: '+500 to maximum Life\nGrants frobnication' });
    const text = result.content[0].text;
    expect(text).toContain('Configuration Updated');
    expect(text).toContain('"pob-mcp" Custom Modifiers group');
    expect(text).toMatch(/could not parse.*Grants frobnication/);
  });

  it("reports '__unset__' as applied when the option is cleared to PoB's default", async () => {
    const client = makeLuaClient({ usePowerCharges: true });
    const ctx = makeContext(client);
    const result = await handleSetConfig(ctx, { config_name: 'usePowerCharges', value: '__unset__' });
    const text = result.content[0].text;
    expect(text).toContain('Configuration Updated');
    expect(text).toContain('(PoB default)');
  });
});
