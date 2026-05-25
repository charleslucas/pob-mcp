import { describe, it, expect } from "@jest/globals";
import {
  detectClusterSize,
  parseClusterJewelLines,
  clusterInfoFromItem,
} from "../../src/services/clusterJewelService";

describe("detectClusterSize", () => {
  it("recognizes Large/Medium/Small cluster jewels", () => {
    expect(detectClusterSize("Large Cluster Jewel")).toBe("Large");
    expect(detectClusterSize("Medium Cluster Jewel")).toBe("Medium");
    expect(detectClusterSize("Small Cluster Jewel")).toBe("Small");
  });

  it("works on full item names containing the base", () => {
    expect(detectClusterSize("Chimeric Spark, Large Cluster Jewel")).toBe("Large");
  });

  it("returns null for non-cluster jewels", () => {
    expect(detectClusterSize("Crimson Jewel")).toBeNull();
    expect(detectClusterSize("Lethal Pride, Timeless Jewel")).toBeNull();
    expect(detectClusterSize("")).toBeNull();
  });
});

describe("parseClusterJewelLines", () => {
  it("parses a real Chimeric Spark Large Cluster Jewel", () => {
    // Raw item-text lines from PoB get_items output, including {crafted}/{fractured} prefixes.
    const lines = [
      "{crafted}Adds 8 Passive Skills",
      "{crafted}2 Added Passive Skills are Jewel Sockets",
      "{crafted}Added Small Passive Skills grant: 12% increased Damage with Two Handed Weapons",
      "{fractured}Added Small Passive Skills also grant: +3 to All Attributes",
      "1 Added Passive Skill is Feed the Fury",
      "1 Added Passive Skill is Fuel the Fight",
      "1 Added Passive Skill is Martial Prowess",
    ];
    const r = parseClusterJewelLines(lines);
    expect(r.addedPassiveCount).toBe(8);
    expect(r.addedSocketCount).toBe(2);
    expect(r.smallPassiveEnchant).toBe(
      "12% increased Damage with Two Handed Weapons"
    );
    expect(r.smallPassiveExplicitMods).toEqual(["+3 to All Attributes"]);
    expect(r.notables.sort()).toEqual(
      ["Feed the Fury", "Fuel the Fight", "Martial Prowess"].sort()
    );
  });

  it("handles pipe-separated enchant lines (display-style input)", () => {
    const lines = [
      "Adds 8 Passive Skills | 2 Added Passive Skills are Jewel Sockets | Added Small Passive Skills grant: 12% increased Cold Damage",
      "1 Added Passive Skill is Devastator",
    ];
    const r = parseClusterJewelLines(lines);
    expect(r.addedPassiveCount).toBe(8);
    expect(r.addedSocketCount).toBe(2);
    expect(r.smallPassiveEnchant).toBe("12% increased Cold Damage");
    expect(r.notables).toEqual(["Devastator"]);
  });

  it("strips trailing [fractured] / [crafted] annotations", () => {
    const lines = [
      "Added Small Passive Skills also grant: +3 to All Attributes [fractured]",
      "1 Added Passive Skill is Martial Prowess [implicit]",
    ];
    const r = parseClusterJewelLines(lines);
    expect(r.smallPassiveExplicitMods).toEqual(["+3 to All Attributes"]);
    expect(r.notables).toEqual(["Martial Prowess"]);
  });

  it("returns zero counts for non-cluster mod lines", () => {
    const r = parseClusterJewelLines([
      "+105 to maximum Life",
      "+30% to Fire Resistance",
    ]);
    expect(r.addedPassiveCount).toBe(0);
    expect(r.addedSocketCount).toBe(0);
    expect(r.smallPassiveEnchant).toBeNull();
    expect(r.smallPassiveExplicitMods).toEqual([]);
    expect(r.notables).toEqual([]);
  });
});

describe("clusterInfoFromItem", () => {
  it("returns null for non-cluster jewels", () => {
    expect(
      clusterInfoFromItem({
        socketNodeId: "26196",
        itemName: "Lethal Pride",
        baseName: "Timeless Jewel",
        modLines: ["Commanded leadership over 10678 warriors under Kaom"],
      })
    ).toBeNull();
  });

  it("builds a full info object for a real cluster jewel", () => {
    const info = clusterInfoFromItem({
      socketNodeId: "2491",
      itemName: "Chimeric Spark",
      baseName: "Large Cluster Jewel",
      modLines: [
        "{crafted}Adds 8 Passive Skills",
        "{crafted}2 Added Passive Skills are Jewel Sockets",
        "{crafted}Added Small Passive Skills grant: 12% increased Damage with Two Handed Weapons",
        "{fractured}Added Small Passive Skills also grant: +3 to All Attributes",
        "1 Added Passive Skill is Feed the Fury",
      ],
    });
    expect(info).not.toBeNull();
    expect(info!.size).toBe("Large");
    expect(info!.socketNodeId).toBe("2491");
    expect(info!.fullName).toBe("Chimeric Spark, Large Cluster Jewel");
    expect(info!.addedPassiveCount).toBe(8);
    expect(info!.addedSocketCount).toBe(2);
    expect(info!.notables).toEqual(["Feed the Fury"]);
  });

  it("infers size from itemName when baseName is empty", () => {
    const info = clusterInfoFromItem({
      socketNodeId: "100",
      itemName: "Some Small Cluster Jewel",
      baseName: "",
      modLines: ["Adds 4 Passive Skills"],
    });
    expect(info?.size).toBe("Small");
  });
});
