import { describe, expect, it } from "vitest";
import { asArmyId, asCharacterId, asFactionId, asRegionId } from "../models/ids.js";
import type { Army } from "../models/army.js";
import type { Character } from "../models/character.js";
import type { Faction } from "../models/faction.js";
import type { GameState } from "../models/gameState.js";
import type { Region } from "../models/region.js";
import { advanceYear, detectFlanking, detectSurprise, findMostConsequentialHostilePair, runPhase } from "./turnEngine.js";
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
    };

    const next = runPhase(state);
    expect(next.factions[factionId]?.ruler).toBe(child.id);
    expect(next.characters[child.id]?.role).toBe("ruler");
  });
});

describe("大戦発生時の停止", () => {
  it("年末集計で大戦条件を満たすと greatWarTriggered が立ち、以降 advanceYear は何もしない", () => {
    const f1 = asFactionId("f1");
    const f2 = asFactionId("f2");
    const f3 = asFactionId("f3");
    const state: GameState = {
      turn: 10,
      year: 972,
      phase: "year_end",
      regions: {},
      factions: {
        [f1]: makeFaction({ id: f1, name: "F1", ruler: null, diplomacy: { [f2]: "war" } }),
        [f2]: makeFaction({ id: f2, name: "F2", ruler: null, diplomacy: { [f1]: "war" } }),
        [f3]: makeFaction({ id: f3, name: "F3", ruler: null, diplomacy: { [f1]: "war" } }),
      },
      armies: {},
      characters: {},
      captivities: {},
      greatWarTriggered: false,
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
