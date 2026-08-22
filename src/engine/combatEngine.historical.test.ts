import { describe, expect, it } from "vitest";
import { asArmyId, asCharacterId, asFactionId, asRegionId } from "../models/ids.js";
import type { Army } from "../models/army.js";
import type { Character } from "../models/character.js";
import type { Region } from "../models/region.js";
import { resolveBattle } from "./combatEngine.js";

/**
 * 史実シナリオによる検証（設計書 3章末尾の検証プロセス・ステップ1）。
 *
 * ここでの目的は「厳密な史実再現」ではなく、gamesystem_europe.md が列挙する
 * 兵科・指揮官のモチーフ（スイス槍兵、イングランド長弓、ノルマン騎士、
 * フス派の野戦築城、ナポレオン式軍団編制など）が、劣勢な兵力でも定説通りの
 * 結果を導けるだけの威力を engine 側の係数で持っているかを確認すること。
 * ここで崩れた場合は combatEngine.ts の係数調整（またはどうしても無理なら
 * causalityGuard による補正）の対象になる。
 */

function makeCharacter(over: Partial<Character> & Pick<Character, "id" | "name" | "faction" | "skills">): Character {
  return {
    role: "warlord",
    traits: [],
    age: 35,
    alive: true,
    policy: "expansionism",
    spouse: null,
    children: [],
    parents: [],
    adoptedChildren: [],
    adoptedBy: null,
    ...over,
  };
}

function makeRegion(over: Partial<Region> & Pick<Region, "id" | "owner">): Region {
  return {
    name: "戦場",
    terrain: "plain",
    terrainModifier: { attack: 1.0, defense: 1.0 },
    population: 50_000,
    taxBase: 300,
    archetype: "continental",
    garrison: { count: 0, training: 0 },
    adjacency: [],
    fortified: false,
    siege: null,
    ...over,
  };
}

describe("史実シナリオ検証", () => {
  it("クレシー/アジャンクール型：寡兵のイングランド長弓兵が仏騎兵の突撃を打ち破る", () => {
    const region = makeRegion({ id: asRegionId("picardy"), owner: asFactionId("faction_france"), terrain: "plain" });
    const englishCommander = makeCharacter({
      id: asCharacterId("black_prince"),
      name: "エドワード黒太子",
      faction: asFactionId("faction_england"),
      skills: { command: 0.75, diplomacy: 0.3, administration: 0.3 },
      traits: ["archery_specialist"],
    });
    const frenchCommander = makeCharacter({
      id: asCharacterId("french_marshal"),
      name: "フランス元帥",
      faction: asFactionId("faction_france"),
      skills: { command: 0.5, diplomacy: 0.4, administration: 0.4 },
      traits: [],
    });

    const englishArmy: Army = {
      id: asArmyId("army_england"),
      faction: asFactionId("faction_england"),
      commander: englishCommander.id,
      location: region.id,
      units: [{ type: "archer", count: 4000, training: 0.6 }],
      doctrine: "english_longbow",
      morale: 0.75,
      supply: 1.0,
    };
    const frenchArmy: Army = {
      id: asArmyId("army_france"),
      faction: asFactionId("faction_france"),
      commander: frenchCommander.id,
      location: region.id,
      units: [{ type: "cavalry", count: 9000, training: 0.5 }],
      doctrine: "norman_knights",
      morale: 0.6,
      supply: 0.9,
    };

    const outcome = resolveBattle({
      turn: 1,
      region,
      regionsById: { [region.id]: region },
      attackerFaction: englishArmy.faction,
      defenderFaction: frenchArmy.faction,
      attackerArmy: englishArmy,
      defenderArmy: frenchArmy,
      attackerCommander: englishCommander,
      defenderCommander: frenchCommander,
    });

    expect(outcome.kind).toBe("occupation"); // 兵力で劣る攻撃側(英)が防御側(仏)を打ち破る
    expect(outcome.newOwner).toBe(englishArmy.faction);
    expect(outcome.attackerCasualties.killed).toBeLessThan(outcome.defenderCasualties.killed);
  });

  it("スイス槍兵型：密集槍兵が数的優位の騎兵突撃を跳ね返す", () => {
    const region = makeRegion({ id: asRegionId("swiss_hill"), owner: asFactionId("faction_swiss"), terrain: "hill", terrainModifier: { attack: 0.95, defense: 1.1 } });
    const cavalryCommander = makeCharacter({
      id: asCharacterId("burgundian_duke"),
      name: "ブルゴーニュ公",
      faction: asFactionId("faction_burgundy"),
      skills: { command: 0.6, diplomacy: 0.5, administration: 0.4 },
      traits: [],
    });
    const pikeCommander = makeCharacter({
      id: asCharacterId("swiss_captain"),
      name: "スイス傭兵隊長",
      faction: asFactionId("faction_swiss"),
      skills: { command: 0.65, diplomacy: 0.2, administration: 0.2 },
      traits: ["infantry_specialist"],
    });

    const cavalryArmy: Army = {
      id: asArmyId("army_burgundy"),
      faction: asFactionId("faction_burgundy"),
      commander: cavalryCommander.id,
      location: region.id,
      units: [{ type: "cavalry", count: 6000, training: 0.6 }],
      doctrine: "norman_knights",
      morale: 0.7,
      supply: 1.0,
    };
    const pikeArmy: Army = {
      id: asArmyId("army_swiss"),
      faction: asFactionId("faction_swiss"),
      commander: pikeCommander.id,
      location: region.id,
      units: [{ type: "pike", count: 3000, training: 0.65 }],
      doctrine: "swiss_pike",
      morale: 0.8,
      supply: 1.0,
    };

    const outcome = resolveBattle({
      turn: 1,
      region,
      regionsById: { [region.id]: region },
      attackerFaction: cavalryArmy.faction,
      defenderFaction: pikeArmy.faction,
      attackerArmy: cavalryArmy,
      defenderArmy: pikeArmy,
      attackerCommander: cavalryCommander,
      defenderCommander: pikeCommander,
    });

    // 兵力で倍以上の攻撃側(騎兵)が、退路のないまま押し返され降伏する。
    expect(outcome.kind).toBe("surrender");
    expect(outcome.defenderCasualties.killed).toBeLessThan(outcome.attackerCasualties.killed);
  });

  it("フス戦争型：野戦築城（ワゴンブルク）に拠る寡兵が騎兵の十字軍を打ち破る", () => {
    const region = makeRegion({
      id: asRegionId("wagenburg"),
      owner: asFactionId("faction_hussite"),
      terrain: "plain",
      fortified: true, // ワゴンブルクを城塞化フラグで表現する
    });
    const crusaderCommander = makeCharacter({
      id: asCharacterId("sigismund"),
      name: "ジギスムント",
      faction: asFactionId("faction_crusaders"),
      skills: { command: 0.5, diplomacy: 0.4, administration: 0.4 },
      traits: [],
    });
    const zizkaCommander = makeCharacter({
      id: asCharacterId("jan_zizka"),
      name: "ヤン・ジシュカ",
      faction: asFactionId("faction_hussite"),
      skills: { command: 0.8, diplomacy: 0.2, administration: 0.3 },
      traits: ["siege_specialist"],
    });

    const crusaderArmy: Army = {
      id: asArmyId("army_crusaders"),
      faction: asFactionId("faction_crusaders"),
      commander: crusaderCommander.id,
      location: region.id,
      units: [{ type: "cavalry", count: 5000, training: 0.55 }],
      doctrine: "norman_knights",
      morale: 0.65,
      supply: 1.0,
    };
    const hussiteArmy: Army = {
      id: asArmyId("army_hussite"),
      faction: asFactionId("faction_hussite"),
      commander: zizkaCommander.id,
      location: region.id,
      units: [{ type: "infantry", count: 3000, training: 0.6 }],
      doctrine: "default",
      morale: 0.85,
      supply: 1.0,
    };

    const outcome = resolveBattle({
      turn: 1,
      region,
      regionsById: { [region.id]: region },
      attackerFaction: crusaderArmy.faction,
      defenderFaction: hussiteArmy.faction,
      attackerArmy: crusaderArmy,
      defenderArmy: hussiteArmy,
      attackerCommander: crusaderCommander,
      defenderCommander: zizkaCommander,
    });

    expect(outcome.kind).toBe("surrender"); // 攻撃側(十字軍)がワゴンブルクに阻まれ敗走する
    expect(outcome.defenderCasualties.killed).toBeLessThan(outcome.attackerCasualties.killed);
  });

  it("ナポレオン式軍団型：戦術洗練度の高さが兵力差を覆す", () => {
    const region = makeRegion({ id: asRegionId("austerlitz"), owner: asFactionId("faction_coalition") });
    const napoleonicArmy: Army = {
      id: asArmyId("army_france"),
      faction: asFactionId("faction_napoleon"),
      commander: null,
      location: region.id,
      units: [{ type: "infantry", count: 6000, training: 0.6 }],
      doctrine: "napoleonic_corps",
      morale: 0.8,
      supply: 1.0,
    };
    const coalitionArmy: Army = {
      id: asArmyId("army_coalition"),
      faction: asFactionId("faction_coalition"),
      commander: null,
      location: region.id,
      units: [{ type: "infantry", count: 8000, training: 0.55 }],
      doctrine: "default",
      morale: 0.65,
      supply: 1.0,
    };

    const outcome = resolveBattle({
      turn: 1,
      region,
      regionsById: { [region.id]: region },
      attackerFaction: napoleonicArmy.faction,
      defenderFaction: coalitionArmy.faction,
      attackerArmy: napoleonicArmy,
      defenderArmy: coalitionArmy,
    });

    expect(outcome.kind).toBe("occupation"); // 兵力で劣るナポレオン式軍団が連合軍を破る
    expect(outcome.newOwner).toBe(napoleonicArmy.faction);
  });

  it("指揮官の有無・技量が同兵力の戦闘を左右する", () => {
    const region = makeRegion({ id: asRegionId("plain_battle"), owner: asFactionId("faction_b") });
    const skilledCommander = makeCharacter({
      id: asCharacterId("skilled_general"),
      name: "熟練の将軍",
      faction: asFactionId("faction_a"),
      skills: { command: 0.9, diplomacy: 0.2, administration: 0.2 },
      traits: ["infantry_specialist"],
    });

    const commandedArmy: Army = {
      id: asArmyId("army_a"),
      faction: asFactionId("faction_a"),
      commander: skilledCommander.id,
      location: region.id,
      units: [{ type: "infantry", count: 3000, training: 0.5 }],
      doctrine: "default",
      morale: 0.7,
      supply: 1.0,
    };
    const leaderlessArmy: Army = {
      id: asArmyId("army_b"),
      faction: asFactionId("faction_b"),
      commander: null, // 指揮官不在
      location: region.id,
      units: [{ type: "infantry", count: 3000, training: 0.5 }],
      doctrine: "default",
      morale: 0.7,
      supply: 1.0,
    };

    const outcome = resolveBattle({
      turn: 1,
      region,
      regionsById: { [region.id]: region },
      attackerFaction: commandedArmy.faction,
      defenderFaction: leaderlessArmy.faction,
      attackerArmy: commandedArmy,
      defenderArmy: leaderlessArmy,
      attackerCommander: skilledCommander,
    });

    expect(outcome.kind).toBe("occupation"); // 兵力・練度が全く同じでも指揮官の有無で決着がつく
    expect(outcome.newOwner).toBe(commandedArmy.faction);
  });

  it("数の暴力：圧倒的な物量は精鋭の戦術的優位を覆しうる（純粋な相性ゲームにはしない）", () => {
    const homeRegion = makeRegion({ id: asRegionId("elite_home"), owner: asFactionId("faction_elite"), adjacency: [asRegionId("elite_rear")] });
    const rearRegion = makeRegion({ id: asRegionId("elite_rear"), owner: asFactionId("faction_elite") });

    const eliteCommander = makeCharacter({
      id: asCharacterId("elite_captain"),
      name: "精鋭隊長",
      faction: asFactionId("faction_elite"),
      skills: { command: 0.8, diplomacy: 0.2, administration: 0.2 },
      traits: ["infantry_specialist"],
    });

    const eliteArmy: Army = {
      id: asArmyId("army_elite"),
      faction: asFactionId("faction_elite"),
      commander: eliteCommander.id,
      location: homeRegion.id,
      units: [{ type: "infantry", count: 2000, training: 0.8 }],
      doctrine: "swiss_pike",
      morale: 0.8,
      supply: 1.0,
    };
    const hordeArmy: Army = {
      id: asArmyId("army_horde"),
      faction: asFactionId("faction_horde"),
      commander: null,
      location: homeRegion.id,
      units: [{ type: "infantry", count: 20_000, training: 0.3 }],
      doctrine: "default",
      // 精鋭側と同じ士気からスタートさせ、「戦意の低さ」ではなく純粋な兵力差の
      // 効果だけを見るシナリオにする。
      morale: 0.8,
      supply: 1.0,
    };

    // 大軍(horde)が精鋭(elite)の本拠地に攻め込む構図。精鋭は防御側。
    const outcome = resolveBattle({
      turn: 1,
      region: homeRegion,
      regionsById: { [homeRegion.id]: homeRegion, [rearRegion.id]: rearRegion },
      attackerFaction: hordeArmy.faction,
      defenderFaction: eliteArmy.faction,
      attackerArmy: hordeArmy,
      defenderArmy: eliteArmy,
      defenderCommander: eliteCommander,
    });

    // 精鋭側が撃退され、後方の自領へ退却する（大軍そのものが常に不利になる設計ではないことの確認）。
    expect(outcome.kind).toBe("retreat");
    expect(outcome.newOwner).toBeNull();
  });
});
