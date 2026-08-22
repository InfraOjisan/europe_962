import type { Army } from "../models/army.js";
import type { Region } from "../models/region.js";
import type { RegionArchetype } from "../models/regionArchetype.js";
import type { RandomSource } from "./aiPolicy.js";

/**
 * ⚠️ 経済システム（税制・天候・地勢、草案）
 * ============================================================
 * 設計書 10章。地勢アーキタイプごとの政権安定期の基準税率に、天候・戦争・疫病・
 * 包囲による変動を掛け合わせて実効税収を算出する。係数は仮値で、combatEngine
 * 同様に継続チューニングの対象。
 */

/** 地勢アーキタイプごとの政権安定期の基準税率係数（設計書 10.1、仮値）。 */
export const ARCHETYPE_TAX_COEFFICIENT: Readonly<Record<RegionArchetype, number>> = {
  mediterranean: 1.15,
  continental: 1.0,
  nordic: 0.75,
  alpine: 0.7,
  coastal_trade: 1.3,
  steppe_frontier: 0.65,
};

/** 戦争状態にある勢力の州の実効税収に掛かるペナルティ（設計書 10.3、仮値）。 */
export const WAR_TAX_PENALTY = 0.8;
/** 疫病発生中の州の実効税収に掛かる追加ペナルティ（設計書 10.3、仮値）。 */
export const PLAGUE_TAX_PENALTY = 0.5;

/** 天候係数の分布パラメータ（設計書 10.2、仮値）。平均1.0・標準偏差0.12の正規分布。 */
const WEATHER_MEAN = 1.0;
const WEATHER_STDDEV = 0.12;
/** 稀な外れ値も起こりうるが、ゲーム上意味を持たなくなる極端な値はクランプする。 */
const WEATHER_MIN = 0.5;
const WEATHER_MAX = 1.5;

/** 凶作・豊作の表示しきい値（設計書 10.2）。UI（ターンサマリー）での候補判定に使う。 */
export const POOR_HARVEST_THRESHOLD = 0.8;
export const BUMPER_HARVEST_THRESHOLD = 1.2;

/**
 * Box-Muller法による標準正規分布乱数。`RandomSource`（0〜1の一様乱数を返す関数）から
 * 平均・標準偏差を指定した正規分布の値を生成する。
 */
function normalRandom(mean: number, stddev: number, random: RandomSource): number {
  // u1 が 0 だと log(0) = -Infinity になるため、下限を設けて回避する。
  const u1 = Math.max(random(), Number.EPSILON);
  const u2 = random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * stddev;
}

/**
 * 州の今年の天候係数を抽選する（設計書 10.2）。
 * 正規分布なので、まれに大きく外れた値（凶作・豊作）が自然に発生する。
 */
export function rollWeatherFactor(random: RandomSource): number {
  const raw = normalRandom(WEATHER_MEAN, WEATHER_STDDEV, random);
  return Math.max(WEATHER_MIN, Math.min(WEATHER_MAX, raw));
}

export interface RegionEconomyInput {
  readonly region: Region;
  readonly weatherFactor: number;
  readonly atWar: boolean;
  readonly plagueActive: boolean;
}

/** 州の実効税収を算出する（設計書 10.4）。包囲下の州は税収がほぼゼロになる。 */
export function calculateEffectiveTax(input: RegionEconomyInput): number {
  const { region, weatherFactor, atWar, plagueActive } = input;
  if (region.siege !== null) return 0;

  const archetypeCoefficient = ARCHETYPE_TAX_COEFFICIENT[region.archetype];
  const warFactor = atWar ? WAR_TAX_PENALTY : 1.0;
  const plagueFactor = plagueActive ? PLAGUE_TAX_PENALTY : 1.0;

  return region.taxBase * archetypeCoefficient * weatherFactor * warFactor * plagueFactor;
}

/** 州直属の常備兵（駐留戦力）の年間維持費（仮値）。 */
export function garrisonUpkeep(region: Region): number {
  return region.garrison.count * 0.05;
}

/** 軍団の年間維持費（仮値）。兵科を問わず頭数に比例する簡易モデル。 */
export function armyUpkeep(army: Pick<Army, "units">): number {
  return army.units.reduce((sum, u) => sum + u.count, 0) * 0.08;
}

/**
 * 天候係数のUI表示カテゴリ（設計書 7.7）。マップ画面の背景色・アイコンを
 * 天候係数から一意に決めるための分類。`POOR_HARVEST_THRESHOLD`/`BUMPER_HARVEST_THRESHOLD`
 * と同じしきい値を使い、経済側の「凶作/豊作」判定とUI表示を常に一致させる。
 */
export type WeatherVisualCategory = "harsh" | "normal" | "bountiful";

/** 天候係数からUI表示カテゴリを求める。 */
export function weatherVisualCategory(weatherFactor: number): WeatherVisualCategory {
  if (weatherFactor < POOR_HARVEST_THRESHOLD) return "harsh";
  if (weatherFactor > BUMPER_HARVEST_THRESHOLD) return "bountiful";
  return "normal";
}
