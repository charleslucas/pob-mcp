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
    setConfig: jest.fn<(p: Record<string, any>) => Promise<void>>().mockImplementation(async (p) => {
      if (applyWrites) Object.assign(state, p);
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
    expect(client.setConfig).toHaveBeenCalledWith({ bandit: 'Alira' });
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
});
