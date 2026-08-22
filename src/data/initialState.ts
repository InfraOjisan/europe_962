import { asArmyId, asCharacterId, asFactionId, asRegionId } from "../models/ids.js";
import type { Army } from "../models/army.js";
import type { Character } from "../models/character.js";
import type { Faction } from "../models/faction.js";
import type { GameState } from "../models/gameState.js";
import type { Region } from "../models/region.js";

/**
 * 962年（神聖ローマ帝国成立）開始時点のサンプル初期データ。
 *
 * データモデルを実際に組み立てて動かせることを示すための最小デモセットであり、
 * 史実の完全な再現・網羅を意図したものではない（州7つ・勢力4+傭兵1のみ）。
 * 本格的なシナリオデータは今後別途拡充する。
 *
 * 系譜（parents/children/adoptedChildren/adoptedBy）はゲーム開始時点では
 * 誰も子女を持たないため空にしている（設計書 4章の継承・養子縁組システムは
 * ゲーム開始後のプレイで実際に使われる想定）。
 */

// --- Regions --------------------------------------------------------------

const regionSaxony: Region = {
  id: asRegionId("region_saxony"),
  name: "ザクセン",
  owner: asFactionId("faction_hre"),
  terrain: "plain",
  terrainModifier: { attack: 1.0, defense: 1.0 },
  population: 300_000,
  taxBase: 900,
  archetype: "continental",
  garrison: { count: 2000, training: 0.6 },
  adjacency: [asRegionId("region_bavaria"), asRegionId("region_francia")],
  fortified: false,
  siege: null,
};

const regionBavaria: Region = {
  id: asRegionId("region_bavaria"),
  name: "バイエルン",
  owner: asFactionId("faction_hre"),
  terrain: "hill",
  terrainModifier: { attack: 0.95, defense: 1.1 },
  population: 250_000,
  taxBase: 750,
  archetype: "continental",
  garrison: { count: 1800, training: 0.6 },
  adjacency: [asRegionId("region_saxony"), asRegionId("region_swabia")],
  fortified: false,
  siege: null,
};

const regionSwabia: Region = {
  id: asRegionId("region_swabia"),
  name: "シュヴァーベン",
  owner: asFactionId("faction_hre"),
  terrain: "hill",
  terrainModifier: { attack: 0.95, defense: 1.1 },
  population: 220_000,
  taxBase: 700,
  archetype: "alpine", // アルプス山系に近く、後年のスイス傭兵供給地の原型として扱う
  garrison: { count: 1500, training: 0.55 },
  adjacency: [asRegionId("region_bavaria"), asRegionId("region_burgundy"), asRegionId("region_papal_states")],
  fortified: true,
  siege: null,
};

const regionFrancia: Region = {
  id: asRegionId("region_francia"),
  name: "西フランク（イル＝ド＝フランス）",
  owner: asFactionId("faction_west_francia"),
  terrain: "plain",
  terrainModifier: { attack: 1.0, defense: 1.0 },
  population: 280_000,
  taxBase: 850,
  archetype: "continental",
  garrison: { count: 1900, training: 0.55 },
  adjacency: [asRegionId("region_saxony"), asRegionId("region_burgundy")],
  fortified: false,
  siege: null,
};

const regionBurgundy: Region = {
  id: asRegionId("region_burgundy"),
  name: "ブルゴーニュ",
  owner: asFactionId("faction_west_francia"),
  terrain: "plain",
  terrainModifier: { attack: 1.0, defense: 1.0 },
  population: 180_000,
  taxBase: 600,
  archetype: "continental",
  garrison: { count: 1200, training: 0.5 },
  adjacency: [asRegionId("region_francia"), asRegionId("region_swabia")],
  fortified: false,
  siege: null,
};

const regionPapalStates: Region = {
  id: asRegionId("region_papal_states"),
  name: "教皇領",
  owner: asFactionId("faction_papal"),
  terrain: "mountain",
  terrainModifier: { attack: 0.85, defense: 1.25 },
  population: 150_000,
  taxBase: 650,
  archetype: "mediterranean",
  garrison: { count: 900, training: 0.45 },
  adjacency: [asRegionId("region_swabia"), asRegionId("region_byzantium")],
  fortified: true,
  siege: null,
};

const regionByzantium: Region = {
  id: asRegionId("region_byzantium"),
  name: "東ローマ（アプリア方面）",
  owner: asFactionId("faction_byzantium"),
  terrain: "coast",
  terrainModifier: { attack: 1.0, defense: 1.05 },
  population: 260_000,
  taxBase: 1000,
  archetype: "mediterranean",
  garrison: { count: 2200, training: 0.7 },
  adjacency: [asRegionId("region_papal_states")],
  fortified: false,
  siege: null,
};

export const initialRegions: readonly Region[] = [
  regionSaxony,
  regionBavaria,
  regionSwabia,
  regionFrancia,
  regionBurgundy,
  regionPapalStates,
  regionByzantium,
];

// --- Characters ------------------------------------------------------------

/** 系譜情報が不明・未設定の人物向けの既定値。 */
const NO_LINEAGE = { parents: [] as const, adoptedChildren: [] as const, adoptedBy: null } as const;

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
];

// --- Factions ----------------------------------------------------------------

const factionHre: Faction = {
  id: asFactionId("faction_hre"),
  name: "神聖ローマ帝国",
  type: "lord",
  ruler: charOtto1.id,
  consort: charAdelaide.id,
  children: [],
  heir: null, // まだ子女がいないため未指定（設計書 4.2）
  chancellors: [charHermann.id],
  warlords: [charBurchard.id],
  regions: [regionSaxony.id, regionBavaria.id, regionSwabia.id],
  treasury: 5000,
  diplomacy: {
    [asFactionId("faction_west_francia")]: "peace",
    [asFactionId("faction_papal")]: "alliance",
    [asFactionId("faction_byzantium")]: "peace",
  },
  alive: true,
};

const factionWestFrancia: Faction = {
  id: asFactionId("faction_west_francia"),
  name: "西フランク王国",
  type: "lord",
  ruler: charLothair.id,
  consort: null,
  children: [],
  heir: null,
  chancellors: [],
  warlords: [charGuyDeVermandois.id],
  regions: [regionFrancia.id, regionBurgundy.id],
  treasury: 3500,
  diplomacy: {
    [asFactionId("faction_hre")]: "peace",
  },
  alive: true,
};

const factionPapal: Faction = {
  id: asFactionId("faction_papal"),
  name: "教皇領",
  type: "lord",
  ruler: charJohn12.id,
  consort: null,
  children: [],
  heir: null,
  chancellors: [],
  warlords: [],
  regions: [regionPapalStates.id],
  treasury: 2000,
  diplomacy: {
    [asFactionId("faction_hre")]: "alliance",
    [asFactionId("faction_byzantium")]: "peace",
  },
  alive: true,
};

const factionByzantium: Faction = {
  id: asFactionId("faction_byzantium"),
  name: "東ローマ帝国",
  type: "lord",
  ruler: charNikephoros.id,
  consort: null,
  children: [],
  heir: null,
  chancellors: [],
  warlords: [],
  regions: [regionByzantium.id],
  treasury: 8000,
  diplomacy: {
    [asFactionId("faction_hre")]: "peace",
    [asFactionId("faction_papal")]: "peace",
  },
  alive: true,
};

const factionFreeCompany: Faction = {
  id: asFactionId("faction_free_company"),
  name: "自由傭兵団",
  type: "mercenary",
  ruler: null,
  consort: null,
  children: [],
  heir: null, // 傭兵団は家系を持たないため常に null
  chancellors: [],
  warlords: [charCondottiere.id],
  regions: [],
  treasury: 800,
  diplomacy: {},
  alive: true,
};

export const initialFactions: readonly Faction[] = [
  factionHre,
  factionWestFrancia,
  factionPapal,
  factionByzantium,
  factionFreeCompany,
];

// --- Armies ------------------------------------------------------------------

const armyHreMain: Army = {
  id: asArmyId("army_hre_main"),
  faction: factionHre.id,
  commander: charBurchard.id,
  location: regionSwabia.id,
  units: [
    { type: "pike", count: 2500, training: 0.65 },
    { type: "cavalry", count: 600, training: 0.6 },
  ],
  doctrine: "default",
  morale: 0.75,
  supply: 0.9,
};

const armyFreeCompany: Army = {
  id: asArmyId("army_free_company"),
  faction: factionFreeCompany.id,
  commander: charCondottiere.id,
  location: regionBurgundy.id,
  units: [{ type: "cavalry", count: 900, training: 0.55 }],
  doctrine: "default",
  morale: 0.6,
  supply: 0.8,
};

export const initialArmies: readonly Army[] = [armyHreMain, armyFreeCompany];

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
  };
}
