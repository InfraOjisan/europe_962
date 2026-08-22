// 地図表示用のレイアウト情報（ゲームロジックとは独立。座標は史実の地理関係を
// 大まかに再現した模式図であり、正確な測地座標ではない）。
// viewBox は 0 0 1400 1000。

export const MAP_VIEWBOX = "0 0 1500 1050";

export const MAP_LAYOUT = {
  // イングランド
  region_england: { x: 230, y: 130 },
  // スペインの道の回廊
  region_flanders: { x: 420, y: 180 },
  region_luxembourg: { x: 400, y: 260 },
  region_lorraine: { x: 460, y: 300 },
  region_franche_comte: { x: 460, y: 380 },
  // 選帝侯
  region_cologne: { x: 480, y: 150 },
  region_trier: { x: 440, y: 230 },
  region_mainz: { x: 530, y: 220 },
  region_palatinate: { x: 540, y: 290 },
  region_saxony: { x: 640, y: 160 },
  region_brandenburg: { x: 700, y: 90 },
  region_bohemia: { x: 700, y: 260 },
  // 非選帝侯の有力諸侯
  region_bavaria: { x: 620, y: 330 },
  region_swabia: { x: 540, y: 370 },
  region_austria: { x: 700, y: 380 },
  // ポーランド・ハンガリー
  region_poland: { x: 800, y: 140 },
  region_hungary: { x: 760, y: 380 },
  // イタリア半島
  region_milan: { x: 580, y: 460 },
  region_venice: { x: 660, y: 450 },
  region_papal_states: { x: 610, y: 540 },
  region_naples: { x: 640, y: 630 },
  // 東ローマ
  region_byzantium: { x: 790, y: 590 },
  // 西フランク
  region_francia: { x: 300, y: 330 },
  region_burgundy: { x: 400, y: 380 },
  // イベリア半島
  region_asturias: { x: 110, y: 400 },
  region_castile: { x: 180, y: 460 },
  region_aragon: { x: 280, y: 450 },
};

/**
 * 「スペインの道」（設計書 15章）：ミラノからフランス領を経由せず、シュヴァーベン
 * （アルプス越え）・フランシュ＝コンテ・ロレーヌ・ルクセンブルクを経てフランドル
 * （スペイン領ネーデルラント）へ至る回廊。実際の隣接チェーンとして地図上に再現できる。
 */
export const SPANISH_ROAD = [
  "region_milan",
  "region_swabia",
  "region_franche_comte",
  "region_lorraine",
  "region_luxembourg",
  "region_flanders",
];

/** 海・水域を示す装飾用の楕円（クリック判定等は持たない、背景演出のみ）。 */
export const SEA_PATCHES = [
  { cx: 300, cy: 230, rx: 120, ry: 65, label: "英仏海峡・北海" }, // 英仏海峡〜北海
  { cx: 550, cy: 720, rx: 280, ry: 90, label: "地中海" }, // 地中海
  { cx: 740, cy: 500, rx: 90, ry: 70, label: "アドリア海" }, // アドリア海
  { cx: 40, cy: 350, rx: 80, ry: 150, label: "大西洋" }, // 大西洋（イベリア北西）
];
