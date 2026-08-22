import { describe, expect, it } from "vitest";
import { asFactionId, asRegionId } from "../models/ids.js";
import type { GameState } from "../models/gameState.js";
import type { Region } from "../models/region.js";
import { rollOffMapThreats } from "./offMapThreats.js";
import type { OffMapThreatDefinition } from "../data/offMapThreats.js";

function makeRegion(over: Partial<Region> & Pick<Region, "id" | "owner" | "frontier">): Region {
  return {
    name: "辺境州",
    terrain: "plain",
    terrainModifier: { attack: 1.0, defense: 1.0 },
    population: 100_000,
    taxBase: 500,
    archetype: "steppe_frontier",
    garrison: { count: 1000, training: 0.5 },
    adjacency: [],
    fortified: false,
    siege: null,
    ...over,
  };
}

function makeState(regions: readonly Region[], year: number): GameState {
  return {
    turn: 1,
    year,
    phase: "year_start",
    regions: Object.fromEntries(regions.map((r) => [r.id, r])),
    factions: {},
    armies: {},
    characters: {},
    captivities: {},
    greatWarTriggered: false,
    playerFactionId: null,
    spectator: null,
  };
}

const owner = asFactionId("faction_owner");
const threat: OffMapThreatDefinition = {
  id: "test_threat",
  name: "テスト脅威",
  description: "テスト用",
  startYear: 1000,
  endYear: 1010,
  annualProbability: 1.0, // テストでは確実に発生させる
  severity: 2.0,
};

describe("rollOffMapThreats", () => {
  it("辺境州（frontier: true）にのみ被害を与える", () => {
    const frontierRegion = makeRegion({ id: asRegionId("r_frontier"), owner, frontier: true });
    const heartlandRegion = makeRegion({ id: asRegionId("r_heartland"), owner, frontier: false });
    const state = makeState([frontierRegion, heartlandRegion], 1005);

    const result = rollOffMapThreats(state, () => 0, [threat]); // random()=0 < annualProbability=1.0 で必ず成立

    expect(result.triggered).toHaveLength(1);
    expect(result.triggered[0]?.affectedRegions).toEqual([frontierRegion.id]);
    expect(result.state.regions[frontierRegion.id]?.population).toBeLessThan(frontierRegion.population);
    expect(result.state.regions[frontierRegion.id]?.garrison.count).toBeLessThan(frontierRegion.garrison.count);
    // 辺境でない州は無傷。
    expect(result.state.regions[heartlandRegion.id]).toEqual(heartlandRegion);
  });

  it("活動年代の範囲外では発生しない", () => {
    const frontierRegion = makeRegion({ id: asRegionId("r_frontier"), owner, frontier: true });
    const state = makeState([frontierRegion], 1500); // threat の範囲（1000-1010）外

    const result = rollOffMapThreats(state, () => 0, [threat]);

    expect(result.triggered).toHaveLength(0);
    expect(result.state).toBe(state);
  });

  it("乱数が確率を下回らなければ発生しない", () => {
    const frontierRegion = makeRegion({ id: asRegionId("r_frontier"), owner, frontier: true });
    const state = makeState([frontierRegion], 1005);

    const result = rollOffMapThreats(state, () => 0.999999, [{ ...threat, annualProbability: 0.5 }]);

    expect(result.triggered).toHaveLength(0);
  });

  it("辺境州が1つも存在しないシナリオでは、発生しても実害なく安全に無視される", () => {
    const heartlandRegion = makeRegion({ id: asRegionId("r_heartland"), owner, frontier: false });
    const state = makeState([heartlandRegion], 1005);

    const result = rollOffMapThreats(state, () => 0, [threat]);

    expect(result.triggered).toHaveLength(1);
    expect(result.triggered[0]?.affectedRegions).toEqual([]);
    expect(result.state.regions[heartlandRegion.id]).toEqual(heartlandRegion);
  });
});
