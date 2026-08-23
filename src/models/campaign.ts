import type { FactionId } from "./ids.js";

/**
 * 大国キャンペーンAI（設計書 9.4／ユーザー要望）の進行フェイズ。
 * - isolate：標的の隣国と同盟を結び、標的を外交的に孤立させる（近攻遠交の応用）。
 * - annihilate：標的に宣戦布告し、滅亡（または併合）させるまで和平で妥協しない。
 */
export type CampaignPhase = "isolate" | "annihilate";

/**
 * ある勢力（現状は5大勢力限定、`turnEngine.ts` の `GREAT_POWER_FACTION_IDS`）が
 * 現在追っている長期的な対外方針。1勢力につき同時に1つまで。
 */
export interface Campaign {
  readonly targetFactionId: FactionId;
  readonly phase: CampaignPhase;
  /** キャンペーンを開始した西暦年（フェイズ遷移・期限切れ判定の基準）。 */
  readonly startedYear: number;
}
