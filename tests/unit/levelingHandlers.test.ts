import { describe, it, expect, jest } from '@jest/globals';
import { handlePlanLeveling } from '../../src/handlers/levelingHandlers';
import type { LevelingContext } from '../../src/handlers/levelingHandlers';

function makeContext(luaClient: any = null): LevelingContext {
  return {
    getLuaClient: jest.fn<() => any>().mockReturnValue(luaClient),
    ensureLuaClient: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

describe('handlePlanLeveling', () => {
  describe('class and ascendancy', () => {
    it('uses class from args when provided', async () => {
      const ctx = makeContext();
      const result = await handlePlanLeveling(ctx, { class_name: 'Ranger', ascendancy: 'Deadeye' });
      expect(result.content[0].text).toContain('Ranger');
      expect(result.content[0].text).toContain('Deadeye');
    });

    it('defaults to Witch when no class provided and no lua client', async () => {
      const ctx = makeContext();
      const result = await handlePlanLeveling(ctx, {});
      expect(result.content[0].text).toContain('Witch');
    });

    it('reads class from lua bridge when available', async () => {
      const luaClient = {
        getBuildInfo: jest.fn<() => Promise<any>>().mockResolvedValue({ class: 'Templar', ascendancy: 'Inquisitor' }),
        getSkills: jest.fn<() => Promise<any>>().mockResolvedValue({ groups: [], mainSocketGroup: 0 }),
      };
      const ctx = makeContext(luaClient);
      const result = await handlePlanLeveling(ctx, {});
      expect(result.content[0].text).toContain('Templar');
      expect(result.content[0].text).toContain('Inquisitor');
    });

    it('arg class overrides lua bridge class', async () => {
      const luaClient = {
        getBuildInfo: jest.fn<() => Promise<any>>().mockResolvedValue({ class: 'Witch', ascendancy: 'Occultist' }),
        getSkills: jest.fn<() => Promise<any>>().mockResolvedValue({ groups: [], mainSocketGroup: 0 }),
      };
      const ctx = makeContext(luaClient);
      const result = await handlePlanLeveling(ctx, { class_name: 'Shadow' });
      expect(result.content[0].text).toContain('Shadow');
    });
  });

  describe('main skill', () => {
    it('uses main_skill from args', async () => {
      const ctx = makeContext();
      const result = await handlePlanLeveling(ctx, { main_skill: 'Ball Lightning' });
      expect(result.content[0].text).toContain('Ball Lightning');
    });

    it('reads main skill from lua bridge gem group', async () => {
      const luaClient = {
        getBuildInfo: jest.fn<() => Promise<any>>().mockResolvedValue({ class: 'Witch', ascendancy: 'Necromancer' }),
        getSkills: jest.fn<() => Promise<any>>().mockResolvedValue({
          groups: [{ index: 0, gems: [{ name: 'Raise Zombie' }] }],
          mainSocketGroup: 0,
        }),
      };
      const ctx = makeContext(luaClient);
      const result = await handlePlanLeveling(ctx, {});
      expect(result.content[0].text).toContain('Raise Zombie');
    });
  });

  describe('output structure', () => {
    it('includes all 10 act milestones', async () => {
      const ctx = makeContext();
      const result = await handlePlanLeveling(ctx, {});
      const text = result.content[0].text;
      for (let i = 1; i <= 10; i++) {
        expect(text).toContain(`Act ${i}`);
      }
    });

    it('includes gem link progression table', async () => {
      const ctx = makeContext();
      const result = await handlePlanLeveling(ctx, {});
      expect(result.content[0].text).toContain('Gem Link Progression');
      expect(result.content[0].text).toContain('6L');
    });

    it('includes lab unlock hints at appropriate acts', async () => {
      const ctx = makeContext();
      const result = await handlePlanLeveling(ctx, {});
      expect(result.content[0].text).toContain('Labyrinth');
    });

    it('uses class starter skills for starter section', async () => {
      const ctx = makeContext();
      const marauder = await handlePlanLeveling(ctx, { class_name: 'Marauder' });
      expect(marauder.content[0].text).toContain('Infernal Blow');

      const ranger = await handlePlanLeveling(ctx, { class_name: 'Ranger' });
      expect(ranger.content[0].text).toContain('Splitting Steel');
    });

    it('includes passive tree priority section', async () => {
      const ctx = makeContext();
      const result = await handlePlanLeveling(ctx, {});
      expect(result.content[0].text).toContain('Passive Tree Priority');
    });
  });

  describe('resilience', () => {
    it('handles lua bridge error gracefully and falls back to args', async () => {
      const luaClient = {
        getBuildInfo: jest.fn<() => Promise<any>>().mockRejectedValue(new Error('bridge down')),
        getSkills: jest.fn<() => Promise<any>>().mockRejectedValue(new Error('bridge down')),
      };
      const ctx = makeContext(luaClient);
      const result = await handlePlanLeveling(ctx, { class_name: 'Duelist', main_skill: 'Cyclone' });
      expect(result.content[0].text).toContain('Duelist');
      expect(result.content[0].text).toContain('Cyclone');
    });
  });
});
