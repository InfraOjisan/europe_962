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
  // 臣従（vassal）した勢力は、独立して交戦を続ける主体ではないため「戦争状態にある」
  // カウントから除外する（ユーザー報告：序盤に服属・滅亡した勢力の古い「戦争中」
  // ステータスが残ったまま生存勢力の war_ratio に数えられ続け、大戦回避のストッパー
  // 〈`wouldSingleHandedlyTriggerGreatWar`、turnEngine.ts〉が誤作動して、無関係な
  // 2勢力が開戦→（ストッパーに阻まれて）和平→開戦…を繰り返す原因になっていた）。
  // 滅亡（`alive: false`）は既に上の `alive` フィルタで除外済み。降伏（州も軍団も
  // 失った状態）は `eliminateFactionIfLandless`（turnEngine.ts）により通常
  // `alive: false` に遷移するため、実質的に同じ扱いになる。
  const atWar = alive.filter((f) => f.suzerain === null && isAtWar(f));

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
