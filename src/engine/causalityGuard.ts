import type { BattleOutcome, BattleResultKind } from "../models/battle.js";
import type { BattleResolutionInput } from "./combatEngine.js";

/**
 * ⚠️ 因果律の保護（Causality Guard）
 * ============================================================
 * 設計書 3章末尾の検証プロセス・ステップ3に対応する仕組み。
 * 係数・閾値のチューニングだけでは再現できない史実の転換点
 * （例：定説上ほぼ確実にこうなったはずの会戦が、確率的な戦闘解決では
 * 稀にしか起きない）を、戦闘演算そのものには手を入れず、その外側から
 * 明示的に補正するための最終手段。
 *
 * 濫用防止のための設計方針:
 *   - 既定では登録されたガードは1つもない（何もしなければ何も起きない）
 *   - ガードは `scenarioTag`（呼び出し側=TurnEngineやシナリオデータが付与する
 *     識別子）に紐づく形でのみ発火する。「勝率を底上げする」ような汎用の
 *     補正には使わない（それは3章の係数調整で解決すべき問題）
 *   - 適用されたガードは必ずログに残し、後から追跡できるようにする
 */

export interface CausalityGuardContext {
  /** シナリオ側が付与する識別子。史実再現用の特定局面にのみガードを紐づけるためのキー。 */
  readonly scenarioTag?: string;
  readonly turn: number;
}

/**
 * ガードルール本体。適用しない場合は null を返す。
 * 適用する場合は、渡された outcome を元に新しい BattleOutcome を返す
 * （既存の死傷者数などはできる限り保持し、結果種別など因果律上必要な部分のみ書き換える）。
 */
export type CausalityGuardRule = (
  outcome: BattleOutcome,
  context: CausalityGuardContext,
  input: BattleResolutionInput,
) => BattleOutcome | null;

export interface CausalityGuardLogEntry {
  readonly ruleId: string;
  readonly turn: number;
  readonly scenarioTag: string | undefined;
  readonly before: BattleResultKind;
  readonly after: BattleResultKind;
}

/**
 * ガードの登録・適用・監査ログをまとめて扱うレジストリ。
 * TurnEngine が戦闘解決の直後にこれを通す想定（combatEngine 自体は関知しない）。
 */
export class CausalityGuardRegistry {
  private readonly rules = new Map<string, CausalityGuardRule>();
  private readonly log: CausalityGuardLogEntry[] = [];

  register(id: string, rule: CausalityGuardRule): void {
    this.rules.set(id, rule);
  }

  unregister(id: string): void {
    this.rules.delete(id);
  }

  /** 登録済みガードを順に評価し、最初に適用されたものを反映する。適用がなければ outcome をそのまま返す。 */
  apply(outcome: BattleOutcome, context: CausalityGuardContext, input: BattleResolutionInput): BattleOutcome {
    for (const [ruleId, rule] of this.rules) {
      const overridden = rule(outcome, context, input);
      if (overridden === null) continue;
      this.log.push({
        ruleId,
        turn: context.turn,
        scenarioTag: context.scenarioTag,
        before: outcome.kind,
        after: overridden.kind,
      });
      return overridden;
    }
    return outcome;
  }

  getLog(): readonly CausalityGuardLogEntry[] {
    return this.log;
  }
}

/**
 * よくある形のガードを簡単に書くためのファクトリ：
 * 特定の `scenarioTag` かつ特定ターンでのみ、結果種別を強制的に上書きする。
 * 死傷者数などの演算結果はそのまま活かし、`kind`（と、占領/併合に伴う `newOwner`）のみ書き換える。
 */
export function forceOutcomeGuard(
  scenarioTag: string,
  turn: number,
  forcedKind: BattleResultKind,
): CausalityGuardRule {
  return (outcome, context, input) => {
    if (context.scenarioTag !== scenarioTag || context.turn !== turn) return null;
    if (outcome.kind === forcedKind) return null; // 既にその結果なら介入不要

    const newOwner =
      forcedKind === "occupation"
        ? input.attackerFaction
        : forcedKind === "surrender"
          ? input.defenderFaction
          : null;

    return { ...outcome, kind: forcedKind, newOwner };
  };
}
