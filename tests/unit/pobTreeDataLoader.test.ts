import { describe, it, expect } from '@jest/globals';
import { getPobNode, getPobTreeData, getLoadedVersion } from '../../src/services/pobTreeDataLoader';

// These tests depend on the PathOfBuilding submodule being checked out
// with at least one TreeData/X_Y/tree.lua present. CI environments without
// the submodule will skip via the existence check.
import { existsSync } from 'fs';
import { resolve } from 'path';

const pobDir = process.env.POB_DIRECTORY ?? resolve(process.cwd(), '..', 'PathOfBuilding');
const hasPobSubmodule = existsSync(resolve(pobDir, 'src', 'TreeData'));

const describeIfPob = hasPobSubmodule ? describe : describe.skip;

describeIfPob('pobTreeDataLoader', () => {
  it('finds a current tree version directory', () => {
    const version = getLoadedVersion();
    expect(version).toMatch(/^\d+_\d+$/);
  });

  it('parses tree.lua and returns a tree object with nodes and groups', () => {
    const tree = getPobTreeData();
    expect(tree).toBeDefined();
    expect(tree.nodes).toBeDefined();
    expect(typeof tree.nodes).toBe('object');
    expect(Object.keys(tree.nodes).length).toBeGreaterThan(1000); // PoE has thousands of passives
    expect(tree.groups).toBeDefined();
    expect(typeof tree.groups).toBe('object');
  });

  it('returns null for an unknown node ID', () => {
    const node = getPobNode('99999999');
    expect(node).toBeNull();
  });

  it('returns Endurance correctly for node 11730 (no Lethal Pride leech in base data)', () => {
    const node = getPobNode('11730');
    expect(node).not.toBeNull();
    if (!node) return; // type narrowing
    expect(node.name).toBe('Endurance');
    expect(node.isNotable).toBe(true);
    expect(node.stats).toEqual(['+1 to Maximum Endurance Charges']);
    // Critical: the leech stat we briefly mis-attributed is a Lethal Pride
    // transformation and must NOT be in the base data.
    const hasLeech = node.stats.some((s) => s.toLowerCase().includes('leech'));
    expect(hasLeech).toBe(false);
  });

  it('coerces empty Lua tables to empty arrays for connection fields', () => {
    const node = getPobNode('11730');
    if (!node) return;
    expect(Array.isArray(node.in)).toBe(true);
    expect(Array.isArray(node.out)).toBe(true);
    // Endurance is a pendant — has in-edges but no out-edges in current tree
    expect(node.in.length).toBeGreaterThan(0);
    expect(node.out.length).toBe(0);
  });

  it('caches tree data — second call is fast', () => {
    const t0 = Date.now();
    getPobTreeData();
    const firstMs = Date.now() - t0;
    const t1 = Date.now();
    getPobTreeData();
    const secondMs = Date.now() - t1;
    // First call may be cache hit too (other tests run first), so we just
    // assert both are reasonable times. The cache is keyed by mtime so the
    // file hasn't changed between calls.
    expect(firstMs).toBeLessThan(500);
    expect(secondMs).toBeLessThan(50);
  });
});
