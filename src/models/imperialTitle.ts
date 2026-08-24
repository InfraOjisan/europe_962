import type { FactionId } from "./ids.js";

/**
 * 神聖ローマ皇帝の称号（設計書 4.4／ユーザー要望）。
 *
 * 「神聖ローマ帝国」を特定の家系（`faction_hre`）に固定せず、独立した状態として
 * 管理する。962年開始時点ではオットー1世（`faction_hre`＝「ザクセン選帝侯領」）が
 * 保持するが、その家系が断絶・服属した場合は選帝侯による選挙（`turnEngine.ts` の
 * `electImperialTitle`）で新たな保持者が決まる——史実どおり、いずれ他の家系
 * （ハプスブルク家＝`faction_austria` 等）が戴冠する可能性を残す設計。
 */
export interface ImperialTitle {
  readonly holderId: FactionId;
  /** 戴冠した西暦年。 */
  readonly since: number;
}
