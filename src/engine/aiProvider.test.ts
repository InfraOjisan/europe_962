import { describe, expect, it, vi } from "vitest";
import type { DecisionContext, DecisionOption } from "./aiPolicy.js";
import { decideByScoring } from "./aiPolicy.js";
import type { MinimalFetchResponse } from "./aiProvider.js";
import { buildDecisionPrompt, decideAction, decideByLLM, resolveProviderConfig } from "./aiProvider.js";

const context: DecisionContext = {
  actorRole: "戦闘隊長",
  summary: "劣勢の会戦で、退路が塞がれつつある",
  greatWarProximity: 0.2,
};
const options: readonly DecisionOption[] = [
  { label: "A", description: "踏みとどまって戦う", safety: 0.1, expansion: 0.2, profit: 0, legitimacy: 0.6 },
  { label: "B", description: "退却路を強行突破する", safety: 0.7, expansion: 0, profit: 0, legitimacy: 0.1 },
];

function okResponse(content: string): MinimalFetchResponse {
  return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
}

describe("resolveProviderConfig", () => {
  it("何も指定しなければ OpenAI の既定値になる（apiKeyはnull）", () => {
    const resolved = resolveProviderConfig(undefined, {});
    expect(resolved.endpoint).toBe("https://api.openai.com/v1/chat/completions");
    expect(resolved.model).toBe("gpt-4o");
    expect(resolved.apiKey).toBeNull();
  });

  it("OPENAI_API_KEY 環境変数を拾う", () => {
    const resolved = resolveProviderConfig(undefined, { OPENAI_API_KEY: "sk-env" });
    expect(resolved.apiKey).toBe("sk-env");
  });

  it("プレイヤー設定（独自エンドポイント/キー）が環境変数・既定値より優先される", () => {
    const resolved = resolveProviderConfig(
      { endpoint: "https://my-llm.example.com/v1/chat", apiKey: "user-key", model: "my-model" },
      { OPENAI_API_KEY: "sk-env" },
    );
    expect(resolved.endpoint).toBe("https://my-llm.example.com/v1/chat");
    expect(resolved.apiKey).toBe("user-key");
    expect(resolved.model).toBe("my-model");
  });
});

describe("buildDecisionPrompt", () => {
  it("選択肢ラベル・説明とPolicyの説明文をプロンプトに含める", () => {
    const { system, user } = buildDecisionPrompt(context, options, "self_preservation");
    expect(system.length).toBeGreaterThan(0);
    expect(user).toContain("A. 踏みとどまって戦う");
    expect(user).toContain("B. 退却路を強行突破する");
    expect(user).toContain("自己の生存");
    expect(user).toContain(context.summary);
  });
});

describe("decideByLLM", () => {
  it("APIキーが解決できない場合は fetch を呼ばずに null を返す", async () => {
    const fetchImpl = vi.fn();
    const result = await decideByLLM(context, options, "self_preservation", {}, fetchImpl);
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("応答の記号に一致する選択肢を返す", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse("B"));
    const result = await decideByLLM(context, options, "self_preservation", { apiKey: "sk-test" }, fetchImpl);
    expect(result?.option).toBe(options[1]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("通信が失敗した場合は null を返す（例外を投げない）", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const result = await decideByLLM(context, options, "self_preservation", { apiKey: "sk-test" }, fetchImpl);
    expect(result).toBeNull();
  });

  it("HTTPエラー応答の場合は null を返す", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    const result = await decideByLLM(context, options, "self_preservation", { apiKey: "sk-test" }, fetchImpl);
    expect(result).toBeNull();
  });

  it("どの選択肢にも一致しない応答の場合は null を返す", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse("Z"));
    const result = await decideByLLM(context, options, "self_preservation", { apiKey: "sk-test" }, fetchImpl);
    expect(result).toBeNull();
  });
});

describe("decideAction（統合フロー）", () => {
  it("APIキー未設定なら点数判断にフォールバックする", async () => {
    const fetchImpl = vi.fn();
    const result = await decideAction(context, options, "self_preservation", {}, fetchImpl);
    expect(result).toBe(decideByScoring("self_preservation", options));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("生成AIが応答すればその結果を使う（点数判断と異なる結論でも上書きする）", async () => {
    // self_preservation の点数判断では safety の高い B（強行突破）が選ばれるはずだが、
    // LLM側が A（踏みとどまる）と回答したら、その結論を採用することを確認する。
    expect(decideByScoring("self_preservation", options)).toBe(options[1]);
    const fetchImpl = vi.fn().mockResolvedValue(okResponse("A"));
    const result = await decideAction(context, options, "self_preservation", { apiKey: "sk-test" }, fetchImpl);
    expect(result).toBe(options[0]);
  });

  it("生成AI呼び出しが失敗したら点数判断にフォールバックする", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("timeout"));
    const result = await decideAction(context, options, "self_preservation", { apiKey: "sk-test" }, fetchImpl);
    expect(result).toBe(decideByScoring("self_preservation", options));
  });
});
