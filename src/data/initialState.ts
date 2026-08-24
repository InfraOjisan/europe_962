import { asArmyId, asCharacterId, asFactionId, asRegionId } from "../models/ids.js";
import type { Army } from "../models/army.js";
import type { Character } from "../models/character.js";
import type { DiplomacyTable, DiplomaticStance, Faction } from "../models/faction.js";
import type { FactionId } from "../models/ids.js";
import type { GameState } from "../models/gameState.js";
import type { Region, TerrainModifier, TerrainType } from "../models/region.js";
import type { RegionArchetype } from "../models/regionArchetype.js";
import type { Policy } from "../models/policy.js";

/**
 * 962年（神聖ローマ帝国成立）開始時点のサンプル初期データ。
 *
 * ユーザー要望（「勢力・地域が少なく変化に乏しい」）を受け、神聖ローマ帝国を選帝侯・
 * 諸侯レベルまで独立した勢力に分割し、ポーランド・ハンガリー・イタリア諸国・
 * イベリア半島（レコンキスタ側）・イングランドを追加した拡張データセット（27州・27勢力）。
 * データモデルを実際に組み立てて動かせることを示す設計目的であり、史実の完全な
 * 再現・網羅を意図したものではない（架空の記録の乏しい人物名を含む）。
 *
 * 設計方針（詳細は docs/gamesystem_design.md 15章）：
 * - 神聖ローマ帝国は「選帝侯7家（マインツ・トリーア・ケルン・プファルツ・ザクセン・
 *   ブランデンブルク・ボヘミア）＋バイエルン・シュヴァーベン・オーストリア＋
 *   スペインの道の回廊（フランシュ＝コンテ・ロレーヌ・ルクセンブルク・フランドル）」の
 *   14勢力に分割し、ポーランド・ハンガリー・イタリア諸国（ミラノ・ヴェネツィア・ナポリ・
 *   教皇領）と合わせて「緩い同盟圏」を構成する。
 * - イベリア半島はレコンキスタ側の3王朝（アストゥリアス＝レオン・カスティーリャ・
 *   アラゴン）のみを実装し、イスラム政権（後ウマイヤ朝〜）は版図外勢力の天災的イベント
 *   として扱う（`data/offMapThreats.ts` に追加）。
 * - イングランドは「大陸から見れば版図外」という案もあったが、モンゴル・オスマン等と
 *   異なり通常のヨーロッパ王国であり継続的に大陸政治（百年戦争・薔薇戦争等）と
 *   直結するため、版図外扱いにはせず、フランドル／西フランクに海路で隣接する
 *   通常の1勢力として実装する（諸島の内部構成（スコットランド等）までは今回は扱わない）。
 * - 「スペインの道」（ミラノ→シュヴァーベン→フランシュ＝コンテ→ロレーヌ→
 *   ルクセンブルク→フランドル）は、フランス領を経由しない隣接チェーンとして
 *   そのまま地図上に再現できる。
 *
 * 系譜（parents/children/adoptedChildren/adoptedBy）はゲーム開始時点では
 * 誰も子女を持たないため空にしている（設計書 4章の継承・養子縁組システムは
 * ゲーム開始後のプレイで実際に使われる想定）。
 */

// --- 共通ヘルパー ------------------------------------------------------------

/** 系譜情報が不明・未設定の人物向けの既定値。 */
const NO_LINEAGE = { parents: [] as const, adoptedChildren: [] as const, adoptedBy: null } as const;

interface RegionInput {
  readonly id: string;
  readonly name: string;
  readonly owner: string;
  readonly terrain: TerrainType;
  readonly terrainModifier: TerrainModifier;
  readonly population: number;
  readonly taxBase: number;
  readonly archetype: RegionArchetype;
  readonly garrisonCount: number;
  readonly garrisonTraining: number;
  readonly adjacency: readonly string[];
  readonly fortified?: boolean;
  readonly frontier?: boolean;
}

function mkRegion(input: RegionInput): Region {
  return {
    id: asRegionId(input.id),
    name: input.name,
    owner: asFactionId(input.owner),
    terrain: input.terrain,
    terrainModifier: input.terrainModifier,
    population: input.population,
    taxBase: input.taxBase,
    archetype: input.archetype,
    garrison: { count: input.garrisonCount, training: input.garrisonTraining },
    adjacency: input.adjacency.map(asRegionId),
    fortified: input.fortified ?? false,
    siege: null,
    frontier: input.frontier ?? false,
  };
}

interface RulerInput {
  readonly id: string;
  readonly name: string;
  readonly faction: string;
  readonly age: number;
  readonly policy: Policy;
  readonly rationale: string; // ドキュメント目的のみ（コード上は未使用、コメント代わり）
  readonly command?: number;
  readonly diplomacySkill?: number;
  readonly administration?: number;
}

function mkRuler(input: RulerInput): Character {
  void input.rationale; // 根拠はデータ定義側のコメントに残す
  return {
    id: asCharacterId(input.id),
    name: input.name,
    role: "ruler",
    faction: asFactionId(input.faction),
    skills: {
      command: input.command ?? 0.4,
      diplomacy: input.diplomacySkill ?? 0.4,
      administration: input.administration ?? 0.4,
    },
    traits: [],
    age: input.age,
    alive: true,
    policy: input.policy,
    spouse: null,
    children: [],
    ...NO_LINEAGE,
  };
}

interface FactionInput {
  readonly id: string;
  readonly name: string;
  readonly ruler: string;
  readonly regions: readonly string[];
  readonly treasury: number;
  readonly warlords?: readonly string[];
}

function mkFaction(input: FactionInput): Omit<Faction, "diplomacy"> {
  return {
    id: asFactionId(input.id),
    name: input.name,
    type: "lord",
    ruler: asCharacterId(input.ruler),
    consort: null,
    children: [],
    heir: null,
    chancellors: [],
    warlords: (input.warlords ?? []).map(asCharacterId),
    regions: input.regions.map(asRegionId),
    treasury: input.treasury,
    suzerain: null,
    alive: true,
  };
}

interface ArmyInput {
  readonly id: string;
  readonly faction: string;
  readonly commander: string | null;
  readonly location: string;
  readonly units: Army["units"];
  readonly morale: number;
  readonly supply?: number;
}

function mkArmy(input: ArmyInput): Army {
  return {
    id: asArmyId(input.id),
    faction: asFactionId(input.faction),
    commander: input.commander ? asCharacterId(input.commander) : null,
    location: asRegionId(input.location),
    units: input.units,
    doctrine: "default",
    morale: input.morale,
    supply: input.supply ?? 0.9,
  };
}

// --- 州 ----------------------------------------------------------------------
// 座標系は UI（server/public）側で別途保持する（デザイン都合で分離）。ここでは
// ゲームロジック上の隣接関係・地勢のみを定義する。

const PLAIN: TerrainModifier = { attack: 1.0, defense: 1.0 };
const HILL: TerrainModifier = { attack: 0.95, defense: 1.1 };
const MOUNTAIN: TerrainModifier = { attack: 0.85, defense: 1.25 };
const FOREST: TerrainModifier = { attack: 0.9, defense: 1.15 };
const COAST: TerrainModifier = { attack: 1.0, defense: 1.05 };
const OPEN_PLAIN: TerrainModifier = { attack: 1.05, defense: 0.95 }; // 草原・平原（騎兵有利、防御不利）

const regionInputs: readonly RegionInput[] = [
  // --- 神聖ローマ帝国：選帝侯 -------------------------------------------------
  {
    id: "region_saxony",
    name: "ザクセン（選帝侯）",
    owner: "faction_hre",
    terrain: "plain",
    terrainModifier: PLAIN,
    population: 300_000,
    taxBase: 900,
    archetype: "continental",
    garrisonCount: 2000,
    garrisonTraining: 0.6,
    adjacency: ["region_bavaria", "region_francia", "region_brandenburg", "region_bohemia", "region_mainz"],
  },
  {
    id: "region_mainz",
    name: "マインツ（選帝侯）",
    owner: "faction_mainz",
    terrain: "plain",
    terrainModifier: PLAIN,
    population: 140_000,
    taxBase: 520,
    archetype: "continental",
    garrisonCount: 1100,
    garrisonTraining: 0.55,
    adjacency: ["region_cologne", "region_trier", "region_palatinate", "region_saxony"],
  },
  {
    id: "region_trier",
    name: "トリーア（選帝侯）",
    owner: "faction_trier",
    terrain: "hill",
    terrainModifier: HILL,
    population: 110_000,
    taxBase: 420,
    archetype: "continental",
    garrisonCount: 900,
    garrisonTraining: 0.5,
    adjacency: ["region_mainz", "region_cologne", "region_luxembourg", "region_lorraine"],
  },
  {
    id: "region_cologne",
    name: "ケルン（選帝侯）",
    owner: "faction_cologne",
    terrain: "plain",
    terrainModifier: PLAIN,
    population: 150_000,
    taxBase: 560,
    archetype: "coastal_trade",
    garrisonCount: 1150,
    garrisonTraining: 0.55,
    adjacency: ["region_mainz", "region_trier", "region_flanders"],
  },
  {
    id: "region_palatinate",
    name: "プファルツ（選帝侯）",
    owner: "faction_palatinate",
    terrain: "hill",
    terrainModifier: HILL,
    population: 120_000,
    taxBase: 460,
    archetype: "continental",
    garrisonCount: 950,
    garrisonTraining: 0.55,
    adjacency: ["region_mainz", "region_swabia", "region_lorraine"],
  },
  {
    id: "region_brandenburg",
    name: "ブランデンブルク（選帝侯）",
    owner: "faction_brandenburg",
    terrain: "plain",
    terrainModifier: OPEN_PLAIN,
    population: 130_000,
    taxBase: 430,
    archetype: "continental",
    garrisonCount: 1000,
    garrisonTraining: 0.5,
    adjacency: ["region_saxony", "region_poland", "region_bohemia"],
  },
  {
    id: "region_bohemia",
    name: "ボヘミア王国（選帝侯）",
    owner: "faction_bohemia",
    terrain: "hill",
    terrainModifier: HILL,
    population: 190_000,
    taxBase: 620,
    archetype: "continental",
    garrisonCount: 1400,
    garrisonTraining: 0.55,
    fortified: true, // 山に囲まれた盆地地形（史実でも防御に有利とされる）
    adjacency: ["region_saxony", "region_bavaria", "region_brandenburg", "region_austria", "region_poland", "region_hungary"],
  },
  // --- 神聖ローマ帝国：非選帝侯の有力諸侯 --------------------------------------
  {
    id: "region_bavaria",
    name: "バイエルン公国",
    owner: "faction_bavaria",
    terrain: "hill",
    terrainModifier: HILL,
    population: 250_000,
    taxBase: 750,
    archetype: "continental",
    garrisonCount: 1800,
    garrisonTraining: 0.6,
    adjacency: ["region_saxony", "region_swabia", "region_austria", "region_bohemia"],
  },
  {
    id: "region_swabia",
    name: "シュヴァーベン公国",
    owner: "faction_swabia",
    terrain: "hill",
    terrainModifier: HILL,
    population: 220_000,
    taxBase: 700,
    archetype: "alpine",
    garrisonCount: 1500,
    garrisonTraining: 0.55,
    fortified: true,
    adjacency: ["region_bavaria", "region_burgundy", "region_palatinate", "region_franche_comte", "region_milan"],
  },
  {
    id: "region_austria",
    name: "オーストリア辺境伯領",
    owner: "faction_austria",
    terrain: "mountain",
    terrainModifier: MOUNTAIN,
    population: 160_000,
    taxBase: 540,
    archetype: "alpine",
    garrisonCount: 1200,
    garrisonTraining: 0.5,
    adjacency: ["region_bavaria", "region_bohemia", "region_hungary"],
  },
  // --- スペインの道の回廊 ------------------------------------------------------
  {
    id: "region_franche_comte",
    name: "フランシュ＝コンテ（ブルゴーニュ伯領）",
    owner: "faction_franche_comte",
    terrain: "hill",
    terrainModifier: HILL,
    population: 90_000,
    taxBase: 340,
    archetype: "continental",
    garrisonCount: 700,
    garrisonTraining: 0.5,
    adjacency: ["region_burgundy", "region_swabia", "region_lorraine"],
  },
  {
    id: "region_lorraine",
    name: "ロレーヌ公国",
    owner: "faction_lorraine",
    terrain: "plain",
    terrainModifier: PLAIN,
    population: 100_000,
    taxBase: 380,
    archetype: "continental",
    garrisonCount: 800,
    garrisonTraining: 0.5,
    adjacency: ["region_trier", "region_palatinate", "region_franche_comte", "region_luxembourg"],
  },
  {
    id: "region_luxembourg",
    name: "ルクセンブルク伯領",
    owner: "faction_luxembourg",
    terrain: "forest",
    terrainModifier: FOREST,
    population: 60_000,
    taxBase: 260,
    archetype: "continental",
    garrisonCount: 500,
    garrisonTraining: 0.45,
    adjacency: ["region_trier", "region_lorraine", "region_flanders"],
  },
  {
    id: "region_flanders",
    name: "フランドル伯領",
    owner: "faction_flanders",
    terrain: "coast",
    terrainModifier: COAST,
    population: 150_000,
    taxBase: 520,
    archetype: "coastal_trade",
    garrisonCount: 1100,
    garrisonTraining: 0.5,
    adjacency: ["region_cologne", "region_luxembourg", "region_england"],
  },
  // --- ポーランド・ハンガリー（モンゴル・オスマン圧力の主戦場） -----------------
  {
    id: "region_poland",
    name: "ポーランド公国",
    owner: "faction_poland",
    terrain: "plain",
    terrainModifier: OPEN_PLAIN,
    population: 260_000,
    taxBase: 620,
    archetype: "steppe_frontier",
    garrisonCount: 1700,
    garrisonTraining: 0.5,
    frontier: true, // モンゴル侵攻（ワールシュタットの戦い）の主要な被災地
    adjacency: ["region_brandenburg", "region_bohemia", "region_hungary"],
  },
  {
    id: "region_hungary",
    name: "ハンガリー大公国",
    owner: "faction_hungary",
    terrain: "plain",
    terrainModifier: OPEN_PLAIN,
    population: 220_000,
    taxBase: 560,
    archetype: "steppe_frontier",
    garrisonCount: 1500,
    garrisonTraining: 0.5,
    frontier: true, // モンゴル侵攻（モヒの戦い）・後年のオスマン圧力の主要な被災地
    adjacency: ["region_austria", "region_bohemia", "region_poland", "region_venice"],
  },
  // --- イタリア半島 -------------------------------------------------------------
  {
    id: "region_milan",
    name: "ミラノ公国",
    owner: "faction_milan",
    terrain: "plain",
    terrainModifier: PLAIN,
    population: 210_000,
    taxBase: 780,
    archetype: "mediterranean",
    garrisonCount: 1600,
    garrisonTraining: 0.55,
    fortified: true,
    adjacency: ["region_swabia", "region_venice", "region_papal_states"],
  },
  {
    id: "region_venice",
    name: "ヴェネツィア共和国",
    owner: "faction_venice",
    terrain: "coast",
    terrainModifier: COAST,
    population: 190_000,
    taxBase: 900,
    archetype: "coastal_trade",
    garrisonCount: 1300,
    garrisonTraining: 0.6,
    adjacency: ["region_milan", "region_papal_states", "region_hungary"],
  },
  {
    id: "region_naples",
    name: "ナポリ王国",
    owner: "faction_naples",
    terrain: "coast",
    terrainModifier: COAST,
    population: 240_000,
    taxBase: 820,
    archetype: "mediterranean",
    garrisonCount: 1700,
    garrisonTraining: 0.5,
    adjacency: ["region_papal_states", "region_aragon"], // 後年のアラゴン＝ナポリ連合を見据えた海路の隣接
  },
  {
    id: "region_papal_states",
    name: "教皇領",
    owner: "faction_papal",
    terrain: "mountain",
    terrainModifier: MOUNTAIN,
    population: 150_000,
    taxBase: 650,
    archetype: "mediterranean",
    garrisonCount: 900,
    garrisonTraining: 0.45,
    fortified: true,
    adjacency: ["region_milan", "region_venice", "region_naples", "region_byzantium"],
  },
  // --- 東ローマ帝国 --------------------------------------------------------------
  {
    id: "region_byzantium",
    name: "東ローマ（アプリア方面）",
    owner: "faction_byzantium",
    terrain: "coast",
    terrainModifier: COAST,
    population: 260_000,
    taxBase: 1000,
    archetype: "mediterranean",
    garrisonCount: 2200,
    garrisonTraining: 0.7,
    frontier: true, // 東方（後年のセルジューク・オスマン）に対する辺境
    adjacency: ["region_papal_states"],
  },
  // --- 西フランク王国（フランス） --------------------------------------------------
  {
    id: "region_francia",
    name: "西フランク（イル＝ド＝フランス）",
    owner: "faction_west_francia",
    terrain: "plain",
    terrainModifier: PLAIN,
    population: 280_000,
    taxBase: 850,
    archetype: "continental",
    garrisonCount: 1900,
    garrisonTraining: 0.55,
    adjacency: ["region_saxony", "region_burgundy", "region_england"],
  },
  {
    id: "region_burgundy",
    name: "ブルゴーニュ公国",
    owner: "faction_west_francia",
    terrain: "plain",
    terrainModifier: PLAIN,
    population: 180_000,
    taxBase: 600,
    archetype: "continental",
    garrisonCount: 1200,
    garrisonTraining: 0.5,
    adjacency: ["region_francia", "region_swabia", "region_franche_comte"],
  },
  // --- イングランド ----------------------------------------------------------------
  {
    id: "region_england",
    name: "イングランド王国",
    owner: "faction_england",
    terrain: "coast",
    terrainModifier: COAST,
    population: 240_000,
    taxBase: 780,
    archetype: "coastal_trade",
    garrisonCount: 1600,
    garrisonTraining: 0.55,
    adjacency: ["region_flanders", "region_francia"], // 海峡越え（抽象化した隣接）
  },
  // --- イベリア半島（レコンキスタ側） -----------------------------------------------
  {
    id: "region_asturias",
    name: "アストゥリアス＝レオン王国",
    owner: "faction_asturias",
    terrain: "mountain",
    terrainModifier: MOUNTAIN,
    population: 110_000,
    taxBase: 380,
    archetype: "coastal_trade",
    garrisonCount: 900,
    garrisonTraining: 0.5,
    fortified: true, // カンタブリア山脈が初期の再征服運動の防波堤になった史実を反映
    adjacency: ["region_castile"],
  },
  {
    id: "region_castile",
    name: "カスティーリャ王国",
    owner: "faction_castile",
    terrain: "plain",
    terrainModifier: OPEN_PLAIN,
    population: 170_000,
    taxBase: 480,
    archetype: "continental",
    garrisonCount: 1200,
    garrisonTraining: 0.5,
    frontier: true, // イスラム政権（版図外勢力扱い）との国境
    adjacency: ["region_asturias", "region_aragon"],
  },
  {
    id: "region_aragon",
    name: "アラゴン王国",
    owner: "faction_aragon",
    terrain: "hill",
    terrainModifier: HILL,
    population: 130_000,
    taxBase: 420,
    archetype: "mediterranean",
    garrisonCount: 1000,
    garrisonTraining: 0.5,
    frontier: true, // イスラム政権（版図外勢力扱い）との国境
    adjacency: ["region_castile", "region_naples"],
  },
];

export const initialRegions: readonly Region[] = regionInputs.map(mkRegion);

// --- 人物 ----------------------------------------------------------------------

const rulerInputs: readonly RulerInput[] = [
  // --- 神聖ローマ帝国：ザクセン（既存キャラクターは下の initialCharacters で別途定義） ---
  {
    id: "char_mainz_wilhelm",
    name: "ヴィルヘルム（マインツ大司教）",
    faction: "faction_mainz",
    age: 34,
    policy: "self_interest",
    rationale: "聖俗両権を握る大司教選帝侯として、自家の権益拡大を志向する既定割り当て",
    command: 0.3,
    diplomacySkill: 0.6,
    administration: 0.55,
  },
  {
    id: "char_trier_heinrich",
    name: "ハインリヒ（トリーア大司教）",
    faction: "faction_trier",
    age: 41,
    policy: "self_preservation",
    rationale: "記録の乏しい人物への既定割り当て",
    command: 0.25,
    diplomacySkill: 0.5,
    administration: 0.5,
  },
  {
    id: "char_cologne_bruno",
    name: "ブルーノ（ケルン大司教）",
    faction: "faction_cologne",
    age: 38,
    policy: "expansionism",
    rationale: "オットー1世の弟でロートリンゲン公も兼ねた実力者ブルーノ1世を範に取った割り当て",
    command: 0.45,
    diplomacySkill: 0.6,
    administration: 0.5,
  },
  {
    id: "char_palatinate_conrad",
    name: "コンラート（プファルツ伯）",
    faction: "faction_palatinate",
    age: 36,
    policy: "self_interest",
    rationale: "記録の乏しい人物への既定割り当て",
    command: 0.4,
    diplomacySkill: 0.4,
    administration: 0.45,
  },
  {
    id: "char_brandenburg_gero",
    name: "ゲロ（ブランデンブルク辺境伯）",
    faction: "faction_brandenburg",
    age: 50,
    policy: "expansionism",
    rationale: "史実：東方辺境（後のブランデンブルク）を武力で切り取った辺境伯ゲロを範に取った割り当て",
    command: 0.6,
    diplomacySkill: 0.3,
    administration: 0.35,
  },
  {
    id: "char_bohemia_boleslav",
    name: "ボレスラフ1世（ボヘミア公）",
    faction: "faction_bohemia",
    age: 45,
    policy: "self_preservation",
    rationale: "史実：兄殺しで即位した苛烈な統治者だが晩年は帝国との共存を選んだボレスラフ1世",
    command: 0.55,
    diplomacySkill: 0.45,
    administration: 0.4,
  },
  {
    id: "char_bavaria_heinrich",
    name: "ハインリヒ1世（バイエルン公）",
    faction: "faction_bavaria",
    age: 40,
    policy: "self_interest",
    rationale: "史実：オットー1世の弟で幾度も反乱を起こした野心家ハインリヒ1世（喧嘩公）",
    command: 0.5,
    diplomacySkill: 0.3,
    administration: 0.4,
  },
  {
    id: "char_swabia_burchard",
    name: "ブルヒャルト3世（シュヴァーベン公）",
    faction: "faction_swabia",
    age: 32,
    policy: "self_preservation",
    rationale: "記録の乏しい人物への既定割り当て",
    command: 0.4,
    diplomacySkill: 0.4,
    administration: 0.4,
  },
  {
    id: "char_austria_leopold",
    name: "レオポルト（オーストリア辺境伯）",
    faction: "faction_austria",
    age: 33,
    policy: "justice",
    rationale: "記録の乏しい人物への既定割り当て",
    command: 0.4,
    diplomacySkill: 0.4,
    administration: 0.45,
  },
  {
    id: "char_franche_comte_otto",
    name: "オット＝ギヨーム（ブルゴーニュ伯）",
    faction: "faction_franche_comte",
    age: 29,
    policy: "self_interest",
    rationale: "記録の乏しい人物への既定割り当て",
    command: 0.35,
    diplomacySkill: 0.35,
    administration: 0.4,
  },
  {
    id: "char_lorraine_frederick",
    name: "フリードリヒ（ロレーヌ公）",
    faction: "faction_lorraine",
    age: 37,
    policy: "self_preservation",
    rationale: "記録の乏しい人物への既定割り当て",
    command: 0.4,
    diplomacySkill: 0.4,
    administration: 0.4,
  },
  {
    id: "char_luxembourg_siegfried",
    name: "ジークフリート（ルクセンブルク伯）",
    faction: "faction_luxembourg",
    age: 31,
    policy: "expansionism",
    rationale: "史実：962年にルクセンブルク城を築き伯家の祖となったジークフリート",
    command: 0.4,
    diplomacySkill: 0.35,
    administration: 0.35,
  },
  {
    id: "char_flanders_arnulf",
    name: "アルヌルフ1世（フランドル伯）",
    faction: "faction_flanders",
    age: 55,
    policy: "self_interest",
    rationale: "史実：交易と婚姻政策でフランドルの基礎を固めた老練な伯アルヌルフ1世",
    command: 0.35,
    diplomacySkill: 0.55,
    administration: 0.5,
  },
  {
    id: "char_poland_mieszko",
    name: "ミェシュコ1世（ポーランド公）",
    faction: "faction_poland",
    age: 32,
    policy: "expansionism",
    rationale: "史実：ポーランド国家の礎を築き、この後まもなくキリスト教に改宗する建国の公ミェシュコ1世",
    command: 0.55,
    diplomacySkill: 0.45,
    administration: 0.4,
  },
  {
    id: "char_hungary_taksony",
    name: "タクショニ（ハンガリー大公）",
    faction: "faction_hungary",
    age: 48,
    policy: "self_preservation",
    rationale: "史実：西欧遠征の失敗を経て国内統治・定住化へ舵を切った大公タクショニ",
    command: 0.45,
    diplomacySkill: 0.35,
    administration: 0.4,
  },
  {
    id: "char_milan_aribert",
    name: "アリベルト（ミラノ大司教）",
    faction: "faction_milan",
    age: 40,
    policy: "self_interest",
    rationale: "記録の乏しい人物への既定割り当て",
    command: 0.4,
    diplomacySkill: 0.5,
    administration: 0.5,
  },
  {
    id: "char_venice_candiano",
    name: "ピエトロ4世カンディアーノ（ヴェネツィア総督）",
    faction: "faction_venice",
    age: 38,
    policy: "self_interest",
    rationale: "史実：強権的な統治で貴族と対立し最期は暴動で殺害された総督P.4世カンディアーノ",
    command: 0.4,
    diplomacySkill: 0.5,
    administration: 0.55,
  },
  {
    id: "char_naples_marinus",
    name: "マリヌス（ナポリ公）",
    faction: "faction_naples",
    age: 44,
    policy: "self_preservation",
    rationale: "記録の乏しい人物への既定割り当て",
    command: 0.4,
    diplomacySkill: 0.4,
    administration: 0.4,
  },
  {
    id: "char_asturias_ordono",
    name: "オルドーニョ3世（アストゥリアス＝レオン王）",
    faction: "faction_asturias",
    age: 35,
    policy: "justice",
    rationale: "記録の乏しい人物への既定割り当て",
    command: 0.4,
    diplomacySkill: 0.4,
    administration: 0.4,
  },
  {
    id: "char_castile_fernan",
    name: "フェルナン・ゴンサレス（カスティーリャ伯）",
    faction: "faction_castile",
    age: 58,
    policy: "expansionism",
    rationale: "史実：レオン王からの事実上の独立を勝ち取り、カスティーリャ建国の父とされるフェルナン・ゴンサレス",
    command: 0.6,
    diplomacySkill: 0.4,
    administration: 0.4,
  },
  {
    id: "char_aragon_garcia",
    name: "ガルシア・サンチェス（アラゴン王）",
    faction: "faction_aragon",
    age: 30,
    policy: "self_preservation",
    rationale: "記録の乏しい人物への既定割り当て",
    command: 0.4,
    diplomacySkill: 0.4,
    administration: 0.4,
  },
  {
    id: "char_england_edgar",
    name: "エドガー（イングランド王）",
    faction: "faction_england",
    age: 18,
    policy: "justice",
    rationale: "史実：「平和王」と呼ばれ内政の安定と教会改革に努めた若きエドガー王",
    command: 0.3,
    diplomacySkill: 0.5,
    administration: 0.55,
  },
];

const charOtto1: Character = {
  id: asCharacterId("char_otto1"),
  name: "オットー1世",
  role: "ruler",
  faction: asFactionId("faction_hre"),
  skills: { command: 0.65, diplomacy: 0.7, administration: 0.6 },
  traits: ["infantry_specialist"],
  age: 50,
  alive: true,
  policy: "expansionism", // 史実: 東方遠征・レヒフェルトの戦い等を通じ帝国を拡大・統合した
  spouse: asCharacterId("char_adelaide"),
  children: [],
  ...NO_LINEAGE,
};

const charAdelaide: Character = {
  id: asCharacterId("char_adelaide"),
  name: "アーデルハイト",
  role: "consort",
  faction: asFactionId("faction_hre"),
  skills: { command: 0.1, diplomacy: 0.6, administration: 0.4 },
  traits: [],
  age: 30,
  alive: true,
  policy: "self_preservation", // 史実の記録が乏しいため既定の1つを割り当て（家名の存続を重視）
  spouse: asCharacterId("char_otto1"),
  children: [],
  ...NO_LINEAGE,
};

const charHermann: Character = {
  id: asCharacterId("char_hermann"),
  name: "ヘルマン（宰相）",
  role: "chancellor",
  faction: asFactionId("faction_hre"),
  skills: { command: 0.2, diplomacy: 0.5, administration: 0.75 },
  traits: ["administrator"],
  age: 45,
  alive: true,
  policy: "self_interest", // 記録の乏しい人物への既定割り当て（財と地位の拡大を志向）
  spouse: null,
  children: [],
  ...NO_LINEAGE,
};

const charBurchard: Character = {
  id: asCharacterId("char_burchard"),
  name: "ブルヒャルト（戦闘隊長）",
  role: "warlord",
  faction: asFactionId("faction_hre"),
  skills: { command: 0.7, diplomacy: 0.2, administration: 0.2 },
  traits: ["infantry_specialist"],
  age: 38,
  alive: true,
  policy: "expansionism", // 戦闘隊長として軍事的拡大を志向する既定割り当て
  spouse: null,
  children: [],
  ...NO_LINEAGE,
};

const charLothair: Character = {
  id: asCharacterId("char_lothair"),
  name: "ロテール",
  role: "ruler",
  faction: asFactionId("faction_west_francia"),
  skills: { command: 0.5, diplomacy: 0.55, administration: 0.5 },
  traits: [],
  age: 22,
  alive: true,
  policy: "self_preservation", // 設定上、若く求心力を欠く宮廷を生き延びさせることを優先する君主
  spouse: null,
  children: [],
  ...NO_LINEAGE,
};

const charGuyDeVermandois: Character = {
  id: asCharacterId("char_guy_vermandois"),
  name: "ギー・ド・ヴェルマンドワ（戦闘隊長）",
  role: "warlord",
  faction: asFactionId("faction_west_francia"),
  skills: { command: 0.6, diplomacy: 0.3, administration: 0.2 },
  traits: ["cavalry_specialist"],
  age: 33,
  alive: true,
  policy: "self_interest", // 記録の乏しい封建領主への既定割り当て（自らの所領・利得を優先）
  spouse: null,
  children: [],
  ...NO_LINEAGE,
};

const charJohn12: Character = {
  id: asCharacterId("char_john12"),
  name: "ヨハネス12世",
  role: "ruler",
  faction: asFactionId("faction_papal"),
  skills: { command: 0.2, diplomacy: 0.65, administration: 0.4 },
  traits: ["diplomat"],
  age: 26,
  alive: true,
  policy: "self_interest", // 史実: 蓄財・縁故人事など私利で悪名高い教皇として知られる
  spouse: null,
  children: [],
  ...NO_LINEAGE,
};

const charNikephoros: Character = {
  id: asCharacterId("char_nikephoros"),
  name: "ニケフォロス2世フォカス",
  role: "ruler",
  faction: asFactionId("faction_byzantium"),
  skills: { command: 0.85, diplomacy: 0.4, administration: 0.5 },
  traits: ["siege_specialist", "infantry_specialist"],
  age: 47,
  alive: true,
  policy: "expansionism", // 史実: 「陸の皇帝」と称された征服将軍としての性格を反映
  spouse: null,
  children: [],
  ...NO_LINEAGE,
};

const charCondottiere: Character = {
  id: asCharacterId("char_condottiere"),
  name: "自由傭兵団長ヴォルフ",
  role: "warlord",
  faction: asFactionId("faction_free_company"),
  skills: { command: 0.6, diplomacy: 0.35, administration: 0.3 },
  traits: ["cavalry_specialist"],
  age: 40,
  alive: true,
  policy: "self_interest", // 傭兵の典型：金銭・報奨を最優先する（gamesystem_europe.md の傭兵観に対応）
  spouse: null,
  children: [],
  ...NO_LINEAGE,
};

export const initialCharacters: readonly Character[] = [
  charOtto1,
  charAdelaide,
  charHermann,
  charBurchard,
  charLothair,
  charGuyDeVermandois,
  charJohn12,
  charNikephoros,
  charCondottiere,
  ...rulerInputs.map(mkRuler),
];

// --- 勢力 ----------------------------------------------------------------------

const factionInputs: readonly FactionInput[] = [
  // ユーザー要望：「神聖ローマ帝国」を特定の家系に固定しないため、勢力名は他の選帝侯家と
  // 同格の「ザクセン選帝侯領」とし、帝位そのものは createInitialGameState の
  // GameState.imperialTitle として独立管理する（設計書 4.4章）。
  { id: "faction_hre", name: "ザクセン選帝侯領", ruler: "char_otto1", regions: ["region_saxony"], treasury: 5000, warlords: ["char_burchard"] },
  { id: "faction_mainz", name: "マインツ選帝侯領", ruler: "char_mainz_wilhelm", regions: ["region_mainz"], treasury: 1800 },
  { id: "faction_trier", name: "トリーア選帝侯領", ruler: "char_trier_heinrich", regions: ["region_trier"], treasury: 1400 },
  { id: "faction_cologne", name: "ケルン選帝侯領", ruler: "char_cologne_bruno", regions: ["region_cologne"], treasury: 1900 },
  { id: "faction_palatinate", name: "プファルツ選帝侯領", ruler: "char_palatinate_conrad", regions: ["region_palatinate"], treasury: 1500 },
  { id: "faction_brandenburg", name: "ブランデンブルク選帝侯領", ruler: "char_brandenburg_gero", regions: ["region_brandenburg"], treasury: 1400 },
  { id: "faction_bohemia", name: "ボヘミア王国", ruler: "char_bohemia_boleslav", regions: ["region_bohemia"], treasury: 2200 },
  { id: "faction_bavaria", name: "バイエルン公国", ruler: "char_bavaria_heinrich", regions: ["region_bavaria"], treasury: 2800 },
  { id: "faction_swabia", name: "シュヴァーベン公国", ruler: "char_swabia_burchard", regions: ["region_swabia"], treasury: 2500 },
  { id: "faction_austria", name: "オーストリア辺境伯領", ruler: "char_austria_leopold", regions: ["region_austria"], treasury: 1700 },
  { id: "faction_franche_comte", name: "フランシュ＝コンテ伯領", ruler: "char_franche_comte_otto", regions: ["region_franche_comte"], treasury: 1000 },
  { id: "faction_lorraine", name: "ロレーヌ公国", ruler: "char_lorraine_frederick", regions: ["region_lorraine"], treasury: 1100 },
  { id: "faction_luxembourg", name: "ルクセンブルク伯領", ruler: "char_luxembourg_siegfried", regions: ["region_luxembourg"], treasury: 700 },
  { id: "faction_flanders", name: "フランドル伯領", ruler: "char_flanders_arnulf", regions: ["region_flanders"], treasury: 2100 },
  { id: "faction_poland", name: "ポーランド公国", ruler: "char_poland_mieszko", regions: ["region_poland"], treasury: 2400 },
  { id: "faction_hungary", name: "ハンガリー大公国", ruler: "char_hungary_taksony", regions: ["region_hungary"], treasury: 2000 },
  { id: "faction_milan", name: "ミラノ公国", ruler: "char_milan_aribert", regions: ["region_milan"], treasury: 2600 },
  { id: "faction_venice", name: "ヴェネツィア共和国", ruler: "char_venice_candiano", regions: ["region_venice"], treasury: 3200 },
  { id: "faction_naples", name: "ナポリ公国", ruler: "char_naples_marinus", regions: ["region_naples"], treasury: 2500 },
  { id: "faction_papal", name: "教皇領", ruler: "char_john12", regions: ["region_papal_states"], treasury: 2000 },
  { id: "faction_byzantium", name: "東ローマ帝国", ruler: "char_nikephoros", regions: ["region_byzantium"], treasury: 8000 },
  { id: "faction_west_francia", name: "西フランク王国", ruler: "char_lothair", regions: ["region_francia", "region_burgundy"], treasury: 3500, warlords: ["char_guy_vermandois"] },
  { id: "faction_england", name: "イングランド王国", ruler: "char_england_edgar", regions: ["region_england"], treasury: 2300 },
  { id: "faction_asturias", name: "アストゥリアス＝レオン王国", ruler: "char_asturias_ordono", regions: ["region_asturias"], treasury: 1300 },
  { id: "faction_castile", name: "カスティーリャ伯領", ruler: "char_castile_fernan", regions: ["region_castile"], treasury: 1600 },
  { id: "faction_aragon", name: "アラゴン王国", ruler: "char_aragon_garcia", regions: ["region_aragon"], treasury: 1400 },
];

/**
 * 「緩い同盟圏」を構成する勢力（設計書 15章）。神聖ローマ帝国の選帝侯・諸侯・
 * オーストリアに、ポーランド・ハンガリー・イタリア諸国（ミラノ・ヴェネツィア・
 * ナポリ・教皇領）を加えたもの。西フランク・イングランド・東ローマ・イベリア
 * 3王国はこの圏の外。
 */
const LOOSE_ALLIANCE_BLOC: ReadonlySet<string> = new Set([
  "faction_hre",
  "faction_mainz",
  "faction_trier",
  "faction_cologne",
  "faction_palatinate",
  "faction_brandenburg",
  "faction_bohemia",
  "faction_bavaria",
  "faction_swabia",
  "faction_austria",
  "faction_franche_comte",
  "faction_lorraine",
  "faction_luxembourg",
  "faction_flanders",
  "faction_poland",
  "faction_hungary",
  "faction_milan",
  "faction_venice",
  "faction_naples",
  "faction_papal",
]);

/**
 * 隣接する州の領有勢力同士の外交関係を自動算出する：両者が「緩い同盟圏」に
 * 属していれば alliance、そうでなければ peace。手作業で全勢力ペアを書き下す
 * 代わりに、地理的な隣接関係から一貫したベースラインを生成する。
 */
function computeAdjacencyDiplomacy(regions: readonly Region[]): Record<string, Record<string, DiplomaticStance>> {
  const table: Record<string, Record<string, DiplomaticStance>> = {};
  const set = (a: FactionId, b: FactionId, stance: DiplomaticStance) => {
    table[a] = { ...(table[a] ?? {}), [b]: stance };
  };

  const byId = new Map(regions.map((r) => [r.id, r]));
  for (const region of regions) {
    for (const neighborId of region.adjacency) {
      const neighbor = byId.get(neighborId);
      if (!neighbor || neighbor.owner === region.owner) continue;
      if (table[region.owner]?.[neighbor.owner]) continue; // 既に算出済み
      const bothInBloc = LOOSE_ALLIANCE_BLOC.has(region.owner) && LOOSE_ALLIANCE_BLOC.has(neighbor.owner);
      const stance: DiplomaticStance = bothInBloc ? "alliance" : "peace";
      set(region.owner, neighbor.owner, stance);
      set(neighbor.owner, region.owner, stance);
    }
  }
  return table;
}

const adjacencyDiplomacy = computeAdjacencyDiplomacy(initialRegions);

/**
 * 地図上は隣接していないが史実上重要な外交関係の手動補正。
 * オットー1世は962年にまさに教皇ヨハネス12世から戴冠されて神聖ローマ皇帝となっており
 * （＝神聖ローマ帝国そのものの建国イベント）、この関係は地理的隣接から自動算出できない
 * （教皇領は地図上ミラノ・ヴェネツィア・ナポリ・東ローマにのみ隣接する）ため、明示的に補う。
 */
const DIPLOMACY_OVERRIDES: readonly (readonly [string, string, DiplomaticStance])[] = [
  ["faction_hre", "faction_papal", "alliance"],
];

function buildDiplomacyTable(factionId: string): DiplomacyTable {
  const table: Record<string, DiplomaticStance> = { ...(adjacencyDiplomacy[factionId] ?? {}) };
  for (const [a, b, stance] of DIPLOMACY_OVERRIDES) {
    if (a === factionId) table[b] = stance;
    if (b === factionId) table[a] = stance;
  }
  return table as unknown as DiplomacyTable;
}

/** 自由傭兵団（傭兵団型勢力）。領地・君主を持たないため mkFaction のテンプレートに乗らない。 */
const factionFreeCompany: Faction = {
  id: asFactionId("faction_free_company"),
  name: "自由傭兵団",
  type: "mercenary",
  ruler: null,
  consort: null,
  children: [],
  heir: null, // 傭兵団は家系を持たないため常に null
  chancellors: [],
  warlords: [asCharacterId("char_condottiere")],
  regions: [],
  treasury: 800,
  diplomacy: {},
  suzerain: null,
  alive: true,
};

export const initialFactions: readonly Faction[] = [
  ...factionInputs.map((input) => {
    const base = mkFaction(input);
    return { ...base, diplomacy: buildDiplomacyTable(input.id) };
  }),
  factionFreeCompany,
];

// --- 軍団 ------------------------------------------------------------------
// 「変化に乏しい」というフィードバックを踏まえ、各領主勢力に本国駐留の野戦軍を
// 1つずつ持たせる（AI行動フェイズが実際に動かせる実体を全勢力に用意するため）。
// 指揮官キャラクターを持つのは主要な数勢力のみとし、残りは commander: null
// （combatEngine.ts の NO_COMMANDER_PENALTY が適用される、仕様どおりの状態）。

function homeArmy(factionId: string, regionId: string, count: number, training: number, morale: number, commander: string | null = null): Army {
  return mkArmy({
    id: `army_${factionId.replace("faction_", "")}_home`,
    faction: factionId,
    commander,
    location: regionId,
    units: [{ type: "infantry", count, training }],
    morale,
  });
}

const armyHreMain = mkArmy({
  id: "army_hre_main",
  faction: "faction_hre",
  commander: "char_burchard",
  location: "region_saxony",
  units: [
    { type: "pike", count: 2500, training: 0.65 },
    { type: "cavalry", count: 600, training: 0.6 },
  ],
  morale: 0.75,
  supply: 0.9,
});

const armyWestFrancia = mkArmy({
  id: "army_west_francia_main",
  faction: "faction_west_francia",
  commander: "char_guy_vermandois",
  location: "region_francia",
  units: [
    { type: "infantry", count: 1800, training: 0.5 },
    { type: "cavalry", count: 700, training: 0.55 },
  ],
  morale: 0.65,
  supply: 0.9,
});

const armyFreeCompany = mkArmy({
  id: "army_free_company",
  faction: "faction_free_company",
  commander: "char_condottiere",
  location: "region_burgundy",
  units: [{ type: "cavalry", count: 900, training: 0.55 }],
  morale: 0.6,
  supply: 0.8,
});

/** 兵科構成を個別に指定したい勢力向け（騎兵主体・弓兵主体の編成差別化）。 */
function customArmy(factionId: string, regionId: string, units: Army["units"], morale: number): Army {
  return mkArmy({ id: `army_${factionId.replace("faction_", "")}_home`, faction: factionId, commander: null, location: regionId, units, morale });
}

// ポーランド・ハンガリーは史実の騎兵伝統を反映し騎兵主体、
// イングランドは長弓（弓兵）主体、その他は歩兵主体の標準編成とする。
const additionalArmies: readonly Army[] = [
  customArmy("faction_poland", "region_poland", [{ type: "cavalry", count: 1600, training: 0.55 }], 0.6),
  customArmy("faction_hungary", "region_hungary", [{ type: "cavalry", count: 1400, training: 0.55 }], 0.6),
  customArmy(
    "faction_england",
    "region_england",
    [
      { type: "archer", count: 1300, training: 0.6 },
      { type: "infantry", count: 900, training: 0.5 },
    ],
    0.65,
  ),
  homeArmy("faction_mainz", "region_mainz", 900, 0.5, 0.55),
  homeArmy("faction_trier", "region_trier", 700, 0.45, 0.5),
  homeArmy("faction_cologne", "region_cologne", 950, 0.5, 0.55),
  homeArmy("faction_palatinate", "region_palatinate", 750, 0.5, 0.5),
  homeArmy("faction_brandenburg", "region_brandenburg", 850, 0.45, 0.5),
  homeArmy("faction_bohemia", "region_bohemia", 1200, 0.55, 0.6, "char_bohemia_boleslav"),
  homeArmy("faction_bavaria", "region_bavaria", 1500, 0.55, 0.6, "char_bavaria_heinrich"),
  homeArmy("faction_swabia", "region_swabia", 1300, 0.5, 0.55),
  homeArmy("faction_austria", "region_austria", 1000, 0.5, 0.55),
  homeArmy("faction_franche_comte", "region_franche_comte", 550, 0.45, 0.5),
  homeArmy("faction_lorraine", "region_lorraine", 650, 0.45, 0.5),
  homeArmy("faction_luxembourg", "region_luxembourg", 400, 0.4, 0.45),
  homeArmy("faction_flanders", "region_flanders", 900, 0.5, 0.55),
  homeArmy("faction_milan", "region_milan", 1400, 0.55, 0.6),
  homeArmy("faction_venice", "region_venice", 1100, 0.55, 0.6),
  homeArmy("faction_naples", "region_naples", 1400, 0.5, 0.55),
  homeArmy("faction_papal", "region_papal_states", 700, 0.45, 0.5),
  homeArmy("faction_asturias", "region_asturias", 700, 0.5, 0.6),
  homeArmy("faction_castile", "region_castile", 1000, 0.5, 0.55),
  homeArmy("faction_aragon", "region_aragon", 850, 0.5, 0.55),
];

export const initialArmies: readonly Army[] = [armyHreMain, armyWestFrancia, armyFreeCompany, ...additionalArmies];

// --- GameState -----------------------------------------------------------------

function byId<T extends { id: string }>(items: readonly T[]): Record<string, T> {
  return Object.fromEntries(items.map((item) => [item.id, item]));
}

export function createInitialGameState(): GameState {
  return {
    turn: 0,
    year: 962,
    phase: "year_start",
    regions: byId(initialRegions),
    factions: byId(initialFactions),
    armies: byId(initialArmies),
    characters: byId(initialCharacters),
    captivities: {},
    greatWarTriggered: false,
    playerFactionId: null,
    spectator: null,
    // 962年：オットー1世の戴冠（史実どおりの開始年）。以後、家系の断絶・服属が起きない
    // 限り帝位は固定されず選帝侯による選挙で入れ替わりうる（設計書 4.4章、ユーザー要望）。
    imperialTitle: { holderId: asFactionId("faction_hre"), since: 962 },
  };
}
