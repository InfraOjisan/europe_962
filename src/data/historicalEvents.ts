import type { GameState } from "../models/gameState.js";
import { asFactionId } from "../models/ids.js";
import type { FactionId } from "../models/ids.js";

/**
 * 史実イベント年表（設計書 11章）。
 *
 * 中学校社会科レベルの世界史年表に登場する主要事象を、ゲーム内イベントとして
 * 抽象化して収録する。`apply` は対象年（範囲がある場合は開始年）に年始フェイズで
 * 一度だけ呼ばれる。対象となる勢力・州が現在のシナリオに存在しない場合は
 * 安全に何もしない（`state.factions[id]` 等の存在チェックで no-op にする）。
 *
 * `gamesystem_europe.md` の「大戦（ゲーム理論通りだと敗北する）」という宿命論と
 * 整合するよう、必須イベントではなく任意でON/OFFできるシナリオイベントとして
 * 実装する（`eventEngine.ts` の `events` 引数に空配列を渡せば無効化できる）。
 *
 * 962年開始のサンプルシナリオ（設計書15章：神聖ローマ帝国の選帝侯・諸侯・回廊諸国、
 * ポーランド、ハンガリー、イタリア諸国、イングランド、イベリア3王朝、東ローマ帝国、
 * 自由傭兵団の27勢力）は、この年表がほぼ全てのイベントで実際に効果を持つよう設計した。
 * それでも対象の勢力・州が存在しない、あるいは既に消滅しているイベントは
 * 安全に no-op になる（例：現時点でスコットランド・オスマン帝国は未実装）。
 */

export interface HistoricalEvent {
  readonly id: string;
  /** 発火年（範囲のあるイベントは開始年）。 */
  readonly year: number;
  readonly name: string;
  readonly description: string;
  readonly apply: (state: GameState) => GameState;
}

// --- 小さなヘルパー ---------------------------------------------------------

function downgradeAllianceToPeace(state: GameState, a: FactionId, b: FactionId): GameState {
  const factionA = state.factions[a];
  const factionB = state.factions[b];
  if (!factionA || !factionB) return state;
  if (factionA.diplomacy[b] !== "alliance") return state;
  return {
    ...state,
    factions: {
      ...state.factions,
      [a]: { ...factionA, diplomacy: { ...factionA.diplomacy, [b]: "peace" } },
      [b]: { ...factionB, diplomacy: { ...factionB.diplomacy, [a]: "peace" } },
    },
  };
}

function adjustTreasury(state: GameState, factionId: FactionId, delta: number): GameState {
  const faction = state.factions[factionId];
  if (!faction) return state;
  return {
    ...state,
    factions: { ...state.factions, [factionId]: { ...faction, treasury: Math.max(0, faction.treasury + delta) } },
  };
}

/** 全州の人口・税基盤を一律に減衰させる（黒死病のような汎欧規模のイベント用）。 */
function ravageAllRegions(state: GameState, populationFactor: number, taxBaseFactor: number): GameState {
  const regions = Object.fromEntries(
    Object.entries(state.regions).map(([id, region]) => [
      id,
      {
        ...region,
        population: Math.round(region.population * populationFactor),
        taxBase: Math.round(region.taxBase * taxBaseFactor),
      },
    ]),
  );
  return { ...state, regions };
}

function ravageFactionsRegions(state: GameState, factionIds: readonly FactionId[], populationFactor: number, taxBaseFactor: number): GameState {
  return factionIds.reduce((s, id) => ravageFactionRegions(s, id, populationFactor, taxBaseFactor), state);
}

function adjustTreasuryForFactions(state: GameState, factionIds: readonly FactionId[], delta: number): GameState {
  return factionIds.reduce((s, id) => adjustTreasury(s, id, delta), state);
}

/** 特定の勢力が領有する州だけを減衰させる（局地的な戦乱イベント用）。 */
function ravageFactionRegions(state: GameState, factionId: FactionId, populationFactor: number, taxBaseFactor: number): GameState {
  const faction = state.factions[factionId];
  if (!faction) return state;
  const regions = { ...state.regions };
  for (const regionId of faction.regions) {
    const region = regions[regionId];
    if (!region) continue;
    regions[regionId] = {
      ...region,
      population: Math.round(region.population * populationFactor),
      taxBase: Math.round(region.taxBase * taxBaseFactor),
    };
  }
  return { ...state, regions };
}

/** 2勢力間を戦争状態にする（双方が生存している場合のみ）。 */
function declareWarBetween(state: GameState, a: FactionId, b: FactionId): GameState {
  const factionA = state.factions[a];
  const factionB = state.factions[b];
  if (!factionA || !factionB || !factionA.alive || !factionB.alive) return state;
  return {
    ...state,
    factions: {
      ...state.factions,
      [a]: { ...factionA, diplomacy: { ...factionA.diplomacy, [b]: "war" } },
      [b]: { ...factionB, diplomacy: { ...factionB.diplomacy, [a]: "war" } },
    },
  };
}

/** 生存している lord 型勢力同士を総当たりで戦争状態にする（欧州規模の大戦イベント用）。 */
function declareContinentalWar(state: GameState): GameState {
  const lords = Object.values(state.factions).filter((f) => f.alive && f.type === "lord");
  let factions = state.factions;
  for (const a of lords) {
    let diplomacy = factions[a.id]?.diplomacy ?? {};
    for (const b of lords) {
      if (a.id === b.id) continue;
      diplomacy = { ...diplomacy, [b.id]: "war" };
    }
    factions = { ...factions, [a.id]: { ...factions[a.id]!, diplomacy } };
  }
  return { ...state, factions };
}

// --- 年表 --------------------------------------------------------------------

const HRE = asFactionId("faction_hre");
const WEST_FRANCIA = asFactionId("faction_west_francia");
const PAPAL = asFactionId("faction_papal");
const BYZANTIUM = asFactionId("faction_byzantium");
const ENGLAND = asFactionId("faction_england");
const CASTILE = asFactionId("faction_castile");
const ARAGON = asFactionId("faction_aragon");
const ASTURIAS = asFactionId("faction_asturias");
const AUSTRIA = asFactionId("faction_austria");

/**
 * 神聖ローマ帝国「本体」を構成する勢力群（設計書 15章）：選帝侯7家・バイエルン・
 * シュヴァーベン・オーストリア・スペインの道の回廊4勢力。ポーランド・ハンガリー・
 * イタリア諸国は「緩い同盟圏」ではあるが帝国そのものの構成員ではないため含めない。
 * ドイツ農民戦争・三十年戦争など「帝国全域」を舞台とする史実イベントに使う。
 */
const HRE_CORE_FACTION_IDS: readonly FactionId[] = [
  HRE,
  asFactionId("faction_mainz"),
  asFactionId("faction_trier"),
  asFactionId("faction_cologne"),
  asFactionId("faction_palatinate"),
  asFactionId("faction_brandenburg"),
  asFactionId("faction_bohemia"),
  asFactionId("faction_bavaria"),
  asFactionId("faction_swabia"),
  AUSTRIA,
  asFactionId("faction_franche_comte"),
  asFactionId("faction_lorraine"),
  asFactionId("faction_luxembourg"),
  asFactionId("faction_flanders"),
];

export const HISTORICAL_EVENTS: readonly HistoricalEvent[] = [
  {
    id: "east_west_schism_1054",
    year: 1054,
    name: "東西教会分裂（大シスマ）",
    description: "カトリックと正教会が相互破門し分裂した。教皇領と東ローマ帝国の関係が冷え込む。",
    apply: (state) => downgradeAllianceToPeace(state, PAPAL, BYZANTIUM),
  },
  {
    id: "norman_conquest_1066",
    year: 1066,
    name: "ノルマン・コンクエスト",
    description:
      "ノルマンディー公ウィリアムがイングランドを征服し、新王朝が成立した。旧王統の後継指定が" +
      "リセットされ、征服に伴う混乱で国庫が目減りする。",
    apply: (state) => {
      const england = state.factions[ENGLAND];
      if (!england || !england.alive) return state;
      return {
        ...state,
        factions: { ...state.factions, [ENGLAND]: { ...england, heir: null, treasury: Math.round(england.treasury * 0.6) } },
      };
    },
  },
  {
    id: "investiture_controversy_1077",
    year: 1077,
    name: "カノッサの屈辱（叙任権闘争）",
    description: "皇帝ハインリヒ4世が教皇に赦しを請うた。神聖ローマ皇帝と教皇の緊張関係を反映する。",
    apply: (state) => downgradeAllianceToPeace(state, HRE, PAPAL),
  },
  {
    id: "first_crusade_1096",
    year: 1096,
    name: "第1回十字軍",
    description: "教皇と同盟関係にある諸勢力が聖地遠征に加わり、戦費を消耗する。",
    apply: (state) => {
      const papal = state.factions[PAPAL];
      if (!papal) return state;
      let next = state;
      for (const [otherId, stance] of Object.entries(papal.diplomacy)) {
        if (stance === "alliance") next = adjustTreasury(next, asFactionId(otherId), -300);
      }
      return next;
    },
  },
  {
    id: "magna_carta_1215",
    year: 1215,
    name: "マグナ・カルタ",
    description: "イングランド王の権力に諸侯・教会が制約を課し、王権の恣意的な課税が難しくなった。",
    apply: (state) => adjustTreasury(state, ENGLAND, -400),
  },
  {
    id: "mongol_invasion_1241",
    year: 1241,
    name: "ワールシュタットの戦い（モンゴル襲来）",
    description: "モンゴル軍が東欧に侵攻し、辺境・草原地帯の州に壊滅的な被害を与えた。",
    apply: (state) => {
      const regions = Object.fromEntries(
        Object.entries(state.regions).map(([id, region]) =>
          region.archetype === "steppe_frontier"
            ? [id, { ...region, population: Math.round(region.population * 0.5), garrison: { ...region.garrison, count: Math.round(region.garrison.count * 0.5) } }]
            : [id, region],
        ),
      );
      return { ...state, regions };
    },
  },
  {
    id: "avignon_papacy_1309",
    year: 1309,
    name: "アヴィニョン捕囚",
    description: "教皇庁がアヴィニョンに移転し、教皇領の対外的な影響力が低下した。",
    apply: (state) => adjustTreasury(state, PAPAL, -500),
  },
  {
    id: "hundred_years_war_1337",
    year: 1337,
    name: "百年戦争",
    description: "イングランド王がフランス王位継承権を主張し、英仏間で長期の大戦争が始まった。",
    apply: (state) => declareWarBetween(state, ENGLAND, WEST_FRANCIA),
  },
  {
    id: "black_death_1347",
    year: 1347,
    name: "黒死病（ペスト）",
    description: "欧州全土で人口が激減した。既存の疫病イベントの最大規模版として、全州に及ぶ。",
    apply: (state) => ravageAllRegions(state, 0.6, 0.75),
  },
  {
    id: "joan_of_arc_1429",
    year: 1429,
    name: "ジャンヌ・ダルク登場",
    description: "フランス方面に高練度の指揮官が現れた。（本シナリオでは対応するキャラクター生成は未実装）",
    apply: (state) => state, // TODO: 該当勢力に高スキルの指揮官キャラクターを生成する仕組みと連携する
  },
  {
    id: "fall_of_constantinople_1453",
    year: 1453,
    name: "東ローマ帝国滅亡（コンスタンティノープル陥落）",
    description: "東ローマ帝国の都が陥落し、帝国は事実上崩壊した。",
    apply: (state) => {
      const byzantium = state.factions[BYZANTIUM];
      if (!byzantium || !byzantium.alive) return state;
      const ravaged = ravageFactionRegions(state, BYZANTIUM, 0.4, 0.3);
      return adjustTreasury(ravaged, BYZANTIUM, -ravaged.factions[BYZANTIUM]!.treasury); // 国庫をほぼ喪失
    },
  },
  {
    id: "wars_of_the_roses_1455",
    year: 1455,
    name: "バラ戦争",
    description: "イングランドで王位継承をめぐる内乱が起き、国内が疲弊した。",
    apply: (state) => ravageFactionRegions(state, ENGLAND, 0.85, 0.8),
  },
  {
    id: "reconquista_1492",
    year: 1492,
    name: "レコンキスタ完了／新大陸到達",
    description:
      "イベリア半島の再征服が完了し（版図外勢力＝イスラム政権の圧力もこれ以降やむ）、" +
      "新大陸への航路が開かれてカスティーリャ・アラゴンに新たな富がもたらされた。",
    apply: (state) => {
      let next = adjustTreasury(state, CASTILE, 800);
      next = adjustTreasury(next, ARAGON, 400);
      next = adjustTreasury(next, ASTURIAS, 200);
      return next;
    },
  },
  {
    id: "reformation_1517",
    year: 1517,
    name: "宗教改革（95か条の論題）",
    description: "教皇領の権威に対する異議申し立てが広がり、旧教勢力の結束が緩んだ。",
    apply: (state) => {
      const papal = state.factions[PAPAL];
      if (!papal) return state;
      const diplomacy = Object.fromEntries(
        Object.entries(papal.diplomacy).map(([id, stance]) => [id, stance === "alliance" ? "peace" : stance]),
      );
      return { ...state, factions: { ...state.factions, [PAPAL]: { ...papal, diplomacy } } };
    },
  },
  {
    id: "german_peasants_war_1524",
    year: 1524,
    name: "ドイツ農民戦争",
    description: "神聖ローマ帝国領内の広範囲で農民反乱が起き、選帝侯・諸侯の諸州が動揺した。",
    apply: (state) => ravageFactionsRegions(state, HRE_CORE_FACTION_IDS, 0.95, 0.9),
  },
  {
    id: "council_of_trent_1545",
    year: 1545,
    name: "トリエント公会議（対抗宗教改革）",
    description: "教皇領を中心に旧教勢力の結束が強化された。",
    apply: (state) => adjustTreasury(state, PAPAL, 300),
  },
  {
    id: "huguenot_wars_1562",
    year: 1562,
    name: "ユグノー戦争",
    description: "西フランク王国方面で宗教内乱が起きた。",
    apply: (state) => ravageFactionRegions(state, WEST_FRANCIA, 0.9, 0.85),
  },
  {
    id: "thirty_years_war_1618",
    year: 1618,
    name: "三十年戦争",
    description: "神聖ローマ帝国全域（選帝侯・諸侯・オーストリア・回廊諸国）を巻き込む大規模戦争が始まった。",
    apply: (state) => ravageFactionsRegions(state, HRE_CORE_FACTION_IDS, 0.75, 0.7),
  },
  {
    id: "peace_of_westphalia_1648",
    year: 1648,
    name: "ウェストファリア条約",
    description: "三十年戦争が終結し、神聖ローマ帝国の諸侯はある程度の復興を見せた。",
    apply: (state) => adjustTreasuryForFactions(state, HRE_CORE_FACTION_IDS, 250),
  },
  {
    id: "siege_of_vienna_1683",
    year: 1683,
    name: "第2次ウィーン包囲",
    description:
      "オスマン帝国の大軍がウィーンを包囲した（版図外勢力の天災的圧力とは別に、確実に発生する" +
      "史実の一大事件としてオーストリアに直接被害を与える）。",
    apply: (state) => ravageFactionRegions(state, AUSTRIA, 0.85, 0.8),
  },
  {
    id: "war_of_spanish_succession_1701",
    year: 1701,
    name: "スペイン継承戦争",
    description:
      "王朝の断絶に起因する国際戦争が起きた。本シナリオではカスティーリャ・アラゴンが" +
      "「スペイン」を代表する勢力として、この戦争の経済的な消耗を負う（継承システム(4章)とも" +
      "連動しうる：この時点で両家が同君連合／内乱状態にあれば、その帰結が優先される）。",
    apply: (state) => {
      let next = ravageFactionRegions(state, CASTILE, 0.85, 0.8);
      next = ravageFactionRegions(next, ARAGON, 0.9, 0.85);
      return next;
    },
  },
  {
    id: "french_revolution_1789",
    year: 1789,
    name: "フランス革命",
    description: "西フランク王国方面で君主制への内乱が起き、王権が大きく揺らいだ。",
    apply: (state) => {
      const westFrancia = state.factions[WEST_FRANCIA];
      if (!westFrancia || !westFrancia.alive) return state;
      return {
        ...state,
        factions: { ...state.factions, [WEST_FRANCIA]: { ...westFrancia, heir: null, treasury: Math.round(westFrancia.treasury * 0.3) } },
      };
    },
  },
  {
    id: "napoleonic_wars_1799",
    year: 1799,
    name: "ナポレオン戦争",
    description: "欧州規模の大戦争が起きた。生存する全ての領主家が互いに戦争状態に入る（大戦判定と直結しうる）。",
    apply: (state) => declareContinentalWar(state),
  },
];
