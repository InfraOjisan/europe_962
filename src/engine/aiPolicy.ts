import type { Policy } from "../models/policy.js";
import { ALL_POLICIES } from "../models/policy.js";

/**
 * ⚠️ AI意思決定エンジン（点数判断・草案）
 * ============================================================
 * 設計書 9章。キャラクターの `Policy`（行動方針）に応じて、提示された選択肢群の中から
 * 最も望ましいものをスコアリングで選ぶ。ネットワーク不要・決定的で、
 * `aiProvider.ts` の生成AI丸投げ方式が使えない/失敗した場合のフォールバックにもなる。
 *
 * スコアの重み自体は仮値。combatEngine と同様、史実シナリオでの継続チューニング対象。
 */

/** 0〜1 の乱数を返す関数。テストでは固定シーケンスを注入できるようにする。 */
export type RandomSource = () => number;

/** `Math.random` をそのまま使う既定の乱数源。 */
export const defaultRandomSource: RandomSource = () => Math.random();

/**
 * 記録の乏しい人物への既定Policy割り当て（設計書 9.1）。
 * 4種から一様乱数で1つを選ぶ。
 */
export function assignRandomPolicy(random: RandomSource = defaultRandomSource): Policy {
  const index = Math.floor(random() * ALL_POLICIES.length);
  return ALL_POLICIES[Math.min(index, ALL_POLICIES.length - 1)]!;
}

/**
 * 選択肢の性質を表す4軸のスコア（0〜1）。
 * - safety:      安全性（自己・自家の保全につながるか）
 * - expansion:    拡張性（勢力・版図の拡大につながるか）
 * - profit:        収益性（金銭・私的利益につながるか）
 * - legitimacy:     正当性（秩序・信義・民の利益につながるか）
 */
export interface DecisionOption {
  /** 生成AI丸投げ方式で使う記号（"A", "B", "C"...）。点数判断でも表示・ログ用に使う。 */
  readonly label: string;
  /** 選択肢の説明文。生成AIへのプロンプトにもそのまま使う。 */
  readonly description: string;
  readonly safety: number;
  readonly expansion: number;
  readonly profit: number;
  readonly legitimacy: number;
}

/** 意思決定の状況。生成AI丸投げ方式ではプロンプトの本文になる。 */
export interface DecisionContext {
  /** 意思決定を行う人物の役職（"君主" "戦闘隊長" "宰相" など、プロンプト用の表示名）。 */
  readonly actorRole: string;
  /** 状況の要約（例：「劣勢の会戦で、退路が塞がれつつある」）。 */
  readonly summary: string;
  /**
   * 大戦（世界同時多発戦争によるゲームオーバー）への近さ（0〜1、`warCheck.ts` の
   * `greatWarProximity` で算出）。生成AI丸投げ方式に必ず渡す前提の値
   * （ユーザー要望：「世界のゲームオーバーは必ずAIへの丸投げ時は前提に入れる」）。
   * 点数判断（`decideByScoring`）自体はこの値を直接参照しないが、呼び出し側
   * （`turnEngine.ts` の外交フェイズ）が選択肢のスコアを組み立てる際にこの値を
   * 織り込む（戦争継続・宣戦オプションの safety を下げる等）ことで、
   * 両方式で大戦回避バイアスが一貫して働くようにする。
   */
  readonly greatWarProximity: number;
}

type PolicyWeights = Readonly<Record<"safety" | "expansion" | "profit" | "legitimacy", number>>;

/** Policyごとの重み付け（設計書 9.3、仮値）。 */
export const POLICY_WEIGHTS: Readonly<Record<Policy, PolicyWeights>> = {
  self_preservation: { safety: 1.0, expansion: 0.2, profit: 0.3, legitimacy: 0.5 },
  expansionism: { safety: 0.2, expansion: 1.0, profit: 0.5, legitimacy: 0.2 },
  self_interest: { safety: 0.4, expansion: 0.3, profit: 1.0, legitimacy: 0.2 },
  justice: { safety: 0.4, expansion: 0.2, profit: 0.2, legitimacy: 1.0 },
};

/** 1つの選択肢を、特定のPolicyの重みでスコアリングする。 */
export function scoreOption(option: DecisionOption, policy: Policy): number {
  const w = POLICY_WEIGHTS[policy];
  return option.safety * w.safety + option.expansion * w.expansion + option.profit * w.profit + option.legitimacy * w.legitimacy;
}

/**
 * 点数判断で選択肢を選ぶ。同点の場合は先に列挙された方を優先する（決定的な挙動にするため）。
 * `options` が空の場合はエラーを投げる（呼び出し側の不備を早期に検出する）。
 */
export function decideByScoring(policy: Policy, options: readonly DecisionOption[]): DecisionOption {
  if (options.length === 0) throw new Error("decideByScoring: options must not be empty");
  return options.reduce((best, current) => (scoreOption(current, policy) > scoreOption(best, policy) ? current : best));
}
