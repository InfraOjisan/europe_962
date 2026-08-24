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

  it("生存勢力の2/3以上が交戦状態になると発生する（多極的な世界を前提とするため、最低勢力数を満たす場合）", () => {
    // 6勢力中 4勢力(a, b, c, d) を戦争状態にする。e・f は diplomacy が空のままなので atWar にはならない。
    const a = makeFaction("faction_a", { [asFactionId("faction_b")]: "war" });
    const b = makeFaction("faction_b", { [asFactionId("faction_a")]: "war" });
    const c = makeFaction("faction_c", { [asFactionId("faction_d")]: "war" });
    const d = makeFaction("faction_d", { [asFactionId("faction_c")]: "war" });
    const e = makeFaction("faction_e", {});
    const f = makeFaction("faction_f", {});
    const state = {
      ...createInitialGameState(),
      factions: Object.fromEntries([a, b, c, d, e, f].map((x) => [x.id, x])),
    };

    const result = checkGreatWar(state);
    expect(result.atWarFactions).toBe(4);
    expect(result.aliveFactions).toBe(6);
    expect(result.warRatio).toBeCloseTo(4 / 6);
    expect(result.triggered).toBe(true);
  });

  it("生存勢力数が最低ライン未満の場合、比率が2/3を超えていても大戦は発生しない（世界が少数の大国へ淘汰された終盤の誤作動防止）", () => {
    // 5勢力中4勢力が交戦（4/5=0.8 > 2/3）だが、生存数が最低ライン（6）に届かないため見送る。
    const a = makeFaction("faction_a", { [asFactionId("faction_b")]: "war" });
    const b = makeFaction("faction_b", { [asFactionId("faction_a")]: "war" });
    const c = makeFaction("faction_c", { [asFactionId("faction_d")]: "war" });
    const d = makeFaction("faction_d", { [asFactionId("faction_c")]: "war" });
    const e = makeFaction("faction_e", {});
    const state = {
      ...createInitialGameState(),
      factions: Object.fromEntries([a, b, c, d, e].map((x) => [x.id, x])),
    };

    const result = checkGreatWar(state);
    expect(result.aliveFactions).toBe(5);
    expect(result.warRatio).toBeCloseTo(4 / 5); // 比率自体は閾値を超えている
    expect(result.triggered).toBe(false); // が、最低勢力数に届かないため発生しない
  });

  it("臣従（vassal）した勢力の古い戦争ステータスは大戦判定のカウントから除外される（ユーザー報告）", () => {
    // a・b は実際に交戦中。c は d に服属済み（suzerain: d）だが、服属前の古い
    // 「戦争」ステータスが diplomacy に残ったまま（現実装ではここを掃除しない）。
    // vassal を除外しなければ a・b・c の3/4=0.75で大戦条件（2/3）を誤って満たしてしまう。
    const a = makeFaction("faction_a", { [asFactionId("faction_b")]: "war" });
    const b = makeFaction("faction_b", { [asFactionId("faction_a")]: "war" });
    const c: Faction = {
      ...makeFaction("faction_c", { [asFactionId("faction_stale_enemy")]: "war" }),
      suzerain: asFactionId("faction_d"),
    };
    const d = makeFaction("faction_d", { [asFactionId("faction_c")]: "vassal" });
    const state = {
      ...createInitialGameState(),
      factions: Object.fromEntries([a, b, c, d].map((f) => [f.id, f])),
    };

    const result = checkGreatWar(state);
    expect(result.atWarFactions).toBe(2); // a, b のみ（c は臣従済みのため除外）
    expect(result.aliveFactions).toBe(4); // c・d 自体は生存勢力として数える
    expect(result.warRatio).toBeCloseTo(0.5);
    expect(result.triggered).toBe(false);
  });
});
