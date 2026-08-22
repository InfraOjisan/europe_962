import { describe, expect, it } from "vitest";
import { asArmyId, asFactionId, asRegionId } from "../models/ids.js";
import type { Army } from "../models/army.js";
import type { Region } from "../models/region.js";
import { resolveBattle, type BattleResolutionInput } from "./combatEngine.js";
import { CausalityGuardRegistry, forceOutcomeGuard } from "./causalityGuard.js";

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
  adjacency: [],
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

describe("CausalityGuardRegistry", () => {
  const attackerArmy = makeArmy({
    id: asArmyId("army_attacker"),
    faction: asFactionId("faction_attacker"),
    units: [{ type: "infantry", count: 1000, training: 0.5 }],
  });
  const defenderArmy = makeArmy({
    id: asArmyId("army_defender"),
    faction: asFactionId("faction_defender"),
    units: [{ type: "infantry", count: 1000, training: 0.5 }],
  });

  const input: BattleResolutionInput = {
    turn: 7,
    region,
    regionsById: { [region.id]: region },
    attackerFaction: attackerArmy.faction,
    defenderFaction: defenderArmy.faction,
    attackerArmy,
    defenderArmy,
  };

  it("ガード未登録なら結果は変わらない", () => {
    const registry = new CausalityGuardRegistry();
    const outcome = resolveBattle(input);
    const guarded = registry.apply(outcome, { turn: 7, scenarioTag: "some_battle" }, input);
    expect(guarded).toEqual(outcome);
    expect(registry.getLog()).toHaveLength(0);
  });

  it("scenarioTag と turn が一致するガードのみ発火し、結果とログを書き換える", () => {
    // 演算の自然な結果を先に求め、それとは異なる結果を強制することでガードの効果を確認する。
    const naturalOutcome = resolveBattle(input);
    const forcedKind = naturalOutcome.kind === "retreat" ? "occupation" : "retreat";

    const registry = new CausalityGuardRegistry();
    registry.register("scripted_upset", forceOutcomeGuard("crecy_1346", 7, forcedKind));

    const unrelated = registry.apply(naturalOutcome, { turn: 7, scenarioTag: "other_battle" }, input);
    expect(unrelated.kind).toBe(naturalOutcome.kind); // タグ不一致なので発火しない

    const guarded = registry.apply(naturalOutcome, { turn: 7, scenarioTag: "crecy_1346" }, input);
    expect(guarded.kind).toBe(forcedKind);
    expect(guarded.attackerCasualties).toEqual(naturalOutcome.attackerCasualties); // 死傷者数は保持される

    const log = registry.getLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ ruleId: "scripted_upset", before: naturalOutcome.kind, after: forcedKind });
  });
});
