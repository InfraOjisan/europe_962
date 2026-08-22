import { isAtWar } from "../models/faction.js";
import type { GameState } from "../models/gameState.js";

/**
 * 大戦判定（設計書 4章）。
 *
 * war_ratio = 戦争状態にある生存勢力数 / 生存勢力数
 * war_ratio >= 2/3 で大戦発生。参戦の有無に関わらず全生存勢力が敗北する
 * （ゲーム理論通りに進めると必然的に破滅する、という世界観のコアルール）。
 */
export interface GreatWarCheckResult {
  readonly triggered: boolean;
  readonly warRatio: number;
  readonly atWarFactions: number;
  readonly aliveFactions: number;
}

const GREAT_WAR_THRESHOLD = 2 / 3;

export function checkGreatWar(state: GameState): GreatWarCheckResult {
  const alive = Object.values(state.factions).filter((f) => f.alive);
  const atWar = alive.filter(isAtWar);

  const warRatio = alive.length === 0 ? 0 : atWar.length / alive.length;

  return {
    triggered: warRatio >= GREAT_WAR_THRESHOLD,
    warRatio,
    atWarFactions: atWar.length,
    aliveFactions: alive.length,
  };
}

/**
 * 大戦への「近さ」（設計書 9.4 / 13章）。0〜1 で、`warRatio` を大戦判定の閾値
 * （2/3）で正規化したもの（1.0 に達すると大戦発生）。生成AI丸投げ方式では、
 * 意思決定の状況（`DecisionContext.greatWarProximity`）に必ず含めることで、
 * 「戦争を選び続けると必ず世界が詰む」というコアルールをAIの判断にも反映させる。
 */
export function greatWarProximity(state: GameState): number {
  const { warRatio } = checkGreatWar(state);
  return Math.min(1, warRatio / GREAT_WAR_THRESHOLD);
}
