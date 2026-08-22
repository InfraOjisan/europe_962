import { describe, expect, it } from "vitest";
import type { DecisionOption } from "./aiPolicy.js";
import { assignRandomPolicy, decideByScoring, scoreOption } from "./aiPolicy.js";
import { ALL_POLICIES } from "../models/policy.js";

describe("assignRandomPolicy", () => {
  it("乱数0は最初のPolicy、乱数1未満の最大値付近は最後のPolicyに写像される", () => {
    expect(assignRandomPolicy(() => 0)).toBe(ALL_POLICIES[0]);
    expect(assignRandomPolicy(() => 0.9999)).toBe(ALL_POLICIES[ALL_POLICIES.length - 1]);
  });

  it("4種すべてに到達しうる（等分布の目視確認）", () => {
    const seen = new Set(ALL_POLICIES.map((_, i) => assignRandomPolicy(() => i / ALL_POLICIES.length)));
    expect(seen.size).toBe(ALL_POLICIES.length);
  });
});

describe("scoreOption / decideByScoring", () => {
  const safeOption: DecisionOption = { label: "A", description: "撤退して家名を守る", safety: 1, expansion: 0, profit: 0, legitimacy: 0.2 };
  const expandOption: DecisionOption = { label: "B", description: "攻勢に出て版図を広げる", safety: 0, expansion: 1, profit: 0.3, legitimacy: 0 };
  const profitOption: DecisionOption = { label: "C", description: "略奪して私腹を肥やす", safety: 0.2, expansion: 0.1, profit: 1, legitimacy: 0 };
  const justOption: DecisionOption = { label: "D", description: "民に対する信義を守る", safety: 0.2, expansion: 0, profit: 0, legitimacy: 1 };
  const options = [safeOption, expandOption, profitOption, justOption];

  it("Policyごとに一致する軸のスコアが最も高くなる", () => {
    expect(scoreOption(safeOption, "self_preservation")).toBeGreaterThan(scoreOption(expandOption, "self_preservation"));
    expect(scoreOption(expandOption, "expansionism")).toBeGreaterThan(scoreOption(safeOption, "expansionism"));
  });

  it("decideByScoring はPolicyに最も合致する選択肢を選ぶ", () => {
    expect(decideByScoring("self_preservation", options)).toBe(safeOption);
    expect(decideByScoring("expansionism", options)).toBe(expandOption);
    expect(decideByScoring("self_interest", options)).toBe(profitOption);
    expect(decideByScoring("justice", options)).toBe(justOption);
  });

  it("同点の場合は先に列挙された選択肢を優先する（決定的な挙動）", () => {
    const tieA: DecisionOption = { label: "A", description: "x", safety: 0.5, expansion: 0.5, profit: 0.5, legitimacy: 0.5 };
    const tieB: DecisionOption = { label: "B", description: "y", safety: 0.5, expansion: 0.5, profit: 0.5, legitimacy: 0.5 };
    expect(decideByScoring("justice", [tieA, tieB])).toBe(tieA);
  });

  it("選択肢が空の場合はエラーを投げる", () => {
    expect(() => decideByScoring("justice", [])).toThrow();
  });
});
