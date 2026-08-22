import { describe, expect, it } from "vitest";
import { asArmyId, asCharacterId, asFactionId, asRegionId } from "../models/ids.js";
import type { Army } from "../models/army.js";
import type { Region } from "../models/region.js";
import { resolveBattle } from "./combatEngine.js";

/**
 * このテストは「エンジンが型どおりに動き、圧倒的な兵力差なら
 * 一貫した方向に結果が振れる」ことを確認する smoke test であり、
 * 数値そのものの正しさ（史実再現度）を保証するものではない。
 * バランス調整が進むにつれて閾値のアサーションも見直す。
 */

const region: Region = {
  id: asRegionId("region_test"),
  name: "テスト州",
  owner: asFactionId("faction_defender"),
  terrain: "plain",
  terrainModifier: { attack: 1.0, defense: 1.0 },
  population: 100_000,
  taxBase: 500,
  archetype: "continental",
  garrison: { count: 0, training: 0 },
  adjacency: [], // 隣接なし = 敗者に退路がない
  fortified: false,
  siege: null,
};

function makeArmy(overrides: Partial<Army>): Army {
  return {
    id: asArmyId("army_x"),
    faction: asFactionId("faction_x"),
    commander: null,
    location: region.id,
    units: [{ type: "infantry", count: 1000, training: 0.5 }],
    doctrine: "default",
    morale: 0.7,
    supply: 1,
    ...overrides,
  };
}

describe("resolveBattle", () => {
  it("圧倒的な兵力差があり退路がない場合、劣勢側は占領/降伏で決着する（膠着しない）", () => {
    const attackerArmy = makeArmy({
      id: asArmyId("army_attacker"),
      faction: asFactionId("faction_attacker"),
      units: [{ type: "infantry", count: 5000, training: 0.8 }],
      morale: 0.9,
    });
    const defenderArmy = makeArmy({
      id: asArmyId("army_defender"),
      faction: asFactionId("faction_defender"),
      units: [{ type: "infantry", count: 500, training: 0.3 }],
      morale: 0.5,
    });

    const outcome = resolveBattle({
      turn: 1,
      region,
      regionsById: { [region.id]: region },
      attackerFaction: attackerArmy.faction,
      defenderFaction: defenderArmy.faction,
      attackerArmy,
      defenderArmy,
    });

    expect(outcome.kind).toBe("occupation");
    expect(outcome.newOwner).toBe(attackerArmy.faction);
    expect(outcome.defenderCasualties.killed).toBeGreaterThan(0);
  });

  it("退路がある場合は占領ではなく退却になる", () => {
    const neighbor: Region = { ...region, id: asRegionId("region_neighbor"), owner: asFactionId("faction_defender") };
    const homeRegion: Region = { ...region, adjacency: [neighbor.id] };

    const attackerArmy = makeArmy({
      id: asArmyId("army_attacker"),
      faction: asFactionId("faction_attacker"),
      units: [{ type: "infantry", count: 5000, training: 0.8 }],
      morale: 0.9,
    });
    const defenderArmy = makeArmy({
      id: asArmyId("army_defender"),
      faction: asFactionId("faction_defender"),
      units: [{ type: "infantry", count: 500, training: 0.3 }],
      morale: 0.5,
    });

    const outcome = resolveBattle({
      turn: 1,
      region: homeRegion,
      regionsById: { [homeRegion.id]: homeRegion, [neighbor.id]: neighbor },
      attackerFaction: attackerArmy.faction,
      defenderFaction: defenderArmy.faction,
      attackerArmy,
      defenderArmy,
    });

    expect(outcome.kind).toBe("retreat");
    expect(outcome.newOwner).toBeNull();
    expect(outcome.capturedCommander).toBeNull(); // 退路がある場合は捕虜も発生しない
  });

  it("退路がなく指揮官が同行している場合、敗者の指揮官が捕虜になる（設計書 5.1）", () => {
    const defenderCommander = asCharacterId("char_defender_commander");
    const attackerArmy = makeArmy({
      id: asArmyId("army_attacker"),
      faction: asFactionId("faction_attacker"),
      units: [{ type: "infantry", count: 5000, training: 0.8 }],
      morale: 0.9,
    });
    const defenderArmy = makeArmy({
      id: asArmyId("army_defender"),
      faction: asFactionId("faction_defender"),
      commander: defenderCommander,
      units: [{ type: "infantry", count: 500, training: 0.3 }],
      morale: 0.5,
    });

    const outcome = resolveBattle({
      turn: 1,
      region, // adjacency: [] なので退路なし
      regionsById: { [region.id]: region },
      attackerFaction: attackerArmy.faction,
      defenderFaction: defenderArmy.faction,
      attackerArmy,
      defenderArmy,
    });

    expect(outcome.kind).toBe("occupation");
    expect(outcome.capturedCommander).toBe(defenderCommander);
  });
});
