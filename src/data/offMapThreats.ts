/**
 * 版図外勢力（設計書 13章）。モンゴル・ティムール・オスマン＝ペルシャ（イスラム勢）を
 * 独立した操作可能勢力としては実装せず、「辺境州（`Region.frontier`）に周期的に
 * 襲来する天災的イベント」として抽象化する（ユーザー要望：ほぼ疫病と同様の扱い）。
 *
 * 理由（ユーザー要望より）：
 * - 史実上どの勢力よりも軍事的に強大で、通常の勢力バランスに組み込むとゲームが成立しない。
 * - 遊牧民的な非定住性・イスラム世界という別の政治的連続性を持ち、ヨーロッパ諸勢力と
 *   同じ「Faction」概念（婚姻・継承・内政等）で表現すると史実の質感を損なう。
 *
 * よってここでは Faction ではなく、年代範囲と年あたり発生確率を持つ「脅威定義」として
 * データ化し、`engine/offMapThreats.ts` が年始フェイズで辺境州にのみ被害を与える。
 */

export interface OffMapThreatDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** この脅威が活動しうる西暦年の範囲（両端含む）。 */
  readonly startYear: number;
  readonly endYear: number;
  /** 範囲内の年で実際に襲来が発生する年あたりの確率（0〜1）。 */
  readonly annualProbability: number;
  /**
   * 被害の深刻度。黒死病級の甚大な被害を 2.0 前後、局地的な略奪を 0.5 前後の目安とする
   * （`offMapThreats.ts` の `devastateRegion` が人口・税基盤・駐留兵への倍率に変換する）。
   */
  readonly severity: number;
}

export const OFF_MAP_THREATS: readonly OffMapThreatDefinition[] = [
  {
    id: "magyar_raids",
    name: "マジャール人の侵入",
    description:
      "955年のレヒフェルトの戦いでオットー1世に大敗し弱体化しつつも、962年開始時点ではなお" +
      "散発的な略奪遠征の余波が残っている時期として扱う。",
    startYear: 962,
    endYear: 972,
    annualProbability: 0.1,
    severity: 0.5,
  },
  {
    id: "mongol_invasion_of_europe",
    name: "モンゴルのヨーロッパ侵攻",
    description:
      "バトゥ率いるモンゴル軍によるルーシ諸公国・ポーランド・ハンガリーへの侵攻" +
      "（ワールシュタットの戦い・モヒの戦い、1241年）。この時代最大級の破壊をもたらす。",
    startYear: 1236,
    endYear: 1242,
    annualProbability: 0.55,
    severity: 2.2,
  },
  {
    id: "timurid_invasions",
    name: "ティムールの遠征",
    description:
      "ティムール朝による中央アジア〜西アジアへの遠征。アンカラの戦い（1402年）でオスマンを" +
      "撃破し、間接的に東欧・地中海情勢を揺るがした。",
    startYear: 1380,
    endYear: 1405,
    annualProbability: 0.12,
    severity: 1.4,
  },
  {
    id: "ottoman_balkan_pressure",
    name: "オスマン帝国のバルカン圧力",
    description:
      "コソヴォの戦い（1389年）・ニコポリスの戦い（1396年）等を経てバルカン半島へ継続的に" +
      "及んだオスマンの軍事的圧力。",
    startYear: 1350,
    endYear: 1453,
    annualProbability: 0.15,
    severity: 1.3,
  },
  {
    id: "ottoman_central_europe_pressure",
    name: "オスマン帝国の中欧遠征",
    description:
      "コンスタンティノープル陥落（1453年）以降、モハーチの戦い（1526年）・第一次/第二次" +
      "ウィーン包囲（1529年・1683年）に至る中欧方面への継続的な遠征。",
    startYear: 1453,
    endYear: 1683,
    annualProbability: 0.13,
    severity: 1.5,
  },
  {
    id: "safavid_ottoman_frontier_wars",
    name: "オスマン＝サファヴィー（ペルシャ）国境戦争",
    description:
      "オスマン帝国とサファヴィー朝ペルシャの間の断続的な国境戦争。直接ヨーロッパを侵すもの" +
      "ではないが、東方国境の混乱として辺境州に波及することがある。",
    startYear: 1514,
    endYear: 1639,
    annualProbability: 0.08,
    severity: 0.8,
  },
  {
    id: "andalusi_frontier_raids",
    name: "アンダルス（イスラム政権）による国境紛争",
    description:
      "後ウマイヤ朝・その崩壊後のタイファ諸国、のちのムラービト朝・ムワッヒド朝による、" +
      "イベリア半島のキリスト教諸国（カスティーリャ・アラゴン等）国境への圧力・略奪遠征。" +
      "レコンキスタの相手方をモンゴル・オスマンと同様に版図外勢力として扱う（設計書14章）。" +
      "レコンキスタ完了（1492年）をもって終了する。",
    startYear: 962,
    endYear: 1492,
    annualProbability: 0.1,
    severity: 1.0,
  },
];
