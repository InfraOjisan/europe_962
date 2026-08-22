import { describe, expect, it } from "vitest";
import { createInitialGameState } from "../data/initialState.js";
import type { Faction } from "../models/faction.js";
import { asFactionId } from "../models/ids.js";
import { checkGreatWar } from "./warCheck.js";

function makeFaction(id: string, diplomacy: Faction["diplomacy"]): Faction {
  return {
    id: asFactionId(id),
    name: id,
    type: "lord",
    ruler: null,
    consort: null,
    children: [],
    heir: null,
    chancellors: [],
    warlords: [],
    regions: [],
    treasury: 0,
    diplomacy,
    suzerain: null,
    alive: true,
  };
}

describe("checkGreatWar", () => {
  it("初期状態（全勢力が平和）では発生しない", () => {
    const state = createInitialGameState();
    const result = checkGreatWar(state);
    expect(result.triggered).toBe(false);
    expect(result.warRatio).toBe(0);
  });

  it("生存勢力の2/3以上が交戦状態になると発生する", () => {
    // 5勢力中 4勢力(a, b, c, d) を戦争状態にする。e は diplomacy が空のままなので atWar にはならない。
    const a = makeFaction("faction_a", { [asFactionId("faction_b")]: "war" });
    const b = makeFaction("faction_b", { [asFactionId("faction_a")]: "war" });
    const c = makeFaction("faction_c", { [asFactionId("faction_d")]: "war" });
    const d = makeFaction("faction_d", { [asFactionId("faction_c")]: "war" });
    const e = makeFaction("faction_e", {});
    const state = {
      ...createInitialGameState(),
      factions: Object.fromEntries([a, b, c, d, e].map((f) => [f.id, f])),
    };

    const result = checkGreatWar(state);
    expect(result.atWarFactions).toBe(4);
    expect(result.aliveFactions).toBe(5);
    expect(result.warRatio).toBeCloseTo(4 / 5);
    expect(result.triggered).toBe(true);
  });
});
