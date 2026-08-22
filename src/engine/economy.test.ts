import { describe, expect, it } from "vitest";
import { asArmyId, asFactionId, asRegionId } from "../models/ids.js";
import type { Region } from "../models/region.js";
import {
  armyUpkeep,
  calculateEffectiveTax,
  garrisonUpkeep,
  rollWeatherFactor,
  WAR_TAX_PENALTY,
  PLAGUE_TAX_PENALTY,
} from "./economy.js";

function makeRegion(over: Partial<Region>): Region {
  return {
    id: asRegionId("r"),
    name: "州",
    owner: asFactionId("f"),
    terrain: "plain",
    terrainModifier: { attack: 1.0, defense: 1.0 },
    population: 10_000,
    taxBase: 1000,
    archetype: "continental",
    garrison: { count: 0, training: 0 },
    adjacency: [],
    fortified: false,
    siege: null,
    ...over,
  };
}

describe("rollWeatherFactor", () => {
  it("同じ乱数列からは同じ天候係数が決定的に得られる", () => {
    const random = () => 0.5;
    expect(rollWeatherFactor(random)).toBeCloseTo(0.8587, 3);
  });

  it("極端な乱数でも [0.5, 1.5] の範囲にクランプされる", () => {
    const extremeLow = () => 0.0001; // u1 が極小 → |z| が非常に大きくなりうる
    const extremeHigh = () => 0.9999;
    expect(rollWeatherFactor(extremeLow)).toBeGreaterThanOrEqual(0.5);
    expect(rollWeatherFactor(extremeLow)).toBeLessThanOrEqual(1.5);
    expect(rollWeatherFactor(extremeHigh)).toBeGreaterThanOrEqual(0.5);
    expect(rollWeatherFactor(extremeHigh)).toBeLessThanOrEqual(1.5);
  });

  it("多数回抽選すると平均はおよそ1.0に収束する（正規分布の健全性確認）", () => {
    let seed = 42;
    const mulberry32 = () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const samples = Array.from({ length: 2000 }, () => rollWeatherFactor(mulberry32));
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(mean).toBeGreaterThan(0.95);
    expect(mean).toBeLessThan(1.05);
  });
});

describe("calculateEffectiveTax", () => {
  it("平時・平年（weatherFactor=1.0）は taxBase × アーキタイプ係数に一致する", () => {
    const region = makeRegion({ taxBase: 1000, archetype: "continental" });
    expect(calculateEffectiveTax({ region, weatherFactor: 1.0, atWar: false, plagueActive: false })).toBeCloseTo(1000, 5);
  });

  it("地勢アーキタイプごとに税率係数が異なる", () => {
    const med = makeRegion({ taxBase: 1000, archetype: "mediterranean" });
    const nordic = makeRegion({ taxBase: 1000, archetype: "nordic" });
    const medTax = calculateEffectiveTax({ region: med, weatherFactor: 1.0, atWar: false, plagueActive: false });
    const nordicTax = calculateEffectiveTax({ region: nordic, weatherFactor: 1.0, atWar: false, plagueActive: false });
    expect(medTax).toBeGreaterThan(nordicTax);
  });

  it("戦争状態・疫病はそれぞれ独立にペナルティが掛かり、重なると相乗する", () => {
    const region = makeRegion({ taxBase: 1000, archetype: "continental" });
    const warOnly = calculateEffectiveTax({ region, weatherFactor: 1.0, atWar: true, plagueActive: false });
    const plagueOnly = calculateEffectiveTax({ region, weatherFactor: 1.0, atWar: false, plagueActive: true });
    const both = calculateEffectiveTax({ region, weatherFactor: 1.0, atWar: true, plagueActive: true });
    expect(warOnly).toBeCloseTo(1000 * WAR_TAX_PENALTY, 5);
    expect(plagueOnly).toBeCloseTo(1000 * PLAGUE_TAX_PENALTY, 5);
    expect(both).toBeCloseTo(1000 * WAR_TAX_PENALTY * PLAGUE_TAX_PENALTY, 5);
  });

  it("包囲下の州は他の条件によらず実効税収が0になる", () => {
    const region = makeRegion({
      taxBase: 1000,
      siege: { attacker: asFactionId("enemy"), attackerArmy: asArmyId("army_x"), startTurn: 1, supplyState: 1 },
    });
    expect(calculateEffectiveTax({ region, weatherFactor: 1.5, atWar: false, plagueActive: false })).toBe(0);
  });
});

describe("維持費", () => {
  it("garrisonUpkeep は駐留戦力に比例する", () => {
    expect(garrisonUpkeep(makeRegion({ garrison: { count: 1000, training: 0.5 } }))).toBeCloseTo(50, 5);
  });

  it("armyUpkeep は兵科を問わず総兵数に比例する", () => {
    const upkeep = armyUpkeep({ units: [{ type: "infantry", count: 1000, training: 0.5 }, { type: "cavalry", count: 500, training: 0.6 }] });
    expect(upkeep).toBeCloseTo(1500 * 0.08, 5);
  });
});
