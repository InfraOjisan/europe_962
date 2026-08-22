/**
 * 州の地勢アーキタイプ（設計書 10章「経済システム」）。
 * 歴史上の地域区分に基づく大まかな分類で、政権安定期の基準税率を決める。
 *
 * - mediterranean:   南欧。地中海式農業・交易路の要衝で税収が厚い。
 * - continental:      大陸欧州。穀倉地帯で税率は中庸、安定している。
 * - nordic:            北欧。人口希薄・農業生産が低く税率は低め。
 * - alpine:             山岳地域。税収は薄いが傭兵の供給地として別の収入源を持つ。
 * - coastal_trade:       沿岸交易都市圏（低地諸国・ハンザ都市等）。税収は最も厚いが変動も大きい。
 * - steppe_frontier:      辺境・草原地帯。税収が薄く治安維持コストが相対的に高い。
 */
export type RegionArchetype =
  | "mediterranean"
  | "continental"
  | "nordic"
  | "alpine"
  | "coastal_trade"
  | "steppe_frontier";

export const ALL_REGION_ARCHETYPES: readonly RegionArchetype[] = [
  "mediterranean",
  "continental",
  "nordic",
  "alpine",
  "coastal_trade",
  "steppe_frontier",
];
