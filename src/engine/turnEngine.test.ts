import { describe, expect, it } from "vitest";
import { asArmyId, asCharacterId, asFactionId, asRegionId } from "../models/ids.js";
import type { Army } from "../models/army.js";
import type { Character } from "../models/character.js";
import type { Faction } from "../models/faction.js";
import type { GameState } from "../models/gameState.js";
import type { Region } from "../models/region.js";
import { advanceYear, runPhase } from "./turnEngine.js";
import { createInitialGameState } from "../data/initialState.js";
import { validateGameState } from "../utils/validation.js";

function makeCharacter(over: Partial<Character> & Pick<Character, "id" | "name" | "faction">): Character {
  return {
    role: "ruler",
    skills: { command: 0.5, diplomacy: 0.3, administration: 0.3 },
    traits: [],
    age: 30,
    alive: true,
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
