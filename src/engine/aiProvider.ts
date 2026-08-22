import type { Policy } from "../models/policy.js";
import type { DecisionContext, DecisionOption } from "./aiPolicy.js";
import { decideByScoring } from "./aiPolicy.js";

/**
 * ⚠️ AI意思決定エンジン（生成AI丸投げ方式・草案）
 * ============================================================
 * 設計書 9.2。状況と選択肢をプロンプト化し、外部LLMに記号（"A" "B" "C"...）で
 * 回答させる方式。プレイヤーが独自のエンドポイント／APIキーを設定していればそれを使い、
 * 未設定の場合は既定でOpenAI API（gpt-4o系）を使う。
 *
 * 呼び出しが失敗（未設定・タイムアウト・パース不能な応答）した場合は、
 * 呼び出し側の `decideAction` が自動的に `aiPolicy.ts` の点数判断にフォールバックする
 * （AIの意思決定が理由でゲームが止まらないようにするため）。
 */

export interface AIProviderConfig {
  /** OpenAI互換の chat completions エンドポイント。省略時は OpenAI の既定URL。 */
  readonly endpoint?: string;
  /** 省略時は環境変数 `AI_PROVIDER_API_KEY` → `OPENAI_API_KEY` の順に参照する。 */
  readonly apiKey?: string;
  readonly model?: string;
}

export interface ResolvedAIProviderConfig {
  readonly endpoint: string;
  readonly apiKey: string | null;
  readonly model: string;
}

const DEFAULT_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o";

/** プレイヤー設定・環境変数・既定値の順で AIProviderConfig を解決する。 */
export function resolveProviderConfig(
  userConfig?: AIProviderConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedAIProviderConfig {
  return {
    endpoint: userConfig?.endpoint ?? env["AI_PROVIDER_ENDPOINT"] ?? DEFAULT_ENDPOINT,
    apiKey: userConfig?.apiKey ?? env["AI_PROVIDER_API_KEY"] ?? env["OPENAI_API_KEY"] ?? null,
    model: userConfig?.model ?? env["AI_PROVIDER_MODEL"] ?? DEFAULT_MODEL,
  };
}

function policyDescription(policy: Policy): string {
  switch (policy) {
    case "self_preservation":
      return "自己の生存（家名・自分の身の安全）を最優先する";
    case "expansionism":
      return "領主の勢力拡大（版図・軍事力の拡大）を最優先する";
    case "self_interest":
      return "自己の利益拡大（財産・地位・私腹）を最優先する";
    case "justice":
      return "社会的正義の執行（民の安寧・秩序・信義）を重視する";
  }
}

/** ユーザーメッセージ・システムメッセージを組み立てる（テスト・デバッグ用に公開）。 */
export function buildDecisionPrompt(
  context: DecisionContext,
  options: readonly DecisionOption[],
  policy: Policy,
): { readonly system: string; readonly user: string } {
  const optionLines = options.map((o) => `${o.label}. ${o.description}`).join("\n");
  const system =
    "あなたは中世〜近世ヨーロッパを舞台にした歴史シミュレーションゲームの登場人物の行動を判断するアシスタントです。" +
    "与えられた状況と人物像から、最もふさわしい行動を1つだけ選んでください。";
  const user =
    `${policyDescription(policy)}${context.actorRole}が、次の状況に置かれています。\n\n` +
    `状況: ${context.summary}\n\n` +
    `選択肢:\n${optionLines}\n\n` +
    `最も妥当な行動を1つ選び、対応する記号のみを1文字で回答してください（説明は不要です）。`;
  return { system, user };
}

/** fetch の最小限の型（テストでの差し替えを容易にするため、Response全体ではなくこれだけを要求する）。 */
export interface MinimalFetchResponse {
  readonly ok: boolean;
  json(): Promise<unknown>;
}
export type FetchLike = (input: string, init: RequestInit) => Promise<MinimalFetchResponse>;

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

export interface LLMDecisionResult {
  readonly option: DecisionOption;
  /** LLMの生の応答（ログ・デバッグ用）。 */
  readonly raw: string;
}

interface ChatCompletionResponse {
  readonly choices?: ReadonlyArray<{ readonly message?: { readonly content?: string } }>;
}

/**
 * 生成AIに意思決定を委ねる。APIキーが解決できない場合や、通信・応答解析に失敗した場合は
 * `null` を返す（例外は投げない）。呼び出し側はこの `null` を見て点数判断にフォールバックすること。
 */
export async function decideByLLM(
  context: DecisionContext,
  options: readonly DecisionOption[],
  policy: Policy,
  config?: AIProviderConfig,
  fetchImpl: FetchLike = defaultFetch,
): Promise<LLMDecisionResult | null> {
  const resolved = resolveProviderConfig(config);
  if (!resolved.apiKey || options.length === 0) return null;

  const { system, user } = buildDecisionPrompt(context, options, policy);

  let response: MinimalFetchResponse;
  try {
    response = await fetchImpl(resolved.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resolved.apiKey}`,
      },
      body: JSON.stringify({
        model: resolved.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
        max_tokens: 5,
      }),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let raw: string;
  try {
    const data = (await response.json()) as ChatCompletionResponse;
    raw = data.choices?.[0]?.message?.content ?? "";
  } catch {
    return null;
  }

  const matchedLabel = raw.trim().match(/[A-Za-z]/)?.[0]?.toUpperCase();
  const option = options.find((o) => o.label.toUpperCase() === matchedLabel);
  return option ? { option, raw } : null;
}

/**
 * 意思決定の統合エントリーポイント。生成AIが使えれば使い、使えない／失敗した場合は
 * 点数判断（`decideByScoring`）に自動フォールバックする。
 */
export async function decideAction(
  context: DecisionContext,
  options: readonly DecisionOption[],
  policy: Policy,
  config?: AIProviderConfig,
  fetchImpl: FetchLike = defaultFetch,
): Promise<DecisionOption> {
  const llmResult = await decideByLLM(context, options, policy, config, fetchImpl);
  return llmResult ? llmResult.option : decideByScoring(policy, options);
}
