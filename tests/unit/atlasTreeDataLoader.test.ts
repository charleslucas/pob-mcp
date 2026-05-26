import { describe, it, expect } from "@jest/globals";
import {
  getAtlasTreeData,
  getAtlasNode,
  getAtlasVariantInfo,
} from "../../src/services/atlasTreeDataLoader";

describe("atlasTreeDataLoader", () => {
  it("loads the default atlas variant from reference_data/atlastree/data.json", () => {
    const data = getAtlasTreeData();
    expect(data).toBeTruthy();
    expect(data.tree).toBe("Atlas");
    expect(typeof data.nodes).toBe("object");
    expect(Object.keys(data.nodes).length).toBeGreaterThan(500);
  });

  it("includes the standard tree.lua-style constants block", () => {
    const data = getAtlasTreeData();
    expect(data.constants).toBeTruthy();
    expect(Array.isArray(data.constants?.orbitRadii)).toBe(true);
    expect(Array.isArray(data.constants?.skillsPerOrbit)).toBe(true);
  });

  it("returns null for an unknown atlas node ID", () => {
    expect(getAtlasNode("99999999")).toBeNull();
  });

  it("returns a known atlas notable with expected shape (Fortune's Favour, node 1670)", () => {
    const node = getAtlasNode("1670");
    expect(node).toBeTruthy();
    expect(node?.name).toBe("Fortune's Favour");
    expect(node?.isNotable).toBe(true);
    expect(Array.isArray(node?.stats)).toBe(true);
    // Real atlas notables generally have at least one stat line.
    expect((node?.stats ?? []).length).toBeGreaterThan(0);
  });

  it("caches the tree on second call (mtime-keyed)", () => {
    const a = getAtlasTreeData();
    const b = getAtlasTreeData();
    // Same object reference on second call (cache hit).
    expect(b).toBe(a);
  });

  it("reports variant file existence", () => {
    const info = getAtlasVariantInfo("default");
    expect(info.exists).toBe(true);
    expect(info.path.endsWith("data.json")).toBe(true);
  });
});
