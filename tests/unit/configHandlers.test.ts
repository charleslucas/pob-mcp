import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import {
  handleGetConfig,
  handleSetConfig,
} from '../../src/handlers/configHandlers';
import type { ConfigHandlerContext } from '../../src/handlers/configHandlers';

function makeLuaClient(config: Record<string, any> = {}, stats: Record<string, any> = {}) {
  return {
    getConfig: jest.fn<() => Promise<any>>().mockResolvedValue(config),
    setConfig: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
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

  it('shows old and new values in output', async () => {
    const client = makeLuaClient({ usePowerCharges: false }, {});
    const ctx = makeContext(client);
    const result = await handleSetConfig(ctx, { config_name: 'usePowerCharges', value: true });
    const text = result.content[0].text;
    expect(text).toContain('usePowerCharges');
    expect(text).toContain('Old Value');
    expect(text).toContain('New Value');
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
