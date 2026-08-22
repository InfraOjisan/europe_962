import type { CharacterId, FactionId } from "./ids.js";

/**
 * 拘留の目的。設計書 5章。
 *
 * - war_captive:      戦争捕虜。降伏時に捕縛された指揮官。身代金交渉・登用交渉の対象。
 * - political_hostage: 政治的人質。服属・傀儡化条約の担保として差し出された人物。
 *                      条約破棄時に処遇イベント（処刑/返還など）が発生しうる。
 */
export type CaptivityPurpose = "war_captive" | "political_hostage";

/**
 * 捕虜・人質の拘留状態。
 * GameState では `captive` の CharacterId をキーとする Record として保持する
 * （1人につき同時に1つの拘留状態のみ持てる想定）。
 */
export interface Captivity {
  /** 捕らえられた人物。 */
  readonly captive: CharacterId;
  /** 現在の拘留元（捕らえた勢力、または人質を受け取った勢力）。 */
  readonly captor: FactionId;
  /** 元の所属勢力。身代金の請求先、政治的人質の場合は条約の相手方になる。 */
  readonly homeFaction: FactionId;
  readonly purpose: CaptivityPurpose;
  /** 拘留開始ターン。拘留年数・獄死判定の起点。 */
  readonly capturedTurn: number;
  /** 身代金要求額。political_hostage の場合は 0（金銭ではなく条約遵守が対価）。 */
  readonly ransomDemand: number;
}
