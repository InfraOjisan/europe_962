import type { GameState, Region, RegionId } from "../models/index.js";
import type { OffMapThreatDefinition } from "../data/offMapThreats.js";
import { OFF_MAP_THREATS } from "../data/offMapThreats.js";
import type { RandomSource } from "./aiPolicy.js";
import { defaultRandomSource } from "./aiPolicy.js";

/**
 * ⚠️ 版図外勢力エンジン（草案）
 * ============================================================
 * 設計書 13章。モンゴル・ティムール・オスマン＝ペルシャを操作可能勢力として実装する
 * 代わりに、`Region.frontier` な州にのみ襲来する天災的イベントとして扱う
 * （`data/historicalEvents.ts` の黒死病等と同様、年始フェイズで判定する）。
 *
 * 対象年代に該当する脅威ごとに年あたり確率で襲来を抽選し、成立した場合は現在の
 * 辺境州すべてに被害（人口・税基盤・駐留兵の減少）を与える。辺境州が1つも存在しない
 * シナリオ（`Region.frontier` が誰にも立っていない）では、抽選には当たっても実害なく
 * 安全に無視される（`historicalEvents.ts` の「対象が存在しないイベント」と同じ設計）。
 */

export interface TriggeredOffMapThreat {
  readonly threat: OffMapThreatDefinition;
  readonly affectedRegions: readonly RegionId[];
}

/** 被害を1州に適用する。severity が大きいほど人口・税基盤・駐留兵の残存率が下がる。 */
function devastateRegion(region: Region, severity: number): Region {
  const populationFactor = Math.max(0.4, 1 - 0.15 * severity);
  const garrisonFactor = Math.max(0.25, 1 - 0.25 * severity);
  return {
    ...region,
    population: Math.round(region.population * populationFactor),
    taxBase: Math.round(region.taxBase * populationFactor),
    garrison: { ...region.garrison, count: Math.round(region.garrison.count * garrisonFactor) },
  };
}

/**
 * 年始フェイズから呼ばれる想定のエントリーポイント。その年に該当する脅威を順に抽選し、
 * 成立したものについて辺境州すべてに被害を適用する。
 */
export function rollOffMapThreats(
  state: GameState,
  random: RandomSource = defaultRandomSource,
  threats: readonly OffMapThreatDefinition[] = OFF_MAP_THREATS,
): { readonly state: GameState; readonly triggered: readonly TriggeredOffMapThreat[] } {
  let regions = state.regions;
  const triggered: TriggeredOffMapThreat[] = [];

  for (const threat of threats) {
    if (state.year < threat.startYear || state.year > threat.endYear) continue;
    if (random() >= threat.annualProbability) continue;

    const frontierRegions = Object.values(regions).filter((r) => r.frontier);
    const affectedRegions: RegionId[] = [];
    for (const region of frontierRegions) {
      regions = { ...regions, [region.id]: devastateRegion(region, threat.severity) };
      affectedRegions.push(region.id);
    }
    triggered.push({ threat, affectedRegions });
  }

  if (triggered.length === 0) return { state, triggered };
  return { state: { ...state, regions }, triggered };
}
