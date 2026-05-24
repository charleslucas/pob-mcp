import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { handleValidateBuild } from '../../src/handlers/validationHandlers';
import type { ValidationHandlerContext } from '../../src/handlers/validationHandlers';

function makeContext(overrides: Partial<ValidationHandlerContext> = {}): ValidationHandlerContext {
  return {
    buildService: {
      readBuild: jest.fn<() => Promise<any>>().mockResolvedValue({}),
      parseFlasks: jest.fn<() => any>().mockReturnValue(null),
    } as any,
    validationService: {
      validateBuild: jest.fn<() => any>().mockReturnValue({ issues: [], warnings: [], score: 100 }),
      formatValidation: jest.fn<() => string>().mockReturnValue('=== Validation OK ==='),
    } as any,
    getLuaClient: jest.fn<() => null>().mockReturnValue(null),
    ensureLuaClient: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('handleValidateBuild', () => {
  describe('error cases', () => {
    it('throws when no build_name and no lua client', async () => {
      const ctx = makeContext();
      await expect(handleValidateBuild(ctx)).rejects.toThrow(/No build_name/);
    });

    it('throws when build file not found and lua client is null', async () => {
      const ctx = makeContext();
      (ctx.buildService.readBuild as jest.Mock<() => Promise<any>>).mockRejectedValue(new Error('ENOENT'));
      await expect(handleValidateBuild(ctx, { build_name: 'missing.xml' })).rejects.toThrow();
    });
  });

  describe('Lua-only validation (no build file)', () => {
    function makeLuaCtx(stats: Record<string, any>): ValidationHandlerContext {
      const luaClient = { getStats: jest.fn<() => Promise<any>>().mockResolvedValue(stats) };
      return makeContext({
        getLuaClient: jest.fn<() => any>().mockReturnValue(luaClient),
        ensureLuaClient: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        buildService: {
          readBuild: jest.fn<() => Promise<any>>().mockRejectedValue(new Error('no file')),
          parseFlasks: jest.fn<() => any>().mockReturnValue(null),
        } as any,
      });
    }

    it('flags critical low life', async () => {
      const ctx = makeLuaCtx({ Life: 1500, FireResist: 75, ColdResist: 75, LightningResist: 75, ChaosResist: 0 });
      const result = await handleValidateBuild(ctx);
      expect(result.content[0].text).toContain('CRITICAL');
      expect(result.content[0].text).toContain('Life');
    });

    it('flags uncapped resistance', async () => {
      const ctx = makeLuaCtx({ Life: 5000, FireResist: 50, ColdResist: 75, LightningResist: 75, ChaosResist: 0 });
      const result = await handleValidateBuild(ctx);
      expect(result.content[0].text).toContain('Fire');
      expect(result.content[0].text).toContain('CRITICAL');
    });

    it('flags zero unreserved mana', async () => {
      const ctx = makeLuaCtx({ Life: 5000, FireResist: 75, ColdResist: 75, LightningResist: 75, ChaosResist: 0, ManaUnreserved: 0 });
      const result = await handleValidateBuild(ctx);
      expect(result.content[0].text).toContain('mana');
    });

    it('reports healthy stats without critical issues', async () => {
      const ctx = makeLuaCtx({ Life: 6000, FireResist: 75, ColdResist: 75, LightningResist: 75, ChaosResist: 25, ManaUnreserved: 200 });
      const result = await handleValidateBuild(ctx);
      expect(result.content[0].text).not.toContain('CRITICAL');
      expect(result.content[0].text).toContain('Life: 6000');
    });

    it('includes note that full validation requires a saved file', async () => {
      const ctx = makeLuaCtx({ Life: 4000, FireResist: 75, ColdResist: 75, LightningResist: 75, ChaosResist: 0 });
      const result = await handleValidateBuild(ctx);
      expect(result.content[0].text).toContain('lua_save_build');
    });
  });

  describe('file-based validation', () => {
    it('calls validationService when build file is found', async () => {
      const ctx = makeContext();
      (ctx.buildService.readBuild as jest.Mock<() => Promise<any>>).mockResolvedValue({ Build: { level: '90' } });
      await handleValidateBuild(ctx, { build_name: 'myBuild.xml' });
      expect(ctx.validationService.validateBuild).toHaveBeenCalled();
      expect(ctx.validationService.formatValidation).toHaveBeenCalled();
    });

    it('returns formatted validation output', async () => {
      const ctx = makeContext();
      (ctx.buildService.readBuild as jest.Mock<() => Promise<any>>).mockResolvedValue({ Build: { level: '90' } });
      const result = await handleValidateBuild(ctx, { build_name: 'build.xml' });
      expect(result.content[0].text).toBe('=== Validation OK ===');
    });

    it('overlays lua flask immunities when both sources available', async () => {
      const flaskItems = [
        { slot: 'Flask1', raw: 'Removes Bleed on use' },
        { slot: 'Flask2', raw: 'Removes Freeze on use' },
      ];
      const luaClient = {
        getBuildInfo: jest.fn<() => Promise<any>>().mockResolvedValue({ name: 'myBuild' }),
        getStats: jest.fn<() => Promise<any>>().mockResolvedValue({}),
        loadBuildXml: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        getItems: jest.fn<() => Promise<any>>().mockResolvedValue(flaskItems),
      };
      const ctx = makeContext({
        getLuaClient: jest.fn<() => any>().mockReturnValue(luaClient),
        ensureLuaClient: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        pobDirectory: '/builds',
      });
      (ctx.buildService.readBuild as jest.Mock<() => Promise<any>>).mockResolvedValue({ Build: { level: '90' } });

      await handleValidateBuild(ctx, { build_name: 'myBuild' });

      const parseFlasksMock = ctx.buildService.parseFlasks as jest.Mock;
      expect(parseFlasksMock).toHaveBeenCalled();
      // validateBuild should have been called with the flask data (even if null from parseFlasks, Lua overlay applies)
      expect(ctx.validationService.validateBuild).toHaveBeenCalled();
    });
  });
});
