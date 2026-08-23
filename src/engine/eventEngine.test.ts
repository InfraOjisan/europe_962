import { describe, expect, it } from "vitest";
import { createInitialGameState } from "../data/initialState.js";
import { asFactionId } from "../models/ids.js";
import type { GameState } from "../models/gameState.js";
import { applyYearStartEvents } from "./eventEngine.js";
import { HISTORICAL_EVENTS } from "../data/historicalEvents.js";
import { validateGameState } from "../utils/validation.js";

const HRE = asFactionId("faction_hre");
const PAPAL = asFactionId("faction_papal");
const BYZANTIUM = asFactionId("faction_byzantium");
const ENGLAND = asFactionId("faction_england");
const WEST_FRANCIA = asFactionId("faction_west_francia");

function atYear(year: number) {
  return { ...createInitialGameState(), year };
}

describe("applyYearStartEvents", () => {
  it("該当する年のイベントがなければ何も変わらない", () => {
    const state = atYear(962);
    const result = applyYearStartEvents(state);
    expect(result.appliedEvents).toHaveLength(0);
    expect(result.state).toEqual(state);
  });

  it("黒死病（1347年）は全州の人口・税基盤を減少させる", () => {
    const state = atYear(1347);
    const before = Object.values(state.regions).reduce((sum, r) => sum + r.population, 0);
    const result = applyYearStartEvents(state);

    expect(result.appliedEvents.map((e) => e.id)).toContain("black_death_1347");
    const after = Object.values(result.state.regions).reduce((sum, r) => sum + r.population, 0);
    expect(after).toBeLessThan(before);
    expect(validateGameState(result.state).issues).toEqual([]);
  });

  it("東西教会分裂（1054年）は教皇領と東ローマの同盟を平和に格下げする", () => {
    const state = atYear(1054);
    expect(state.factions[PAPAL]?.diplomacy[BYZANTIUM]).toBe("peace"); // 初期データでは元々 peace
    // 同盟状態から始まる場合の格下げを確認するため、事前に alliance にしておく。
    const withAlliance = {
      ...state,
      factions: {
        ...state.factions,
        [PAPAL]: { ...state.factions[PAPAL]!, diplomacy: { ...state.factions[PAPAL]!.diplomacy, [BYZANTIUM]: "alliance" as const } },
        [BYZANTIUM]: { ...state.factions[BYZANTIUM]!, diplomacy: { ...state.factions[BYZANTIUM]!.diplomacy, [PAPAL]: "alliance" as const } },
      },
    };
    const result = applyYearStartEvents(withAlliance);
    expect(result.state.factions[PAPAL]?.diplomacy[BYZANTIUM]).toBe("peace");
    expect(result.state.factions[BYZANTIUM]?.diplomacy[PAPAL]).toBe("peace");
  });

  it("ナポレオン戦争（1799年）は西フランク（フランス）を起点に、同盟国以外の全関係を戦争状態にする", () => {
    const state = atYear(1799);
    const westFrancia = asFactionId("faction_west_francia");
    const westFranciaFaction = state.factions[westFrancia]!;
    // 初期データ上の西フランクの関係（同盟国が無い）を確認しておく。
    expect(Object.values(westFranciaFaction.diplomacy)).not.toContain("alliance");
    const relationCount = Object.keys(westFranciaFaction.diplomacy).length;
    expect(relationCount).toBeGreaterThan(0);

    const result = applyYearStartEvents(state);
    const france = result.state.factions[westFrancia]!;
    // 同盟国以外の全関係が戦争状態になる。
    for (const stance of Object.values(france.diplomacy)) {
      expect(stance).toBe("war");
    }
    // 相手側からも対称に war になっている。
    for (const counterpartId of Object.keys(france.diplomacy)) {
      expect(result.state.factions[asFactionId(counterpartId)]?.diplomacy[westFrancia]).toBe("war");
    }
    expect(validateGameState(result.state).issues).toEqual([]);
  });

  it("ナポレオン戦争（1799年）は、同盟国とは開戦せず、西フランクが滅亡していれば何も起こさない", () => {
    const state = atYear(1799);
    const westFrancia = asFactionId("faction_west_francia");
    const withAlliance = {
      ...state,
      factions: {
        ...state.factions,
        [westFrancia]: { ...state.factions[westFrancia]!, diplomacy: { ...state.factions[westFrancia]!.diplomacy, [HRE]: "alliance" as const } },
        [HRE]: { ...state.factions[HRE]!, diplomacy: { ...state.factions[HRE]!.diplomacy, [westFrancia]: "alliance" as const } },
      },
    };
    const result = applyYearStartEvents(withAlliance);
    expect(result.state.factions[westFrancia]?.diplomacy[HRE]).toBe("alliance"); // 同盟国とは開戦しない

    const francePerished: GameState = {
      ...state,
      factions: { ...state.factions, [westFrancia]: { ...state.factions[westFrancia]!, alive: false } },
    };
    const noOpResult = applyYearStartEvents(francePerished);
    expect(noOpResult.state.factions[westFrancia]).toEqual(francePerished.factions[westFrancia]); // no-op
  });

  it("マグナ・カルタ（1215年）はイングランドの国庫を減らす（27勢力シナリオでは実効果を持つ）", () => {
    const state = atYear(1215);
    const before = state.factions[ENGLAND]!.treasury;
    const result = applyYearStartEvents(state);
    expect(result.appliedEvents.map((e) => e.id)).toContain("magna_carta_1215");
    expect(result.state.factions[ENGLAND]?.treasury).toBeLessThan(before);
    expect(validateGameState(result.state).issues).toEqual([]);
  });

  it("百年戦争（1337年）はイングランドと西フランクを戦争状態にする", () => {
    const state = atYear(1337);
    const result = applyYearStartEvents(state);
    expect(result.appliedEvents.map((e) => e.id)).toContain("hundred_years_war_1337");
    expect(result.state.factions[ENGLAND]?.diplomacy[WEST_FRANCIA]).toBe("war");
    expect(result.state.factions[WEST_FRANCIA]?.diplomacy[ENGLAND]).toBe("war");
  });

  it("対応する勢力・キャラクター生成の仕組みが存在しないイベント（例：ジャンヌ・ダルク登場）は安全に無視される", () => {
    const state = atYear(1429);
    const result = applyYearStartEvents(state);
    expect(result.appliedEvents.map((e) => e.id)).toContain("joan_of_arc_1429");
    expect(result.state).toEqual(state); // 効果対象（指揮官生成の仕組み）がないので状態は変化しない
  });

  it("events に空配列を渡すとイベントを無効化できる", () => {
    const state = atYear(1347);
    const result = applyYearStartEvents(state, []);
    expect(result.appliedEvents).toHaveLength(0);
    expect(result.state).toEqual(state);
  });

  it("年表は962年以降の範囲に収まっている", () => {
    for (const event of HISTORICAL_EVENTS) {
      expect(event.year).toBeGreaterThan(962);
    }
  });
});
