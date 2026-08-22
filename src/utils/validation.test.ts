import { describe, expect, it } from "vitest";
import { createInitialGameState } from "../data/initialState.js";
import { validateGameState } from "./validation.js";
import { asFactionId, asRegionId } from "../models/ids.js";

describe("validateGameState", () => {
  it("初期データセットは整合している", () => {
    const state = createInitialGameState();
    const result = validateGameState(state);
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("隣接関係が非対称だと検出する", () => {
    const state = createInitialGameState();
    const saxony = state.regions[asRegionId("region_saxony")]!;
    const bavaria = state.regions[asRegionId("region_bavaria")]!;
    const brokenBavaria = { ...bavaria, adjacency: bavaria.adjacency.filter((id) => id !== saxony.id) };
    const broken = {
      ...state,
      regions: { ...state.regions, [bavaria.id]: brokenBavaria },
    };
    const result = validateGameState(broken);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.message.includes("非対称"))).toBe(true);
  });

  it("owner が未知の勢力を指すと検出する", () => {
    const state = createInitialGameState();
    const saxony = state.regions[asRegionId("region_saxony")]!;
    const broken = {
      ...state,
      regions: {
        ...state.regions,
        [saxony.id]: { ...saxony, owner: asFactionId("faction_unknown") },
      },
    };
    const result = validateGameState(broken);
    expect(result.valid).toBe(false);
  });
});
