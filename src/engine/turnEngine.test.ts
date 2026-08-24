import { describe, expect, it } from "vitest";
import { asArmyId, asCharacterId, asFactionId, asRegionId } from "../models/ids.js";
import type { FactionId } from "../models/ids.js";
import type { Army } from "../models/army.js";
import type { Character } from "../models/character.js";
import type { Faction } from "../models/faction.js";
import type { GameState } from "../models/gameState.js";
import type { Region } from "../models/region.js";
import {
  advanceYear,
  advanceYearAsync,
  detectFlanking,
  detectSurprise,
  findMostConsequentialHostilePair,
  runAction,
  runDiplomacy,
  runPhase,
} from "./turnEngine.js";
import { createInitialGameState } from "../data/initialState.js";
import { validateGameState } from "../utils/validation.js";

function makeCharacter(over: Partial<Character> & Pick<Character, "id" | "name" | "faction">): Character {
  return {
    role: "ruler",
    skills: { command: 0.5, diplomacy: 0.3, administration: 0.3 },
    traits: [],
    age: 30,
    alive: true,
    policy: "self_preservation",
    spouse: null,
    children: [],
    parents: [],
    adoptedChildren: [],
    adoptedBy: null,
    ...over,
  };
}

function makeFaction(over: Partial<Faction> & Pick<Faction, "id" | "name" | "ruler">): Faction {
  return {
    type: "lord",
    consort: null,
    children: [],
    heir: null,
    chancellors: [],
    warlords: [],
    regions: [],
    treasury: 1000,
    diplomacy: {},
    suzerain: null,
    alive: true,
    ...over,
  };
}

function makeRegion(over: Partial<Region> & Pick<Region, "id" | "owner">): Region {
  return {
    name: "戦場",
    terrain: "plain",
    terrainModifier: { attack: 1.0, defense: 1.0 },
    population: 10_000,
    taxBase: 100,
    archetype: "continental",
    garrison: { count: 0, training: 0 },
    adjacency: [],
    fortified: false,
    siege: null,
    frontier: false,
    ...over,
  };
}

describe("advanceYear（初期サンプルデータ）", () => {
  it("戦争状態がなければ、そのまま年が1つ進む", () => {
    const state = createInitialGameState();
    const next = advanceYear(state);

    expect(next.year).toBe(state.year + 1);
    expect(next.turn).toBe(state.turn + 1);
    expect(next.phase).toBe("year_start");
    expect(next.greatWarTriggered).toBe(false);
    expect(validateGameState(next).issues).toEqual([]);
  });
});

describe("戦闘解決フェイズの統合", () => {
  const factionA = asFactionId("faction_a");
  const factionB = asFactionId("faction_b");
  const regionId = asRegionId("battlefield");

  function buildWarState(): GameState {
    const attackerCommander = makeCharacter({
      id: asCharacterId("attacker_cmd"),
      name: "攻撃側指揮官",
      faction: factionA,
      role: "warlord",
      skills: { command: 0.7, diplomacy: 0.2, administration: 0.2 },
    });
    const defenderCommander = makeCharacter({
      id: asCharacterId("defender_cmd"),
      name: "防御側指揮官",
      faction: factionB,
      role: "warlord",
      skills: { command: 0.3, diplomacy: 0.2, administration: 0.2 },
    });

    const region = makeRegion({ id: regionId, owner: factionB, adjacency: [] }); // 退路なし

    const attackerArmy: Army = {
      id: asArmyId("army_a"),
      faction: factionA,
      commander: attackerCommander.id,
      location: regionId,
      units: [{ type: "infantry", count: 6000, training: 0.6 }],
      doctrine: "default",
      morale: 0.8,
      supply: 1.0,
    };
    const defenderArmy: Army = {
      id: asArmyId("army_b"),
      faction: factionB,
      commander: defenderCommander.id,
      location: regionId,
      units: [{ type: "infantry", count: 1000, training: 0.4 }],
      doctrine: "default",
      morale: 0.5,
      supply: 1.0,
    };

    const fA = makeFaction({ id: factionA, name: "A国", ruler: null, diplomacy: { [factionB]: "war" } });
    const fB = makeFaction({ id: factionB, name: "B国", ruler: null, regions: [regionId], diplomacy: { [factionA]: "war" } });
    // 大戦判定（戦争状態の勢力が2/3以上）を誤って発火させないための、戦争に無関係な中立勢力。
    const neutral1 = makeFaction({ id: asFactionId("faction_neutral1"), name: "中立国1", ruler: null });
    const neutral2 = makeFaction({ id: asFactionId("faction_neutral2"), name: "中立国2", ruler: null });

    const state: GameState = {
      turn: 1,
      year: 963,
      phase: "battle_resolution",
      regions: { [regionId]: region },
      factions: { [factionA]: fA, [factionB]: fB, [neutral1.id]: neutral1, [neutral2.id]: neutral2 },
      armies: { [attackerArmy.id]: attackerArmy, [defenderArmy.id]: defenderArmy },
      characters: {
        [attackerCommander.id]: attackerCommander,
        [defenderCommander.id]: defenderCommander,
      },
      captivities: {},
      greatWarTriggered: false,
      playerFactionId: null,
      spectator: null,
      };
          return state;
  }

  it("同一州の敵対軍を解決し、占領・捕虜登録・年末フェイズへの遷移を行う", () => {
    const state = buildWarState();
    const next = runPhase(state); // battle_resolution

    expect(next.phase).toBe("year_end");
    // 兵力・練度で圧倒する攻撃側が州を占領する。
    expect(next.regions[regionId]?.owner).toBe(factionA);
    // 退路がないため、敗れた防御側の指揮官は捕虜になる。
    expect(next.captivities[asCharacterId("defender_cmd")]).toBeDefined();
    expect(next.captivities[asCharacterId("defender_cmd")]?.captor).toBe(factionA);
    // 防御側の軍は全滅/捕虜化して消滅している。
    expect(next.armies[asArmyId("army_b")]).toBeUndefined();

    expect(validateGameState(next).issues).toEqual([]);
  });

  it("advanceYear で1年分（外交・行動フェイズのスタブを含む）を通しで処理できる", () => {
    const state = buildWarState();
    const next = advanceYear(state);

    expect(next.year).toBe(964);
    expect(next.phase).toBe("year_start");
    expect(next.regions[regionId]?.owner).toBe(factionA);
  });
});

describe("後継者危機の統合", () => {
  it("君主が跡継ぎなく死亡すると、年始フェイズで後継者危機が解決される（無主化）", () => {
    const factionId = asFactionId("faction_a");
    const ruler = makeCharacter({ id: asCharacterId("ruler"), name: "君主", faction: factionId, alive: false });
    const faction = makeFaction({ id: factionId, name: "A家", ruler: ruler.id });

    const state: GameState = {
      turn: 5,
      year: 967,
      phase: "year_start",
      regions: {},
      factions: { [factionId]: faction },
      armies: {},
      characters: { [ruler.id]: ruler },
      captivities: {},
      greatWarTriggered: false,
      playerFactionId: null,
      spectator: null,
      };
    const next = runPhase(state); // year_start
    expect(next.phase).toBe("diplomacy");
    expect(next.factions[factionId]?.alive).toBe(false); // claimant不在で無主化
  });

  it("生存する実子がいれば、年始フェイズで自動的に即位する", () => {
    const factionId = asFactionId("faction_a");
    const child = makeCharacter({ id: asCharacterId("child"), name: "子", faction: factionId, role: "heir" });
    const ruler = makeCharacter({
      id: asCharacterId("ruler"),
      name: "君主",
      faction: factionId,
      alive: false,
      children: [child.id],
    });
    const faction = makeFaction({ id: factionId, name: "A家", ruler: ruler.id });

    const state: GameState = {
      turn: 5,
      year: 967,
      phase: "year_start",
      regions: {},
      factions: { [factionId]: faction },
      armies: {},
      characters: { [ruler.id]: ruler, [child.id]: child },
      captivities: {},
      greatWarTriggered: false,
      playerFactionId: null,
      spectator: null,
      };
    const next = runPhase(state);
    expect(next.factions[factionId]?.ruler).toBe(child.id);
    expect(next.characters[child.id]?.role).toBe("ruler");
  });
});

describe("大戦発生時の停止", () => {
  it("年末集計で大戦条件を満たすと greatWarTriggered が立ち、以降 advanceYear は何もしない", () => {
    // 大戦は多極的な世界を前提とする（`GREAT_WAR_MIN_ALIVE_FACTIONS`、warCheck.ts）ため、
    // 最低ラインを満たすよう6勢力・4勢力交戦の構成にする。
    const f1 = asFactionId("f1");
    const f2 = asFactionId("f2");
    const f3 = asFactionId("f3");
    const f4 = asFactionId("f4");
    const f5 = asFactionId("f5");
    const f6 = asFactionId("f6");
    const state: GameState = {
      turn: 10,
      year: 972,
      phase: "year_end",
      regions: {},
      factions: {
        [f1]: makeFaction({ id: f1, name: "F1", ruler: null, diplomacy: { [f2]: "war" } }),
        [f2]: makeFaction({ id: f2, name: "F2", ruler: null, diplomacy: { [f1]: "war" } }),
        [f3]: makeFaction({ id: f3, name: "F3", ruler: null, diplomacy: { [f1]: "war" } }),
        [f4]: makeFaction({ id: f4, name: "F4", ruler: null, diplomacy: { [f3]: "war" } }),
        [f5]: makeFaction({ id: f5, name: "F5", ruler: null, diplomacy: {} }),
        [f6]: makeFaction({ id: f6, name: "F6", ruler: null, diplomacy: {} }),
      },
      armies: {},
      characters: {},
      captivities: {},
      greatWarTriggered: false,
      playerFactionId: null,
      spectator: null,
      };
    const next = runPhase(state); // year_end
    expect(next.greatWarTriggered).toBe(true);
    expect(next.year).toBe(972); // 年は進まない

    const stillFrozen = advanceYear(next);
    expect(stillFrozen).toEqual(next);
  });
});

describe("多重戦闘・奇襲・挟撃の判定（設計書 3.7）", () => {
  const factionA = asFactionId("faction_a");
  const factionB = asFactionId("faction_b");
  const factionC = asFactionId("faction_c");
  const regionId = asRegionId("battlefield");
  const neighborId = asRegionId("neighbor");

  function army(over: Partial<Army> & Pick<Army, "id" | "faction">): Army {
    return {
      commander: null,
      location: regionId,
      units: [{ type: "infantry", count: 1000, training: 0.5 }],
      doctrine: "default",
      morale: 0.7,
      supply: 1.0,
      ...over,
    };
  }

  describe("findMostConsequentialHostilePair", () => {
    it("複数の敵対ペアがある場合、実効兵力の合計が最大のペアを選ぶ", () => {
      const fA = makeFaction({ id: factionA, name: "A", ruler: null, diplomacy: { [factionB]: "war" } });
      const fB = makeFaction({ id: factionB, name: "B", ruler: null, diplomacy: { [factionA]: "war", [factionC]: "war" } });
      const fC = makeFaction({ id: factionC, name: "C", ruler: null, diplomacy: { [factionB]: "war" } });
      const state: GameState = {
        turn: 1,
        year: 963,
        phase: "battle_resolution",
        regions: {},
        factions: { [factionA]: fA, [factionB]: fB, [factionC]: fC },
        armies: {},
        characters: {},
        captivities: {},
        greatWarTriggered: false,
        playerFactionId: null,
        spectator: null,
        };
      const small = army({ id: asArmyId("small_a"), faction: factionA, units: [{ type: "infantry", count: 100, training: 0.3 }] });
      const big = army({ id: asArmyId("big_b"), faction: factionB, units: [{ type: "infantry", count: 9000, training: 0.8 }] });
      const medium = army({ id: asArmyId("medium_c"), faction: factionC, units: [{ type: "infantry", count: 3000, training: 0.6 }] });

      // A-B は小さい兵力同士、B-C は大きい兵力同士 → B-C が選ばれるはず。
      const pair = findMostConsequentialHostilePair([small, big, medium], state);
      expect(pair).not.toBeNull();
      const ids = new Set(pair!.map((a) => a.id));
      expect(ids).toEqual(new Set([big.id, medium.id]));
    });

    it("敵対ペアが無ければ null を返す", () => {
      const fA = makeFaction({ id: factionA, name: "A", ruler: null });
      const fB = makeFaction({ id: factionB, name: "B", ruler: null });
      const state: GameState = {
        turn: 1,
        year: 963,
        phase: "battle_resolution",
        regions: {},
        factions: { [factionA]: fA, [factionB]: fB },
        armies: {},
        characters: {},
        captivities: {},
        greatWarTriggered: false,
        playerFactionId: null,
        spectator: null,
        };
              const a = army({ id: asArmyId("a"), faction: factionA });
      const b = army({ id: asArmyId("b"), faction: factionB });
      expect(findMostConsequentialHostilePair([a, b], state)).toBeNull();
    });
  });

  describe("detectSurprise", () => {
    const region = makeRegion({ id: regionId, owner: factionB, adjacency: [neighborId] });

    it("隣接州に指揮能力の高い指揮官を伴う自軍がいれば奇襲成立", () => {
      const skilledCommander = makeCharacter({
        id: asCharacterId("skilled"),
        name: "有能な指揮官",
        faction: factionA,
        skills: { command: 0.8, diplomacy: 0.2, administration: 0.2 },
      });
      const scoutArmy = army({ id: asArmyId("scout"), faction: factionA, location: neighborId, commander: skilledCommander.id });
      const state: GameState = {
        turn: 1,
        year: 963,
        phase: "battle_resolution",
        regions: { [regionId]: region },
        factions: {},
        armies: { [scoutArmy.id]: scoutArmy },
        characters: { [skilledCommander.id]: skilledCommander },
        captivities: {},
        greatWarTriggered: false,
        playerFactionId: null,
        spectator: null,
        };
              expect(detectSurprise(factionA, region, state)).toBe(true);
    });

    it("指揮官の能力が閾値未満なら奇襲不成立", () => {
      const weakCommander = makeCharacter({
        id: asCharacterId("weak"),
        name: "凡庸な指揮官",
        faction: factionA,
        skills: { command: 0.3, diplomacy: 0.2, administration: 0.2 },
      });
      const scoutArmy = army({ id: asArmyId("scout2"), faction: factionA, location: neighborId, commander: weakCommander.id });
      const state: GameState = {
        turn: 1,
        year: 963,
        phase: "battle_resolution",
        regions: { [regionId]: region },
        factions: {},
        armies: { [scoutArmy.id]: scoutArmy },
        characters: { [weakCommander.id]: weakCommander },
        captivities: {},
        greatWarTriggered: false,
        playerFactionId: null,
        spectator: null,
        };
              expect(detectSurprise(factionA, region, state)).toBe(false);
    });

    it("隣接州に自軍がいなければ奇襲不成立", () => {
      const state: GameState = {
        turn: 1,
        year: 963,
        phase: "battle_resolution",
        regions: { [regionId]: region },
        factions: {},
        armies: {},
        characters: {},
        captivities: {},
        greatWarTriggered: false,
        playerFactionId: null,
        spectator: null,
        };
              expect(detectSurprise(factionA, region, state)).toBe(false);
    });
  });

  describe("detectFlanking", () => {
    const region = makeRegion({ id: regionId, owner: factionB });

    it("同じ州に自軍がもう1隊いれば挟撃成立", () => {
      const main = army({ id: asArmyId("main"), faction: factionA, location: regionId });
      const support = army({ id: asArmyId("support"), faction: factionA, location: regionId });
      const state: GameState = {
        turn: 1,
        year: 963,
        phase: "battle_resolution",
        regions: { [regionId]: region },
        factions: {},
        armies: { [main.id]: main, [support.id]: support },
        characters: {},
        captivities: {},
        greatWarTriggered: false,
        playerFactionId: null,
        spectator: null,
        };
              expect(detectFlanking(factionA, main.id, region, state)).toBe(true);
    });

    it("自軍がその1隊のみなら挟撃不成立", () => {
      const main = army({ id: asArmyId("main2"), faction: factionA, location: regionId });
      const state: GameState = {
        turn: 1,
        year: 963,
        phase: "battle_resolution",
        regions: { [regionId]: region },
        factions: {},
        armies: { [main.id]: main },
        characters: {},
        captivities: {},
        greatWarTriggered: false,
        playerFactionId: null,
        spectator: null,
        };
              expect(detectFlanking(factionA, main.id, region, state)).toBe(false);
    });
  });

  it("統合: 3勢力が同じ州に居合わせても、敵対ペアが尽きるまで逐次解決する", () => {
    const region = makeRegion({ id: regionId, owner: factionA, adjacency: [] });

    const weakA = army({ id: asArmyId("army_a"), faction: factionA, units: [{ type: "infantry", count: 300, training: 0.3 }] });
    const hugeB = army({ id: asArmyId("army_b"), faction: factionB, units: [{ type: "infantry", count: 20_000, training: 0.7 }] });
    const weakC = army({ id: asArmyId("army_c"), faction: factionC, units: [{ type: "infantry", count: 300, training: 0.3 }] });

    const fA = makeFaction({ id: factionA, name: "A", ruler: null, diplomacy: { [factionB]: "war" } });
    const fB = makeFaction({
      id: factionB,
      name: "B",
      ruler: null,
      regions: [regionId],
      diplomacy: { [factionA]: "war", [factionC]: "war" },
    });
    const fC = makeFaction({ id: factionC, name: "C", ruler: null, diplomacy: { [factionB]: "war" } });
    // 大戦誤爆防止用の中立勢力。
    const neutral1 = makeFaction({ id: asFactionId("neutral1"), name: "中立1", ruler: null });
    const neutral2 = makeFaction({ id: asFactionId("neutral2"), name: "中立2", ruler: null });

    const state: GameState = {
      turn: 1,
      year: 963,
      phase: "battle_resolution",
      regions: { [regionId]: region },
      factions: { [factionA]: fA, [factionB]: fB, [factionC]: fC, [neutral1.id]: neutral1, [neutral2.id]: neutral2 },
      armies: { [weakA.id]: weakA, [hugeB.id]: hugeB, [weakC.id]: weakC },
      characters: {},
      captivities: {},
      greatWarTriggered: false,
      playerFactionId: null,
      spectator: null,
      };
    const next = runPhase(state); // battle_resolution

    // 圧倒的に強い B が、A・C の双方との戦闘を同一ターン内に解決し、両方を打ち破る。
    const remainingArmies = Object.values(next.armies).filter((a) => a.location === regionId);
    const remainingFactions = new Set(remainingArmies.map((a) => a.faction));
    expect(remainingFactions.has(factionA)).toBe(false);
    expect(remainingFactions.has(factionC)).toBe(false);
    expect(validateGameState(next).issues).toEqual([]);
  });
});

describe("外交フェイズへのAI接続（設計書 9.4）", () => {
  const strongId = asFactionId("faction_strong");
  const weakId = asFactionId("faction_weak");

  function twoFactionPeaceState(strongRulerOver: Partial<Character> = {}): GameState {
    const strongRuler = makeCharacter({
      id: asCharacterId("strong_ruler"),
      name: "強国の君主",
      faction: strongId,
      policy: "expansionism",
      ...strongRulerOver,
    });
    const weakRuler = makeCharacter({ id: asCharacterId("weak_ruler"), name: "弱国の君主", faction: weakId, policy: "self_preservation" });

    const strongRegion = makeRegion({
      id: asRegionId("r_strong"),
      owner: strongId,
      garrison: { count: 10_000, training: 0.9 },
    });
    const weakRegion = makeRegion({
      id: asRegionId("r_weak"),
      owner: weakId,
      garrison: { count: 100, training: 0.3 },
    });

    const strongFaction = makeFaction({
      id: strongId,
      name: "強国",
      ruler: strongRuler.id,
      regions: [strongRegion.id],
      diplomacy: { [weakId]: "peace" },
    });
    const weakFaction = makeFaction({
      id: weakId,
      name: "弱国",
      ruler: weakRuler.id,
      regions: [weakRegion.id],
      diplomacy: { [strongId]: "peace" },
    });
    // 大戦誤爆防止用の中立勢力（生存4勢力中2勢力の開戦＝war_ratio 50%に留め、
    // 2/3の大戦閾値を超えないようにする。2〜3勢力だけだと即座に閾値を超えてしまうため）。
    const neutral1 = makeFaction({ id: asFactionId("faction_neutral1"), name: "中立国1", ruler: null });
    const neutral2 = makeFaction({ id: asFactionId("faction_neutral2"), name: "中立国2", ruler: null });

    return {
      turn: 1,
      year: 1000,
      phase: "diplomacy",
      regions: { [strongRegion.id]: strongRegion, [weakRegion.id]: weakRegion },
      factions: { [strongId]: strongFaction, [weakId]: weakFaction, [neutral1.id]: neutral1, [neutral2.id]: neutral2 },
      armies: {},
      characters: { [strongRuler.id]: strongRuler, [weakRuler.id]: weakRuler },
      captivities: {},
      greatWarTriggered: false,
      playerFactionId: null,
      spectator: null,
    };
  }

  it("圧倒的に強い拡張主義の勢力は、弱小な隣国に宣戦布告する", () => {
    const state = twoFactionPeaceState();
    const next = runDiplomacy(state);

    expect(next.factions[strongId]?.diplomacy[weakId]).toBe("war");
    expect(next.factions[weakId]?.diplomacy[strongId]).toBe("war");
    expect(next.phase).toBe("action");
    expect(validateGameState(next).issues).toEqual([]);
  });

  it("プレイヤー勢力は自動的な外交判断の対象から除外される", () => {
    const state = { ...twoFactionPeaceState(), playerFactionId: strongId };
    const next = runDiplomacy(state);

    // 強国（プレイヤー）が動かないため、外交状態は変化しない。
    expect(next.factions[strongId]?.diplomacy[weakId]).toBe("peace");
    expect(next.factions[weakId]?.diplomacy[strongId]).toBe("peace");
  });

  it("その一手が単独で大戦（世界のゲームオーバー）を引き起こす場合は見送る", () => {
    // 生存6勢力（大戦の最低勢力数 `GREAT_WAR_MIN_ALIVE_FACTIONS` を満たす）中、
    // 既に3勢力（弱国・第三国・第四国）が戦争状態（war_ratio 50%）。
    // ここで強国が弱国にも宣戦すると、戦争状態の勢力が4/6＝約67%となり、
    // 大戦の閾値（2/3）を単独で超えてしまう。
    const thirdId = asFactionId("faction_third");
    const fourthId = asFactionId("faction_fourth");
    const thirdRuler = makeCharacter({ id: asCharacterId("third_ruler"), name: "第三国の君主", faction: thirdId });
    const fourthRuler = makeCharacter({ id: asCharacterId("fourth_ruler"), name: "第四国の君主", faction: fourthId });
    const thirdFaction = makeFaction({
      id: thirdId,
      name: "第三国",
      ruler: thirdRuler.id,
      diplomacy: { [weakId]: "war", [fourthId]: "war" },
    });
    const fourthFaction = makeFaction({ id: fourthId, name: "第四国", ruler: fourthRuler.id, diplomacy: { [thirdId]: "war" } });

    const base = twoFactionPeaceState();
    const weakWithThirdWar = {
      ...base.factions[weakId]!,
      diplomacy: { ...base.factions[weakId]!.diplomacy, [thirdId]: "war" as const },
    };

    const state: GameState = {
      ...base,
      factions: { ...base.factions, [weakId]: weakWithThirdWar, [thirdId]: thirdFaction, [fourthId]: fourthFaction },
      characters: { ...base.characters, [thirdRuler.id]: thirdRuler, [fourthRuler.id]: fourthRuler },
    };

    const next = runDiplomacy(state);

    // 強国は「弱国へ宣戦する」を選びたいはずだが、大戦を単独で引き起こすため見送られる。
    expect(next.factions[strongId]?.diplomacy[weakId]).toBe("peace");
    expect(next.greatWarTriggered).toBe(false);
  });
});

describe("行動フェイズへのAI接続（設計書 9.4）", () => {
  const attackerId = asFactionId("faction_attacker");
  const defenderId = asFactionId("faction_defender");
  const homeId = asRegionId("r_home");
  const targetId = asRegionId("r_target");

  function warState(): GameState {
    const commander = makeCharacter({
      id: asCharacterId("commander"),
      name: "指揮官",
      faction: attackerId,
      role: "warlord",
      policy: "expansionism",
      skills: { command: 0.8, diplomacy: 0.2, administration: 0.2 },
    });
    const homeRegion = makeRegion({ id: homeId, owner: attackerId, adjacency: [targetId] });
    const targetRegion = makeRegion({
      id: targetId,
      owner: defenderId,
      adjacency: [homeId],
      garrison: { count: 50, training: 0.2 },
    });
    const attackerFaction = makeFaction({
      id: attackerId,
      name: "攻め手",
      ruler: null,
      regions: [homeId],
      warlords: [commander.id],
      diplomacy: { [defenderId]: "war" },
    });
    const defenderFaction = makeFaction({
      id: defenderId,
      name: "受け手",
      ruler: null,
      regions: [targetId],
      diplomacy: { [attackerId]: "war" },
    });
    const attackerArmy: Army = {
      id: asArmyId("army_attacker"),
      faction: attackerId,
      commander: commander.id,
      location: homeId,
      units: [{ type: "infantry", count: 5000, training: 0.8 }],
      doctrine: "default",
      morale: 0.9,
      supply: 1.0,
    };

    return {
      turn: 1,
      year: 1000,
      phase: "action",
      regions: { [homeId]: homeRegion, [targetId]: targetRegion },
      factions: { [attackerId]: attackerFaction, [defenderId]: defenderFaction },
      armies: { [attackerArmy.id]: attackerArmy },
      characters: { [commander.id]: commander },
      captivities: {},
      greatWarTriggered: false,
      playerFactionId: null,
      spectator: null,
    };
  }

  it("優勢な軍団は、隣接する敵地へ侵攻する（州の移動）", () => {
    const state = warState();
    const next = runAction(state);

    expect(next.armies[asArmyId("army_attacker")]?.location).toBe(targetId);
    expect(next.phase).toBe("battle_resolution");
  });

  it("プレイヤー勢力の軍団は自動移動の対象外", () => {
    const state = { ...warState(), playerFactionId: attackerId };
    const next = runAction(state);

    expect(next.armies[asArmyId("army_attacker")]?.location).toBe(homeId);
  });
});

describe("advanceYearAsync（生成AI丸投げ版、設計書 13.1）", () => {
  it("APIキー未設定なら自動的に点数判断へフォールバックしつつ、1年分を通しで処理する", async () => {
    const state = createInitialGameState();
    const next = await advanceYearAsync(state); // aiConfig省略＝APIキー未解決→フォールバック

    expect(next.year).toBe(state.year + 1);
    expect(next.turn).toBe(state.turn + 1);
    expect(next.phase).toBe("year_start");
    expect(validateGameState(next).issues).toEqual([]);
  });
});

describe("州直属の駐留兵による防衛（設計書 3.1、Region.garrison）", () => {
  // 野戦軍が不在の州へ敵対勢力の軍が侵入した場合、駐留兵が防衛力として機能しなければ
  // 無血占領できてしまう（27勢力への拡張時に見つかった実装漏れの回帰テスト）。
  const attackerId = asFactionId("faction_attacker");
  const defenderId = asFactionId("faction_defender");
  const homeId = asRegionId("r_defender_home");

  function buildState(garrisonCount: number, garrisonTraining: number): GameState {
    const defenderRegion = makeRegion({
      id: homeId,
      owner: defenderId,
      adjacency: [],
      garrison: { count: garrisonCount, training: garrisonTraining },
    });
    const attackerFaction = makeFaction({ id: attackerId, name: "攻め手", ruler: null, diplomacy: { [defenderId]: "war" } });
    const defenderFaction = makeFaction({ id: defenderId, name: "受け手", ruler: null, regions: [homeId], diplomacy: { [attackerId]: "war" } });
    const attackerArmy: Army = {
      id: asArmyId("army_attacker"),
      faction: attackerId,
      commander: null,
      location: homeId, // 既に侵入済みの状態からスタートする（行動フェイズの移動は別のテストで検証済み）
      units: [{ type: "infantry", count: 5000, training: 0.8 }],
      doctrine: "default",
      morale: 0.9,
      supply: 1.0,
    };

    return {
      turn: 1,
      year: 1000,
      phase: "battle_resolution",
      regions: { [homeId]: defenderRegion },
      factions: { [attackerId]: attackerFaction, [defenderId]: defenderFaction },
      armies: { [attackerArmy.id]: attackerArmy },
      characters: {},
      captivities: {},
      greatWarTriggered: false,
      playerFactionId: null,
      spectator: null,
    };
  }

  it("野戦軍が不在でも、駐留兵が弱ければ占領される（無血占領にはならない）", () => {
    const state = buildState(50, 0.2); // 圧倒的に弱い駐留兵
    const next = runPhase(state); // battle_resolution

    expect(next.regions[homeId]?.owner).toBe(attackerId);
    expect(next.factions[defenderId]?.regions).not.toContain(homeId);
    expect(next.factions[attackerId]?.regions).toContain(homeId);
    expect(validateGameState(next).issues).toEqual([]);
  });

  it("駐留兵が十分強ければ、侵入した軍を撃退できる（占領を防げる）", () => {
    const state = buildState(25_000, 0.85); // 攻撃側より圧倒的に強い駐留兵
    const next = runPhase(state); // battle_resolution

    expect(next.regions[homeId]?.owner).toBe(defenderId); // 占領されない
    expect(validateGameState(next).issues).toEqual([]);
  });
});

describe("近攻遠交（設計書 9.4／ユーザー要望）", () => {
  // A（弱い）は隣接する B（強い、脅威）と交戦中。B は C（A とは非隣接）とも隣接している。
  // A にとって C は「脅威 B を挟んで反対側にいる」遠交の候補になる。
  const factionA = asFactionId("faction_a");
  const factionB = asFactionId("faction_b");
  const factionC = asFactionId("faction_c");
  const regionA = asRegionId("region_a");
  const regionB = asRegionId("region_b");
  const regionC = asRegionId("region_c");

  function buildState(): GameState {
    const rulerA = makeCharacter({ id: asCharacterId("ruler_a"), name: "A候", faction: factionA, policy: "self_preservation" });
    const rulerB = makeCharacter({ id: asCharacterId("ruler_b"), name: "B候", faction: factionB });
    const rulerC = makeCharacter({ id: asCharacterId("ruler_c"), name: "C候", faction: factionC });

    const rA = makeRegion({ id: regionA, owner: factionA, adjacency: [regionB], garrison: { count: 100, training: 0.3 } });
    const rB = makeRegion({ id: regionB, owner: factionB, adjacency: [regionA, regionC], garrison: { count: 20_000, training: 0.9 } });
    const rC = makeRegion({ id: regionC, owner: factionC, adjacency: [regionB], garrison: { count: 500, training: 0.5 } });

    const fA = makeFaction({ id: factionA, name: "A国", ruler: rulerA.id, regions: [regionA], diplomacy: { [factionB]: "war" } });
    const fB = makeFaction({ id: factionB, name: "B国（脅威）", ruler: rulerB.id, regions: [regionB], diplomacy: { [factionA]: "war", [factionC]: "peace" } });
    const fC = makeFaction({ id: factionC, name: "C国（遠交の相手）", ruler: rulerC.id, regions: [regionC], diplomacy: { [factionB]: "peace" } });
    // 大戦誤爆防止用の中立勢力。
    const neutral1 = makeFaction({ id: asFactionId("neutral1"), name: "中立1", ruler: null });
    const neutral2 = makeFaction({ id: asFactionId("neutral2"), name: "中立2", ruler: null });

    return {
      turn: 1,
      year: 1000,
      phase: "diplomacy",
      regions: { [regionA]: rA, [regionB]: rB, [regionC]: rC },
      factions: { [factionA]: fA, [factionB]: fB, [factionC]: fC, [neutral1.id]: neutral1, [neutral2.id]: neutral2 },
      armies: {},
      characters: { [rulerA.id]: rulerA, [rulerB.id]: rulerB, [rulerC.id]: rulerC },
      captivities: {},
      greatWarTriggered: false,
      playerFactionId: null,
      spectator: null,
    };
  }

  it("脅威（B）と交戦中のAは、Bを挟んで反対側にいるCへ同盟を持ちかける", () => {
    const state = buildState();
    const next = runDiplomacy(state);

    expect(next.factions[factionA]?.diplomacy[factionC]).toBe("alliance");
    expect(next.factions[factionC]?.diplomacy[factionA]).toBe("alliance");
  });
});

describe("食い詰めた傭兵団の略奪（ユーザー要望）", () => {
  const mercFactionId = asFactionId("faction_merc");
  const neighborFactionId = asFactionId("faction_neighbor");
  const homeId = asRegionId("region_merc_home");
  const neighborId = asRegionId("region_neighbor");
  const mercArmyId = asArmyId("army_merc");

  function army(over: Partial<Army> & Pick<Army, "id" | "faction">): Army {
    return {
      commander: null,
      location: homeId,
      units: [{ type: "cavalry", count: 900, training: 0.55 }],
      doctrine: "default",
      morale: 0.6,
      supply: 0.8,
      ...over,
    };
  }

  function buildState(treasury: number): GameState {
    const captain = makeCharacter({
      id: asCharacterId("captain"),
      name: "傭兵隊長",
      faction: mercFactionId,
      role: "warlord",
      policy: "self_interest",
    });
    // 傭兵団は領地を持たないため、現在地（homeId）は他勢力の領地。ここでは中立との平和状態
    // （非交戦）のまま隣接州を襲撃できるかを見る。
    const home = makeRegion({ id: homeId, owner: neighborFactionId, adjacency: [neighborId], garrison: { count: 0, training: 0 } });
    const neighbor = makeRegion({ id: neighborId, owner: neighborFactionId, adjacency: [homeId], garrison: { count: 50, training: 0.3 } });

    const merc = makeFaction({
      id: mercFactionId,
      name: "自由傭兵団",
      type: "mercenary",
      ruler: null,
      warlords: [captain.id],
      treasury,
      diplomacy: { [neighborFactionId]: "peace" }, // 交戦状態ではない
    });
    const neighborFaction = makeFaction({
      id: neighborFactionId,
      name: "隣国",
      ruler: null,
      regions: [homeId, neighborId],
      diplomacy: { [mercFactionId]: "peace" },
    });

    return {
      turn: 1,
      year: 1000,
      phase: "action",
      regions: { [homeId]: home, [neighborId]: neighbor },
      factions: { [mercFactionId]: merc, [neighborFactionId]: neighborFaction },
      armies: { [mercArmyId]: army({ id: mercArmyId, faction: mercFactionId, commander: captain.id }) },
      characters: { [captain.id]: captain },
      captivities: {},
      greatWarTriggered: false,
      playerFactionId: null,
      spectator: null,
    };
  }

  it("国庫が十分にあれば、交戦していない隣国を襲わずに現在地へ留まる", () => {
    const state = buildState(10_000); // 維持費（900*0.08=72/年）の3年分を大きく上回る
    const next = runAction(state);

    expect(next.armies[mercArmyId]?.location).toBe(homeId);
  });

  it("国庫が底を突くと、交戦状態でなくても現在地（他勢力の領地）で略奪を行い国庫を潤す", () => {
    const state = buildState(100); // 維持費の3年分（216）を下回る＝食い詰めている
    const next = runAction(state);

    // 現在地は既に他勢力の領地であり、まずそこでの略奪が（隣国への移動より）優先される。
    expect(next.armies[mercArmyId]?.location).toBe(homeId);
    const loot = Math.round(state.regions[homeId]!.taxBase * 0.5);
    expect(next.factions[mercFactionId]?.treasury).toBe(100 + loot);
  });

  it("食い詰めていても、現在地が守備側の大軍に押さえられていれば居座らず手薄な隣国へ向かう", () => {
    // 現在地での略奪を断念させるため、現在地に自軍より圧倒的に強い交戦中の敵軍を置く
    // （hostileHereStrength による判定。この場合は隣国への move が「略奪目的の襲撃」
    // ループ・通常の「侵攻」ループのどちらから提示されても、結果として同じ行動になる）。
    const state = buildState(100);
    const guardId = asCharacterId("guard");
    const guard = makeCharacter({ id: guardId, name: "守備隊長", faction: neighborFactionId, role: "warlord" });
    const guardArmyId = asArmyId("army_guard");
    const stateWithGuard: GameState = {
      ...state,
      factions: {
        ...state.factions,
        [mercFactionId]: { ...state.factions[mercFactionId]!, diplomacy: { [neighborFactionId]: "war" } },
        [neighborFactionId]: { ...state.factions[neighborFactionId]!, diplomacy: { [mercFactionId]: "war" } },
      },
      armies: {
        ...state.armies,
        [guardArmyId]: army({
          id: guardArmyId,
          faction: neighborFactionId,
          commander: guardId,
          location: homeId,
          units: [{ type: "pike", count: 5000, training: 0.8 }],
        }),
      },
      characters: { ...state.characters, [guardId]: guard },
    };

    const next = runAction(stateWithGuard);

    expect(next.armies[mercArmyId]?.location).toBe(neighborId);
  });
});

describe("大国キャンペーンAI（設計書 9.4／ユーザー要望）", () => {
  // HRE（5大勢力の1つ）から見て、自領の region_buffer 経由で1ホップ先に弱小な
  // faction_weak がいる。faction_weak は region_ally 経由で faction_third と隣接している
  // （isolate フェイズの遠交候補）。faction_third 自体は HRE との優位差が小さく、
  // 標的としては選ばれない（＝標的選定が本当に「弱い方」を選んでいることの確認を兼ねる）。
  // 中立勢力2つは、開戦後も大戦（2/3閾値）の誤爆を避けるための頭数合わせ。
  const hreId = asFactionId("faction_hre"); // GREAT_POWER_FACTION_IDS の一員
  const weakId = asFactionId("faction_weak");
  const thirdId = asFactionId("faction_third");

  const regionHre = asRegionId("region_hre");
  const regionBuffer = asRegionId("region_buffer");
  const regionTarget = asRegionId("region_target");
  const regionAlly = asRegionId("region_ally");

  function buildState(year: number): GameState {
    const hreRuler = makeCharacter({ id: asCharacterId("hre_ruler"), name: "皇帝", faction: hreId, policy: "expansionism" });
    // expansionism にしておく理由：後段の「劣勢でも和平を結ばない」テストで、標的側が
    // 独自に和平を持ちかけてしまうと HRE 側の抑制ロジックの検証にならない
    // （standard の self_preservation だと、標的視点では有利な状況のため和平を選好しやすい）。
    const weakRuler = makeCharacter({ id: asCharacterId("weak_ruler"), name: "弱小領主", faction: weakId, policy: "expansionism" });
    const thirdRuler = makeCharacter({ id: asCharacterId("third_ruler"), name: "第三国領主", faction: thirdId });

    const rHre = makeRegion({ id: regionHre, owner: hreId, adjacency: [regionBuffer], garrison: { count: 5000, training: 0.8 } });
    const rBuffer = makeRegion({ id: regionBuffer, owner: hreId, adjacency: [regionHre, regionTarget] });
    const rTarget = makeRegion({ id: regionTarget, owner: weakId, adjacency: [regionBuffer, regionAlly], garrison: { count: 50, training: 0.2 } });
    const rAlly = makeRegion({ id: regionAlly, owner: thirdId, adjacency: [regionTarget], garrison: { count: 4000, training: 1.0 } });

    const fHre = makeFaction({
      id: hreId,
      name: "神聖ローマ帝国",
      ruler: hreRuler.id,
      regions: [regionHre, regionBuffer],
      treasury: 10_000,
      diplomacy: {},
    });
    const fWeak = makeFaction({ id: weakId, name: "弱小勢力", ruler: weakRuler.id, regions: [regionTarget], treasury: 100, diplomacy: {} });
    // faction_third は HRE との優位差が CAMPAIGN_MIN_SUPERIORITY_RATIO を下回るよう、
    // 経済力・軍事力ともHREに近い水準にしてある（＝標的候補から除外されるはずだが、
    // isolate フェイズの遠交（同盟）候補としては引き続き有効）。
    const fThird = makeFaction({ id: thirdId, name: "第三国", ruler: thirdRuler.id, regions: [regionAlly], treasury: 9_000, diplomacy: {} });
    const neutral1 = makeFaction({ id: asFactionId("neutral1"), name: "中立1", ruler: null });
    const neutral2 = makeFaction({ id: asFactionId("neutral2"), name: "中立2", ruler: null });

    return {
      turn: 1,
      year,
      phase: "diplomacy",
      regions: { [regionHre]: rHre, [regionBuffer]: rBuffer, [regionTarget]: rTarget, [regionAlly]: rAlly },
      factions: { [hreId]: fHre, [weakId]: fWeak, [thirdId]: fThird, [neutral1.id]: neutral1, [neutral2.id]: neutral2 },
      armies: {},
      characters: { [hreRuler.id]: hreRuler, [weakRuler.id]: weakRuler, [thirdRuler.id]: thirdRuler },
      captivities: {},
      greatWarTriggered: false,
      playerFactionId: null,
      spectator: null,
    };
  }

  it("再評価年かつ十分な優位があれば、射程内の弱小勢力を標的に選び、その隣国へ同盟を持ちかける（isolate）", () => {
    const state = buildState(1000); // 1000 % 20 === 0 ＝再評価年
    const next = runDiplomacy(state);

    expect(next.campaigns?.[hreId]).toMatchObject({ targetFactionId: weakId, phase: "isolate" });
    // 標的（faction_weak）の隣国である faction_third へ同盟を持ちかける（遠交）。
    expect(next.factions[thirdId]?.diplomacy[hreId]).toBe("alliance");
    expect(next.factions[hreId]?.diplomacy[thirdId]).toBe("alliance");
  });

  it("isolateフェイズが既定年数を超えると annihilate へ移行し、即座に標的へ宣戦布告する", () => {
    const state = buildState(1015);
    const withCampaign: GameState = {
      ...state,
      campaigns: { [hreId]: { targetFactionId: weakId, phase: "isolate", startedYear: 1000 } }, // 経過15年
    };
    const next = runDiplomacy(withCampaign);

    expect(next.campaigns?.[hreId]?.phase).toBe("annihilate");
    expect(next.factions[hreId]?.diplomacy[weakId]).toBe("war");
    expect(next.factions[weakId]?.diplomacy[hreId]).toBe("war");
  });

  it("annihilateフェイズで交戦中は、たとえ劣勢でも標的とは和平を結ばない（妥協しない）", () => {
    const state = buildState(1020);
    // HRE を意図的に軍事的劣勢にする（駐留兵を無力化）。素の点数判断であれば「和平を
    // 申し入れる」が最高スコアになりうる状況で、それでもキャンペーンの意志を優先するかを見る。
    const weakened: GameState = {
      ...state,
      regions: { ...state.regions, [regionHre]: { ...state.regions[regionHre]!, garrison: { count: 0, training: 0 } } },
      factions: {
        ...state.factions,
        [hreId]: { ...state.factions[hreId]!, diplomacy: { [weakId]: "war" } },
        [weakId]: { ...state.factions[weakId]!, diplomacy: { [hreId]: "war" }, regions: [regionTarget], treasury: 50_000 },
      },
      campaigns: { [hreId]: { targetFactionId: weakId, phase: "annihilate", startedYear: 990 } },
    };
    // faction_weak 側の軍事力も底上げし、HRE が明確な劣勢になるようにする。
    const stronglyDefended: GameState = {
      ...weakened,
      regions: { ...weakened.regions, [regionTarget]: { ...weakened.regions[regionTarget]!, garrison: { count: 50_000, training: 0.9 } } },
    };

    const next = runDiplomacy(stronglyDefended);

    expect(next.factions[hreId]?.diplomacy[weakId]).toBe("war"); // 和平に転じていない
    expect(next.campaigns?.[hreId]?.phase).toBe("annihilate"); // キャンペーンも継続中
  });

  it("標的が滅亡すると、そのキャンペーンは終了する", () => {
    const state = buildState(1000);
    const withDeadTarget: GameState = {
      ...state,
      factions: { ...state.factions, [weakId]: { ...state.factions[weakId]!, alive: false, regions: [] } },
      campaigns: { [hreId]: { targetFactionId: weakId, phase: "annihilate", startedYear: 980 } },
    };
    const next = runDiplomacy(withDeadTarget);

    expect(next.campaigns?.[hreId]).toBeUndefined();
  });
});

describe("年齢に応じた死亡（仮実装、ユーザー要望：継承システムを実際に発火させるための前提）", () => {
  function buildState(age: number): GameState {
    const char = makeCharacter({ id: asCharacterId("char_elder"), name: "老臣", faction: asFactionId("faction_x"), age });
    return {
      turn: 1,
      year: 1000,
      phase: "year_end",
      regions: {},
      factions: {},
      armies: {},
      characters: { [char.id]: char },
      captivities: {},
      greatWarTriggered: false,
      playerFactionId: null,
      spectator: null,
    };
  }

  it("乱数が常に最小値なら、死亡確率が0より大きい限り必ず死亡する", () => {
    const state = buildState(50);
    const next = runPhase(state, { random: () => 0 });

    expect(next.characters[asCharacterId("char_elder")]?.age).toBe(51);
    expect(next.characters[asCharacterId("char_elder")]?.alive).toBe(false);
  });

  it("乱数が確率を上回れば死亡せず、年齢だけ加算される", () => {
    const state = buildState(50);
    const next = runPhase(state, { random: () => 0.999 });

    expect(next.characters[asCharacterId("char_elder")]?.age).toBe(51);
    expect(next.characters[asCharacterId("char_elder")]?.alive).toBe(true);
  });

  it("既に死亡しているキャラクターは加齢・再判定の対象にならない", () => {
    const state = buildState(50);
    const dead: GameState = {
      ...state,
      characters: { ...state.characters, [asCharacterId("char_elder")]: { ...state.characters[asCharacterId("char_elder")]!, alive: false } },
    };
    const next = runPhase(dead, { random: () => 0 });

    expect(next.characters[asCharacterId("char_elder")]?.age).toBe(50); // 加齢しない
  });
});

describe("神聖ローマ皇帝の選挙（設計書 4.4／ユーザー要望）", () => {
  const mainzId = asFactionId("faction_mainz");
  const trierId = asFactionId("faction_trier");
  const cologneId = asFactionId("faction_cologne");
  const palatinateId = asFactionId("faction_palatinate");
  const brandenburgId = asFactionId("faction_brandenburg");
  const bohemiaId = asFactionId("faction_bohemia");
  const austriaId = asFactionId("faction_austria");
  const bavariaId = asFactionId("faction_bavaria");
  const hreId = asFactionId("faction_hre");
  const papalId = asFactionId("faction_papal");

  function elector(id: FactionId, allyWith: FactionId | null): Faction {
    return makeFaction({ id, name: id, ruler: null, diplomacy: allyWith ? { [allyWith]: "alliance" } : {} });
  }

  function baseState(overrides: Partial<GameState>): GameState {
    return {
      turn: 1,
      year: 1000,
      phase: "year_start",
      regions: {},
      factions: {},
      armies: {},
      characters: {},
      captivities: {},
      greatWarTriggered: false,
      playerFactionId: null,
      spectator: null,
      ...overrides,
    };
  }

  it("帝位保持者の家系が存続していれば、選挙は行われない", () => {
    const hreRuler = makeCharacter({ id: asCharacterId("hre_ruler_title"), name: "皇帝", faction: hreId });
    const hre = makeFaction({ id: hreId, name: "ザクセン選帝侯領", ruler: hreRuler.id });
    const state = baseState({
      factions: { [hreId]: hre },
      characters: { [hreRuler.id]: hreRuler },
      imperialTitle: { holderId: hreId, since: 962 },
    });

    const next = runPhase(state);

    expect(next.imperialTitle).toEqual({ holderId: hreId, since: 962 });
  });

  it("帝位保持者の家系が断絶すると、選帝侯の過半数と同盟している候補が選ばれる", () => {
    // hre（帝位保持者）は既に消滅（factions に存在しない）。
    // オーストリアは4選帝侯、バイエルンは2選帝侯と同盟——オーストリアが選ばれるはず。
    const mainz = elector(mainzId, austriaId);
    const trier = elector(trierId, austriaId);
    const cologne = elector(cologneId, austriaId);
    const palatinate = elector(palatinateId, austriaId);
    const brandenburg = elector(brandenburgId, bavariaId);
    const bohemia = elector(bohemiaId, bavariaId);
    const austria = makeFaction({ id: austriaId, name: "オーストリア辺境伯領", ruler: null });
    const bavaria = makeFaction({ id: bavariaId, name: "バイエルン公国", ruler: null });

    const state = baseState({
      factions: {
        [mainzId]: mainz,
        [trierId]: trier,
        [cologneId]: cologne,
        [palatinateId]: palatinate,
        [brandenburgId]: brandenburg,
        [bohemiaId]: bohemia,
        [austriaId]: austria,
        [bavariaId]: bavaria,
      },
      imperialTitle: { holderId: hreId, since: 962 },
    });

    const next = runPhase(state);

    expect(next.imperialTitle?.holderId).toBe(austriaId);
    expect(next.imperialTitle?.since).toBe(1000);
  });

  it("選帝侯からの支持が同数の場合、経済力に対し軍事力が小さい候補が選ばれる", () => {
    const mainz = elector(mainzId, null);
    const austria = makeFaction({ id: austriaId, name: "オーストリア辺境伯領", ruler: null, treasury: 5000 });
    const bavaria = makeFaction({ id: bavariaId, name: "バイエルン公国", ruler: null, treasury: 5000, warlords: [asCharacterId("bavaria_general")] });
    const bavariaGeneral = makeCharacter({ id: asCharacterId("bavaria_general"), name: "バイエルン将軍", faction: bavariaId, role: "warlord" });
    const bavariaArmy: Army = {
      id: asArmyId("army_bavaria_big"),
      faction: bavariaId,
      commander: bavariaGeneral.id,
      location: asRegionId("region_bavaria"),
      units: [{ type: "infantry", count: 10_000, training: 0.8 }],
      doctrine: "default",
      morale: 0.8,
      supply: 1.0,
    };

    const state = baseState({
      factions: { [mainzId]: mainz, [austriaId]: austria, [bavariaId]: bavaria },
      armies: { [bavariaArmy.id]: bavariaArmy },
      characters: { [bavariaGeneral.id]: bavariaGeneral },
      imperialTitle: { holderId: hreId, since: 962 },
    });

    const next = runPhase(state);

    // 同盟数はどちらも0で並ぶが、バイエルンは強大な軍を持つため脅威と見なされ選ばれない。
    expect(next.imperialTitle?.holderId).toBe(austriaId);
  });

  it("教皇領と交戦中の候補は除外される", () => {
    const mainz = elector(mainzId, austriaId); // オーストリアを支持（同盟支持ではオーストリアが優勢）
    const austria = makeFaction({ id: austriaId, name: "オーストリア辺境伯領", ruler: null, diplomacy: { [papalId]: "war" } });
    // バイエルンは選帝侯の支持こそ無いが、mainz自身（同盟数0のもう1候補）を上回る経済力を
    // 持たせ、除外されなかった場合に確実にバイエルンが選ばれるようにする。
    const bavaria = makeFaction({ id: bavariaId, name: "バイエルン公国", ruler: null, treasury: 100_000 });

    const state = baseState({
      factions: { [mainzId]: mainz, [austriaId]: austria, [bavariaId]: bavaria },
      imperialTitle: { holderId: hreId, since: 962 },
    });

    const next = runPhase(state);

    // 同盟支持で勝るオーストリアは教皇と交戦中のため除外され、バイエルンが選ばれる。
    expect(next.imperialTitle?.holderId).toBe(bavariaId);
  });
});

describe("帝位の特典（設計書 4.4／ユーザー要望）", () => {
  it("帝位保持者は毎年、通常の税収に加えて帝国税収ボーナスを得る", () => {
    const hreId = asFactionId("faction_hre");
    const regionId = asRegionId("region_hre_test");
    const rulerHre = makeCharacter({ id: asCharacterId("hre_ruler_bonus"), name: "皇帝", faction: hreId });
    const hre = makeFaction({ id: hreId, name: "ザクセン選帝侯領", ruler: rulerHre.id, regions: [regionId], treasury: 1000 });
    const region = makeRegion({ id: regionId, owner: hreId, taxBase: 0 }); // 税収を0にして帝国ボーナスだけを見る

    const state: GameState = {
      turn: 1,
      year: 1000,
      phase: "year_end",
      regions: { [regionId]: region },
      factions: { [hreId]: hre },
      armies: {},
      characters: { [rulerHre.id]: rulerHre },
      captivities: {},
      greatWarTriggered: false,
      playerFactionId: null,
      spectator: null,
      imperialTitle: { holderId: hreId, since: 962 },
    };

    const next = runPhase(state);

    expect(next.factions[hreId]?.treasury).toBe(1000 + 500); // taxBase=0なので純粋にボーナス分のみ増える
  });
});
