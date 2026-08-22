import { describe, expect, it } from "vitest";
import { createInitialGameState } from "../data/initialState.js";
import { asFactionId } from "../models/ids.js";
import { checkGreatWar } from "./warCheck.js";

describe("checkGreatWar", () => {
  it("初期状態（全勢力が平和）では発生しない", () => {
    const state = createInitialGameState();
    const result = checkGreatWar(state);
    expect(result.triggered).toBe(false);
    expect(result.warRatio).toBe(0);
  });

  it("生存勢力の2/3以上が交戦状態になると発生する", () => {
    const state = createInitialGameState();
    // 5勢力中 4勢力(hre, west_francia, papal, byzantium) を戦争状態にする。
    // free_company は diplomacy が空のままなので atWar にはならない。
    const warring = {
      ...state,
      factions: {
        ...state.factions,
        [asFactionId("faction_hre")]: {
          ...state.factions[asFactionId("faction_hre")]!,
          diplomacy: { [asFactionId("faction_west_francia")]: "war" as const },
        },
        [asFactionId("faction_west_francia")]: {
          ...state.factions[asFactionId("faction_west_francia")]!,
          diplomacy: { [asFactionId("faction_hre")]: "war" as const },
        },
        [asFactionId("faction_papal")]: {
          ...state.factions[asFactionId("faction_papal")]!,
          diplomacy: { [asFactionId("faction_byzantium")]: "war" as const },
        },
        [asFactionId("faction_byzantium")]: {
          ...state.factions[asFactionId("faction_byzantium")]!,
          diplomacy: { [asFactionId("faction_papal")]: "war" as const },
        },
      },
    };
    const result = checkGreatWar(warring);
    expect(result.atWarFactions).toBe(4);
    expect(result.aliveFactions).toBe(5);
    expect(result.warRatio).toBeCloseTo(4 / 5);
    expect(result.triggered).toBe(true);
  });
});
