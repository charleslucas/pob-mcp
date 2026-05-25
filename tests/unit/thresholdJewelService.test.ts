import { describe, it, expect } from "@jest/globals";
import {
  parseThresholdMods,
  evaluateThreshold,
  evaluateBuildThresholds,
  type ThresholdMod,
} from "../../src/services/thresholdJewelService";

describe("parseThresholdMods", () => {
  it("parses 'With at least N Strength in Radius' patterns", () => {
    const mods = [
      "With at least 40 Strength in Radius, 1% increased Strength per 20 Strength",
      "+10 to maximum Life",
    ];
    const r = parseThresholdMods(mods);
    expect(r).toHaveLength(1);
    expect(r[0].attribute).toBe("Strength");
    expect(r[0].requiredAmount).toBe(40);
  });

  it("parses Dexterity and Intelligence thresholds", () => {
    const r = parseThresholdMods([
      "With at least 40 Dexterity in Radius, 1% chance to Dodge",
      "With at least 40 Intelligence in Radius, 20% increased Effect of Auras",
    ]);
    expect(r).toHaveLength(2);
    expect(r.map((t) => t.attribute).sort()).toEqual(["Dexterity", "Intelligence"]);
  });

  it("handles the shorter 'With N <Attr> in Radius' wording", () => {
    const r = parseThresholdMods([
      "With 40 Intelligence in Radius, 20% increased Effect of Auras",
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].requiredAmount).toBe(40);
  });

  it("strips {crafted} / [fractured] mod-source annotations", () => {
    const r = parseThresholdMods([
      "{crafted}With at least 40 Strength in Radius, X% increased Y [crafted]",
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].rawMod).not.toContain("{crafted}");
    expect(r[0].rawMod).not.toContain("[crafted]");
  });

  it("returns empty for jewels with no threshold mods", () => {
    expect(
      parseThresholdMods([
        "+105 to maximum Life",
        "+30% to Fire Resistance",
        "5% increased Movement Speed",
      ])
    ).toEqual([]);
  });
});

describe("evaluateThreshold (uses real PoB tree data)", () => {
  // Build a small allocated-nodes set with deliberate Strength concentration.
  // The PoB tree has thousands of nodes; we only assert on whether
  // sumAttributeInRadius is called correctly through evaluateThreshold.
  const threshold: ThresholdMod = {
    attribute: "Strength",
    requiredAmount: 40,
    rawMod: "With at least 40 Strength in Radius, X",
  };

  it("returns triggered=false when allocated set has nothing in radius", () => {
    // 7162 is a known node ID in the tree; with an empty allocated set the
    // sum in radius must be 0 → threshold not triggered.
    const r = evaluateThreshold(threshold, "7162", new Set<string>());
    expect(r.triggered).toBe(false);
    expect(r.attributeInRadius).toBe(0);
    expect(r.margin).toBe(-40);
  });

  it("uses the override radius when provided", () => {
    const r = evaluateThreshold(threshold, "7162", new Set<string>(), 100);
    expect(r.radius).toBe(100);
  });
});

describe("evaluateBuildThresholds (integration)", () => {
  it("skips jewels with no threshold mods and reports the rest", () => {
    const result = evaluateBuildThresholds(
      [
        {
          socketNodeId: "26196",
          jewelName: "Lethal Pride",
          mods: [
            "Commanded leadership over 10678 warriors under Kaom",
            "Passives in radius are Conquered by the Karui",
            "Historic",
          ],
        },
        {
          socketNodeId: "7162",
          jewelName: "Brawn",
          mods: [
            "With at least 40 Strength in Radius, 1% increased Strength per 20 Strength",
            "Implicit: +5 to all Attributes",
          ],
        },
        {
          socketNodeId: "9408",
          jewelName: "Generic Crimson Jewel",
          mods: [
            "+10% to Critical Strike Multiplier with Two Handed Melee Weapons",
            "Gain 3 Life per Enemy Hit with Attacks",
          ],
        },
      ],
      new Set<string>()
    );
    expect(result.jewelsScanned).toBe(3);
    expect(result.jewelsWithThresholds).toBe(1);
    expect(result.evaluations).toHaveLength(1);
    expect(result.evaluations[0].jewelName).toBe("Brawn");
    // Empty allocated set → not triggered.
    expect(result.evaluations[0].notTriggered).toHaveLength(1);
    expect(result.evaluations[0].triggered).toHaveLength(0);
  });
});
