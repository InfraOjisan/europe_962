import { effectiveStrength, totalTroops, type Army } from "../models/army.js";
import type { CasualtyReport } from "../models/battle.js";
import { isAtWar, type DiplomaticStance } from "../models/faction.js";
import type { FactionId, GameState, Policy, Region, RegionId, TurnPhase } from "../models/index.js";
import type { DecisionContext, DecisionOption, RandomSource } from "./aiPolicy.js";
import { decideByScoring, defaultRandomSource, scoreOption } from "./aiPolicy.js";
import type { AIProviderConfig } from "./aiProvider.js";
import { decideAction } from "./aiProvider.js";
import { registerCapture } from "./captivity.js";
import type { CausalityGuardRegistry } from "./causalityGuard.js";
import { resolveBattle, type BattleResolutionInput } from "./combatEngine.js";
import { findEscapeRegion } from "./combatEngine.js";
import { armyUpkeep, calculateEffectiveTax, garrisonUpkeep, rollWeatherFactor } from "./economy.js";
import { applyYearStartEvents } from "./eventEngine.js";
import type { HistoricalEvent } from "../data/historicalEvents.js";
import type { OffMapThreatDefinition } from "../data/offMapThreats.js";
import { rollOffMapThreats } from "./offMapThreats.js";
import { applySuccession } from "./succession.js";
import { checkGreatWar, greatWarProximity } from "./warCheck.js";

/**
 * ⚠️ ターンエンジン（草案）
 * ============================================================
 * 設計書 1.1 の5フェイズ（年始→外交→行動→戦闘解決→年末集計）を実際に回す
 * オーケストレーション層。combatEngine / succession / captivity / warCheck /
 * economy / eventEngine を1つの `advanceYear` にまとめ、ゲームを実際に
 * 前進させられる状態にする。
 *
 * 外交フェイズ・行動フェイズは AI・プレイヤー入力が未実装のため現状スタブ
 * （フェイズを進めるだけ）。設計書 9章の「AI意思決定システム」に対応する。
 * 戦闘解決フェイズは設計書 3.7 節の多重戦闘・奇襲・挟撃の判定ロジックに従う。
 * 年末集計フェイズは設計書 10章の税収・維持費計算を行う。
 */

/** 奇襲成立の指揮能力の閾値（設計書 3.7、仮値）。 */
const SURPRISE_COMMAND_THRESHOLD = 0.7;
/** 同一州・同一ターン内で連続解決する遭遇戦の上限（無限ループ防止の安全弁）。 */
const MAX_ENCOUNTERS_PER_REGION = 20;

/**
 * ターン進行の各フェイズに渡す実行時オプション。
 * - guards:  因果律の保護（3.6章）。省略時は何も補正しない。
 * - random:  天候抽選（10.2章）・版図外勢力の襲来抽選（13章）などに使う乱数源。省略時は `Math.random`。
 * - events:  年始フェイズで適用する史実イベント年表（11章）。省略時は全イベント有効、
 *            空配列を渡せば無効化できる。
 * - offMapThreats: 年始フェイズで判定する版図外勢力の襲来定義（13章）。省略時は全脅威有効、
 *            空配列を渡せば無効化できる。
 */
export interface TurnEngineOptions {
  readonly guards?: CausalityGuardRegistry;
  readonly random?: RandomSource;
  readonly events?: readonly HistoricalEvent[];
  readonly offMapThreats?: readonly OffMapThreatDefinition[];
}

/** 戦闘結果の死傷者数・捕虜数を実際の Army の兵科構成に按分して反映する（近似）。 */
function applyArmyCasualties(army: Army, casualties: CasualtyReport): Army {
  const startTotal = totalTroops(army);
  const totalLost = casualties.killed + casualties.captured;
  if (startTotal === 0) return { ...army, morale: casualties.moraleAfter };

  const survivingFraction = Math.max(0, Math.min(1, (startTotal - totalLost) / startTotal));
  const units = army.units.map((u) => ({ ...u, count: Math.max(0, Math.round(u.count * survivingFraction)) }));
  return { ...army, units, morale: casualties.moraleAfter };
}

/** 1件の戦闘結果（因果律の保護を通した後）を GameState に反映する。 */
function applyBattleOutcome(
  state: GameState,
  input: BattleResolutionInput,
  guards: CausalityGuardRegistry | undefined,
): GameState {
  const rawOutcome = resolveBattle(input);
  const outcome = guards ? guards.apply(rawOutcome, { turn: state.turn }, input) : rawOutcome;

  const attackerArmy = state.armies[outcome.attackerArmy];
  const defenderArmy = state.armies[outcome.defenderArmy];
  if (!attackerArmy || !defenderArmy) return state;

  let updatedAttacker = applyArmyCasualties(attackerArmy, outcome.attackerCasualties);
  let updatedDefender = applyArmyCasualties(defenderArmy, outcome.defenderCasualties);

  let regions = state.regions;
  let factions = state.factions;
  if (outcome.kind === "occupation" && outcome.newOwner) {
    const region = regions[outcome.region];
    const previousOwner = region?.owner;
    const newOwner = outcome.newOwner;
    if (region && previousOwner && previousOwner !== newOwner) {
      regions = { ...regions, [outcome.region]: { ...region, owner: newOwner } };
      const loserFaction = factions[previousOwner];
      const winnerFaction = factions[newOwner];
      factions = {
        ...factions,
        ...(loserFaction
          ? { [previousOwner]: { ...loserFaction, regions: loserFaction.regions.filter((r) => r !== outcome.region) } }
          : {}),
        ...(winnerFaction
          ? { [newOwner]: { ...winnerFaction, regions: [...winnerFaction.regions, outcome.region] } }
          : {}),
      };
    }
  }

  if (outcome.kind === "retreat" && outcome.retreatingSide) {
    const region = regions[outcome.region];
    const loserFaction = outcome.retreatingSide === "attacker" ? outcome.attacker : outcome.defender;
    const escapeRegionId = region ? findEscapeRegion(loserFaction, region, regions) : null;
    if (escapeRegionId) {
      if (outcome.retreatingSide === "attacker") updatedAttacker = { ...updatedAttacker, location: escapeRegionId };
      else updatedDefender = { ...updatedDefender, location: escapeRegionId };
    }
  }

  let next: GameState = { ...state, regions, factions };
  next = registerCapture(next, outcome);

  const armies = { ...next.armies };
  if (totalTroops(updatedAttacker) > 0) armies[updatedAttacker.id] = updatedAttacker;
  else delete armies[updatedAttacker.id];
  if (totalTroops(updatedDefender) > 0) armies[updatedDefender.id] = updatedDefender;
  else delete armies[updatedDefender.id];

  return { ...next, armies };
}

// --- ① 年始フェイズ ---------------------------------------------------------

function runYearStart(state: GameState, options: TurnEngineOptions): GameState {
  const random = options.random ?? defaultRandomSource;
  let next = state;
  for (const faction of Object.values(state.factions)) {
    if (!faction.alive || faction.ruler === null) continue;
    const ruler = next.characters[faction.ruler];
    if (ruler && !ruler.alive) {
      next = applySuccession(next, ruler.id, faction.id);
    }
  }
  // 史実イベント年表（設計書 11章）。options.events に空配列を渡せば無効化できる。
  next = applyYearStartEvents(next, options.events).state;
  // 版図外勢力（モンゴル・ティムール・オスマン＝ペルシャ等）の天災的襲来（設計書 13章）。
  // options.offMapThreats に空配列を渡せば無効化できる。
  next = rollOffMapThreats(next, random, options.offMapThreats).state;
  // TODO: 疫病（黒死病以外の局地的な発生）・宗教などのランダムイベント抽選
  return { ...next, phase: "diplomacy" };
}

// --- ② 外交フェイズ・③ 行動フェイズ（設計書 9.4／13章：AI接続） ---------------
//
// 方針（設計書 9.4）：ゲームは約1000ターンに及ぶため、毎ターン・全勢力ペア・全軍団に
// 生成AI丸投げ方式（ネットワークI/O、非同期）を使うのは性能・コスト面で非現実的。
// そこで `runDiplomacy`/`runAction`（本体・同期）は常に `decideByScoring`（点数判断、
// ネットワーク不要・決定的）で全AI勢力を動かす。生成AI丸投げ方式は、これと業務ロジックを
// 完全に共有した非同期版 `runDiplomacyAsync`/`runActionAsync` として別途提供し、
// 「大戦への接近が著しい」「歴史的な転換点」など、呼び出し側が"major decision"と判断した
// ターン・局面でだけ、これらの非同期版を代わりに呼び出す形でオプトインする
// （AIInvocationPolicy: "scoring_only"（既定・本体が使う） | "llm_for_major_decisions"）。
//
// AIが選択肢を評価する際、「大戦（世界同時多発戦争）への近さ」（`warCheck.ts` の
// `greatWarProximity`）を必ず考慮する。生成AI丸投げ方式では `DecisionContext.greatWarProximity`
// として必須で渡し（ユーザー要望：「世界のゲームオーバーは必ずAIへの丸投げ時は前提に入れる」）、
// 点数判断でも同じ値を使って開戦・同盟破棄系の選択肢の safety スコアを下げることで、
// 両方式で「無闇な開戦は破局を早める」という一貫したバイアスをかける。
//
// プレイヤーの勢力（`GameState.playerFactionId`）は自動決定の対象から常に除外する
// （傍観モード中にホスト勢力の行動までAIに委ねるかはUI層の選択に委ねる）。
//
// スコープの限定（設計書 12章、今後の課題）：外交フェイズの選択肢は、UIモックアップの
// 深さに合わせて「継続/和平」「宣戦/同盟提案/現状維持」「同盟維持/破棄」に限定し、
// 婚姻協定・人質提供・傭兵雇用交渉は現時点ではAIの自動判断対象に含めない
// （プレイヤーコマンドとしては `succession.ts`/`captivity.ts` に実装済み）。

/** 外交フェイズの意思決定における「世界情勢」共通コンテキスト。 */
function worldSituationSummary(proximity: number): string {
  return `大戦（世界同時多発戦争によるゲームオーバー）への近さ: ${Math.round(proximity * 100)}%`;
}

/** 2勢力間の軍事力比（自軍 / 相手軍、駐留兵含む）。1を超えるほど自軍優勢。 */
function militaryStrengthRatio(state: GameState, selfId: FactionId, counterpartId: FactionId): number {
  const strengthOf = (factionId: FactionId): number => {
    let total = 0;
    for (const army of Object.values(state.armies)) {
      if (army.faction === factionId) total += effectiveStrength(army);
    }
    for (const region of Object.values(state.regions)) {
      if (region.owner === factionId) total += region.garrison.count * region.garrison.training;
    }
    return total;
  };
  return strengthOf(selfId) / Math.max(1, strengthOf(counterpartId));
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/**
 * ある外交上の決定を適用した結果、その一手だけで大戦（世界のゲームオーバー）が
 * 発生してしまうかを判定する。個々のAIの選択肢スコアリングは「大戦への近さ」を
 * 徐々に safety へ織り込むだけの緩やかなバイアスに留まる（設計書 9.4）ため、
 * 小規模シナリオでは複数勢力の"局所的には合理的な"決定が同一ターン内で積み重なり、
 * 誰も意図せず大戦条件を満たしてしまうことがありうる。
 * これを避ける最終防波堤として、「自分のこの一手が単独で世界を終わらせる」場合に限り、
 * その決定を見送る（ユーザー要望：「世界のゲームオーバーは必ずAIへの丸投げ時は前提に入れる」の
 * 最も強い実装形。無条件の厭戦ではなく、まさに引き金を引く一手だけを拒否する）。
 */
function wouldSingleHandedlyTriggerGreatWar(state: GameState, candidateFactions: GameState["factions"]): boolean {
  return checkGreatWar({ ...state, factions: candidateFactions }).triggered;
}

interface DiplomaticOptionsResult {
  readonly stance: DiplomaticStance;
  readonly options: readonly DecisionOption[];
}

/**
 * 現在の外交状態（war/peace/alliance）に応じた選択肢を組み立てる（設計書 9.4）。
 * "vassal" 状態（宗主・臣下関係）は本パスでは自動判断の対象外（臣下側の反乱等は今後の課題）。
 * 相手が死亡している、または関係が未定義（`diplomacy` にキーがない）場合は null。
 */
function buildDiplomaticOptions(
  state: GameState,
  selfId: FactionId,
  counterpartId: FactionId,
  proximity: number,
): DiplomaticOptionsResult | null {
  const self = state.factions[selfId];
  const counterpart = state.factions[counterpartId];
  if (!self || !counterpart || !counterpart.alive) return null;
  const stance = self.diplomacy[counterpartId];
  if (stance === undefined || stance === "vassal") return null;

  const ratio = militaryStrengthRatio(state, selfId, counterpartId);

  if (stance === "war") {
    return {
      stance,
      options: [
        {
          label: "A",
          description: `${counterpart.name}との戦争を継続する`,
          safety: clamp01((ratio >= 1 ? 0.6 : 0.3) - proximity * 0.3),
          expansion: ratio >= 1 ? 0.8 : 0.3,
          profit: 0.3,
          legitimacy: 0.3,
        },
        {
          label: "B",
          description: `${counterpart.name}に和平を申し入れる`,
          safety: clamp01(0.7 + proximity * 0.3),
          expansion: 0.1,
          profit: 0.4,
          legitimacy: 0.6,
        },
      ],
    };
  }

  if (stance === "peace") {
    return {
      stance,
      options: [
        {
          label: "A",
          description: `${counterpart.name}に宣戦布告する`,
          safety: clamp01((ratio >= 2.0 ? 0.5 : 0.15) - proximity * 0.4),
          expansion: ratio >= 2.0 ? 0.85 : 0.3,
          profit: 0.3,
          legitimacy: 0.1,
        },
        {
          label: "B",
          description: `${counterpart.name}に同盟を提案する`,
          safety: 0.6,
          expansion: 0.3,
          profit: 0.3,
          legitimacy: 0.7,
        },
        {
          label: "C",
          description: `${counterpart.name}との和平を維持する`,
          safety: 0.8,
          expansion: 0.1,
          profit: 0.4,
          legitimacy: 0.6,
        },
      ],
    };
  }

  // stance === "alliance"
  return {
    stance,
    options: [
      {
        label: "A",
        description: `${counterpart.name}との同盟を維持する`,
        safety: 0.7,
        expansion: 0.3,
        profit: 0.4,
        legitimacy: 0.8,
      },
      {
        label: "B",
        description: `${counterpart.name}との同盟を破棄して開戦する`,
        safety: clamp01((ratio >= 2.2 ? 0.35 : 0.05) - proximity * 0.4),
        expansion: ratio >= 2.2 ? 0.8 : 0.15,
        profit: 0.3,
        legitimacy: 0.03,
      },
    ],
  };
}

/** 選択された外交選択肢を実際の外交状態遷移に変換する（現状維持を選んだ場合は変化なし）。 */
function applyDiplomaticChoice(
  factions: GameState["factions"],
  selfId: FactionId,
  counterpartId: FactionId,
  stance: DiplomaticStance,
  chosenLabel: string,
): GameState["factions"] {
  const self = factions[selfId];
  const counterpart = factions[counterpartId];
  if (!self || !counterpart) return factions;

  let newStance: DiplomaticStance | null = null;
  if (stance === "war" && chosenLabel === "B") newStance = "peace";
  else if (stance === "peace" && chosenLabel === "A") newStance = "war";
  else if (stance === "peace" && chosenLabel === "B") newStance = "alliance";
  else if (stance === "alliance" && chosenLabel === "B") newStance = "war";
  if (newStance === null) return factions;

  return {
    ...factions,
    [selfId]: { ...self, diplomacy: { ...self.diplomacy, [counterpartId]: newStance } },
    [counterpartId]: { ...counterpart, diplomacy: { ...counterpart.diplomacy, [selfId]: newStance } },
  };
}

/**
 * ある勢力について、まだこのターン処理されていない相手ごとに最善手を評価し、
 * 勢力全体としては最もスコアの高い1件だけを実行対象として選ぶ。
 * 「1年（1ターン）につき、外交上の大きな方針転換は1つまで」という抽象化により、
 * 同時多方面への宣戦布告のような不自然な暴走（史実にそぐわず、大戦条件も
 * 不用意に満たしてしまう）を避ける（設計書 9.4、要継続バランス調整）。
 */
function pickBestDiplomaticMove(
  state: GameState,
  selfId: FactionId,
  policy: Policy,
  proximity: number,
  processedPairs: Set<string>,
): { readonly counterpartId: FactionId; readonly stance: DiplomaticStance; readonly option: DecisionOption } | null {
  const self = state.factions[selfId];
  if (!self) return null;

  let best: { counterpartId: FactionId; stance: DiplomaticStance; option: DecisionOption; score: number } | null = null;
  for (const counterpartId of Object.keys(self.diplomacy) as FactionId[]) {
    const pairKey = [selfId, counterpartId].sort().join("|");
    if (processedPairs.has(pairKey)) continue;

    const built = buildDiplomaticOptions(state, selfId, counterpartId, proximity);
    if (!built) continue;
    const chosen = decideByScoring(policy, built.options);
    const score = scoreOption(chosen, policy);
    if (!best || score > best.score) best = { counterpartId, stance: built.stance, option: chosen, score };
  }
  return best;
}

/**
 * 外交フェイズ本体（同期・点数判断）。`Object.values` の列挙順で先に現れた勢力
 * （プレイヤー勢力は除外）から順に、`pickBestDiplomaticMove` で選んだ最善の1手だけを実行する。
 */
export function runDiplomacy(state: GameState, _options: TurnEngineOptions = {}): GameState {
  const proximity = greatWarProximity(state);
  let factions = state.factions;
  const processedPairs = new Set<string>();

  for (const self of Object.values(state.factions)) {
    if (self.type !== "lord" || !self.alive || self.ruler === null || self.id === state.playerFactionId) continue;
    const ruler = state.characters[self.ruler];
    if (!ruler) continue;

    const best = pickBestDiplomaticMove(state, self.id, ruler.policy, proximity, processedPairs);
    if (!best) continue;
    processedPairs.add([self.id, best.counterpartId].sort().join("|"));

    const candidateFactions = applyDiplomaticChoice(factions, self.id, best.counterpartId, best.stance, best.option.label);
    if (candidateFactions !== factions && wouldSingleHandedlyTriggerGreatWar(state, candidateFactions)) continue;
    factions = candidateFactions;
  }

  return { ...state, factions, phase: "action" };
}

/**
 * 外交フェイズ・生成AI丸投げ版（設計書 9.4 の "major decision" エスカレーション用）。
 * `runDiplomacy` と全く同じ選択肢・状態遷移ロジックを共有し、意思決定方式のみ
 * `decideAction`（LLM優先・失敗時は点数判断に自動フォールバック）に差し替える。
 * `DecisionContext.greatWarProximity` を必ず渡すため、生成AIの判断にも大戦接近度が
 * 常に反映される。
 */
export async function runDiplomacyAsync(
  state: GameState,
  aiConfig?: AIProviderConfig,
): Promise<GameState> {
  const proximity = greatWarProximity(state);
  let factions = state.factions;
  const processedPairs = new Set<string>();

  for (const self of Object.values(state.factions)) {
    if (self.type !== "lord" || !self.alive || self.ruler === null || self.id === state.playerFactionId) continue;
    const ruler = state.characters[self.ruler];
    if (!ruler) continue;

    // runDiplomacy と同じく「1ターンにつき1手」に絞る。相手ごとに生成AIへ問い合わせ、
    // 返ってきた選択肢群の中で最もスコアの高い1件だけを実行する。
    let best: { counterpartId: FactionId; stance: DiplomaticStance; option: DecisionOption; score: number } | null = null;
    for (const counterpartId of Object.keys(self.diplomacy) as FactionId[]) {
      const pairKey = [self.id, counterpartId].sort().join("|");
      if (processedPairs.has(pairKey)) continue;

      const built = buildDiplomaticOptions(state, self.id, counterpartId, proximity);
      if (!built) continue;
      const counterpart = state.factions[counterpartId]!;
      const context: DecisionContext = {
        actorRole: `${self.name}の君主`,
        summary: `${counterpart.name}との関係は現在「${built.stance}」。${worldSituationSummary(proximity)}`,
        greatWarProximity: proximity,
      };
      const chosen = await decideAction(context, built.options, ruler.policy, aiConfig);
      const score = scoreOption(chosen, ruler.policy);
      if (!best || score > best.score) best = { counterpartId, stance: built.stance, option: chosen, score };
    }

    if (best) {
      processedPairs.add([self.id, best.counterpartId].sort().join("|"));
      const candidateFactions = applyDiplomaticChoice(factions, self.id, best.counterpartId, best.stance, best.option.label);
      if (!(candidateFactions !== factions && wouldSingleHandedlyTriggerGreatWar(state, candidateFactions))) {
        factions = candidateFactions;
      }
    }
  }

  return { ...state, factions, phase: "action" };
}

// --- 行動フェイズ（軍団の移動・侵攻・退却・略奪） -----------------------------

type ArmyActionTarget =
  | { readonly kind: "hold" }
  | { readonly kind: "move"; readonly to: RegionId }
  | { readonly kind: "pillage" };

/**
 * 1軍団分の行動選択肢を組み立てる（設計書 9.4／12章：ArmyPanel.dc.html の
 * 移動/攻撃/退却/略奪コマンドに対応する自動判断版）。
 */
function buildActionOptions(
  state: GameState,
  army: Army,
  proximity: number,
): { readonly options: readonly DecisionOption[]; readonly targetsByLabel: ReadonlyMap<string, ArmyActionTarget> } {
  const region = state.regions[army.location];
  const selfFaction = state.factions[army.faction];
  if (!region || !selfFaction) return { options: [], targetsByLabel: new Map() };

  const options: DecisionOption[] = [];
  const targetsByLabel = new Map<string, ArmyActionTarget>();
  let labelIndex = 0;
  const nextLabel = (): string => String.fromCharCode(65 + labelIndex++);

  const holdLabel = nextLabel();
  options.push({ label: holdLabel, description: "現在地に留まり守りを固める", safety: 0.7, expansion: 0.1, profit: 0.2, legitimacy: 0.5 });
  targetsByLabel.set(holdLabel, { kind: "hold" });

  const selfStrength = effectiveStrength(army);

  for (const neighborId of region.adjacency) {
    const neighbor = state.regions[neighborId];
    if (!neighbor) continue;
    if (selfFaction.diplomacy[neighbor.owner] !== "war") continue;

    const defenderArmyStrength = Object.values(state.armies)
      .filter((a) => a.location === neighborId && a.faction === neighbor.owner)
      .reduce((sum, a) => sum + effectiveStrength(a), 0);
    const defenderStrength = defenderArmyStrength + neighbor.garrison.count * neighbor.garrison.training;
    const ratio = selfStrength / Math.max(1, defenderStrength);

    const label = nextLabel();
    options.push({
      label,
      description: `${neighbor.name}へ侵攻する`,
      safety: clamp01((ratio >= 1 ? 0.5 : 0.2) - proximity * 0.2),
      expansion: ratio >= 1 ? 0.9 : 0.4,
      profit: 0.4,
      legitimacy: 0.2,
    });
    targetsByLabel.set(label, { kind: "move", to: neighborId });
  }

  const hostileHereStrength = Object.values(state.armies)
    .filter((a) => a.location === army.location && a.faction !== army.faction && selfFaction.diplomacy[a.faction] === "war")
    .reduce((sum, a) => sum + effectiveStrength(a), 0);

  if (hostileHereStrength > selfStrength * 1.3) {
    const friendlyNeighbor = region.adjacency.map((id) => state.regions[id]).find((r) => r && r.owner === army.faction);
    if (friendlyNeighbor) {
      const label = nextLabel();
      options.push({
        label,
        description: `${friendlyNeighbor.name}へ退却する`,
        safety: 0.9,
        expansion: 0.05,
        profit: 0.1,
        legitimacy: 0.3,
      });
      targetsByLabel.set(label, { kind: "move", to: friendlyNeighbor.id });
    }
  }

  if (region.owner !== army.faction && selfFaction.diplomacy[region.owner] === "war" && hostileHereStrength === 0) {
    const label = nextLabel();
    options.push({ label, description: `${region.name}で略奪を行う`, safety: 0.6, expansion: 0.1, profit: 0.8, legitimacy: 0.05 });
    targetsByLabel.set(label, { kind: "pillage" });
  }

  return { options, targetsByLabel };
}

/** 略奪の効果：州の人口・税基盤をわずかに減らし、実行した勢力の国庫に戦利品を加える。 */
function applyPillage(state: GameState, region: Region, factionId: FactionId): GameState {
  const faction = state.factions[factionId];
  if (!faction) return state;
  const loot = Math.round(region.taxBase * 0.5);
  const updatedRegion: Region = {
    ...region,
    population: Math.round(region.population * 0.9),
    taxBase: Math.round(region.taxBase * 0.85),
  };
  return {
    ...state,
    regions: { ...state.regions, [region.id]: updatedRegion },
    factions: { ...state.factions, [factionId]: { ...faction, treasury: faction.treasury + loot } },
  };
}

/** 指揮官がいればその方針、いなければ勢力の君主の方針で代行する。どちらもいなければ null。 */
function effectivePolicyForArmy(state: GameState, army: Army) {
  if (army.commander) {
    const commander = state.characters[army.commander];
    if (commander) return commander.policy;
  }
  const faction = state.factions[army.faction];
  if (faction?.ruler) return state.characters[faction.ruler]?.policy ?? null;
  return null;
}

/** 行動フェイズ本体（同期・点数判断）。プレイヤー勢力の軍団は自動決定の対象外。 */
export function runAction(state: GameState, _options: TurnEngineOptions = {}): GameState {
  const proximity = greatWarProximity(state);
  let next = state;

  for (const army of Object.values(state.armies)) {
    if (army.faction === state.playerFactionId) continue;
    const faction = next.factions[army.faction];
    if (!faction || !faction.alive) continue;
    const policy = effectivePolicyForArmy(next, army);
    if (!policy) continue;

    const { options, targetsByLabel } = buildActionOptions(next, army, proximity);
    if (options.length === 0) continue;
    const chosen = decideByScoring(policy, options);
    const target = targetsByLabel.get(chosen.label);
    if (!target || target.kind === "hold") continue;

    if (target.kind === "move") {
      const current = next.armies[army.id];
      if (current) next = { ...next, armies: { ...next.armies, [army.id]: { ...current, location: target.to } } };
    } else {
      const region = next.regions[army.location];
      if (region) next = applyPillage(next, region, army.faction);
    }
  }

  return { ...next, phase: "battle_resolution" };
}

/**
 * 行動フェイズ・生成AI丸投げ版（`runDiplomacyAsync` と同じ位置づけ）。
 * 選択肢・状態遷移ロジックは `runAction` と共有し、意思決定方式のみ `decideAction` に差し替える。
 */
export async function runActionAsync(state: GameState, aiConfig?: AIProviderConfig): Promise<GameState> {
  const proximity = greatWarProximity(state);
  let next = state;

  for (const army of Object.values(state.armies)) {
    if (army.faction === state.playerFactionId) continue;
    const faction = next.factions[army.faction];
    if (!faction || !faction.alive) continue;
    const policy = effectivePolicyForArmy(next, army);
    if (!policy) continue;

    const { options, targetsByLabel } = buildActionOptions(next, army, proximity);
    if (options.length === 0) continue;
    const region = next.regions[army.location];
    const context: DecisionContext = {
      actorRole: army.commander ? "戦闘隊長" : `${faction.name}の君主（現地指揮官不在のため代行）`,
      summary: `${region?.name ?? "不明な州"}に駐留する軍団の行動を決める。${worldSituationSummary(proximity)}`,
      greatWarProximity: proximity,
    };
    const chosen = await decideAction(context, options, policy, aiConfig);
    const target = targetsByLabel.get(chosen.label);
    if (!target || target.kind === "hold") continue;

    if (target.kind === "move") {
      const current = next.armies[army.id];
      if (current) next = { ...next, armies: { ...next.armies, [army.id]: { ...current, location: target.to } } };
    } else if (region) {
      next = applyPillage(next, region, army.faction);
    }
  }

  return { ...next, phase: "battle_resolution" };
}

// --- ④ 戦闘解決フェイズ（設計書 3.7：多重戦闘・奇襲・挟撃） -------------------

/**
 * 州にいる敵対ペアを全て列挙する（互いに戦争状態にある異なる勢力の軍の組）。
 * 複数ペアが存在する場合、最も決着に大きな影響を持つ（実効兵力の合計が最大の）
 * ペアを優先する。3勢力以上が同じ州に居合わせた場合も、この関数を戦闘解決の
 * ループ内で繰り返し呼ぶことで「最大の衝突から逐次解決していく」処理になる。
 */
export function findMostConsequentialHostilePair(
  armiesInRegion: readonly Army[],
  state: GameState,
): readonly [Army, Army] | null {
  let best: readonly [Army, Army] | null = null;
  let bestStrength = -1;

  for (let i = 0; i < armiesInRegion.length; i++) {
    for (let j = i + 1; j < armiesInRegion.length; j++) {
      const a = armiesInRegion[i]!;
      const b = armiesInRegion[j]!;
      if (a.faction === b.faction) continue;
      if (state.factions[a.faction]?.diplomacy[b.faction] !== "war") continue;

      const combinedStrength = effectiveStrength(a) + effectiveStrength(b);
      if (combinedStrength > bestStrength) {
        best = [a, b];
        bestStrength = combinedStrength;
      }
    }
  }
  return best;
}

/**
 * 奇襲成立の判定（設計書 3.7）：
 * 攻撃側と同じ勢力の別の軍が、戦場に隣接する州に駐留しており、
 * その軍の指揮官の指揮能力が閾値以上であれば、事前に敵情を探り攻撃の
 * タイミングを整えたとみなし、奇襲が成立する。
 */
export function detectSurprise(attackerFaction: FactionId, region: Region, state: GameState): boolean {
  return region.adjacency.some((neighborId) =>
    Object.values(state.armies).some((army) => {
      if (army.faction !== attackerFaction || army.location !== neighborId || army.commander === null) return false;
      const commander = state.characters[army.commander];
      return (commander?.skills.command ?? 0) >= SURPRISE_COMMAND_THRESHOLD;
    }),
  );
}

/**
 * 挟撃成立の判定（設計書 3.7）：
 * 攻撃側と同じ勢力の別の軍が、この戦闘の起きている州そのものに同時に
 * 所在していれば、複数方向からの同時侵入とみなし挟撃が成立する。
 */
export function detectFlanking(attackerFaction: FactionId, attackerArmyId: Army["id"], region: Region, state: GameState): boolean {
  return Object.values(state.armies).some(
    (army) => army.faction === attackerFaction && army.location === region.id && army.id !== attackerArmyId,
  );
}

function runBattleResolution(state: GameState, options: TurnEngineOptions): GameState {
  const guards = options.guards;
  let next = state;

  const armiesByRegion = new Map<RegionId, Army[]>();
  for (const army of Object.values(state.armies)) {
    const list = armiesByRegion.get(army.location) ?? [];
    list.push(army);
    armiesByRegion.set(army.location, list);
  }

  for (const [regionId] of armiesByRegion) {
    // 同じ州で敵対ペアが尽きるまで、最大の衝突から逐次解決し続ける
    // （3勢力以上が同じ州に居合わせるケースにも対応する）。
    // MAX_ENCOUNTERS_PER_REGION は、練度0の軍同士など極端な入力で決着が
    // つかず無限ループになることを防ぐための安全弁（通常は数戦で決着する）。
    for (let encounter = 0; encounter < MAX_ENCOUNTERS_PER_REGION; encounter++) {
      const region = next.regions[regionId];
      if (!region) break;

      const liveArmies = Object.values(next.armies).filter((a) => a.location === regionId);
      const pair = findMostConsequentialHostilePair(liveArmies, next);
      if (!pair) break;

      const [a, b] = pair;
      // 州の領有者側を防御側として扱う（どちらも領有者でなければ a を攻撃側とする）。
      const [attackerArmy, defenderArmy] = region.owner === b.faction ? [a, b] : [b, a];

      const input: BattleResolutionInput = {
        turn: next.turn,
        region,
        regionsById: next.regions,
        attackerFaction: attackerArmy.faction,
        defenderFaction: defenderArmy.faction,
        attackerArmy,
        defenderArmy,
        attackerCommander: attackerArmy.commander ? (next.characters[attackerArmy.commander] ?? null) : null,
        defenderCommander: defenderArmy.commander ? (next.characters[defenderArmy.commander] ?? null) : null,
        surpriseAttacker: detectSurprise(attackerArmy.faction, region, next),
        flankingAttacker: detectFlanking(attackerArmy.faction, attackerArmy.id, region, next),
      };

      next = applyBattleOutcome(next, input, guards);
    }
  }

  return { ...next, phase: "year_end" };
}

// --- ⑤ 年末集計フェイズ（設計書 10章：税制・天候・地勢） ----------------------

function runYearEnd(state: GameState, options: TurnEngineOptions): GameState {
  const random = options.random ?? defaultRandomSource;
  let factions = state.factions;

  // 税収：州ごとに天候を抽選し、地勢アーキタイプ・戦争状態・疫病・包囲を加味した
  // 実効税収を領有勢力の国庫に加算する。
  for (const region of Object.values(state.regions)) {
    const owner = factions[region.owner];
    if (!owner) continue;
    const weatherFactor = rollWeatherFactor(random);
    const atWar = isAtWar(owner);
    // TODO: 疫病が局地的に発生している州の判定（現状は黒死病のような年表イベントのみが
    // taxBase を直接減衰させる形で反映されており、専用の "plagueActive" フラグは未実装）。
    const plagueActive = false;
    const tax = calculateEffectiveTax({ region, weatherFactor, atWar, plagueActive });
    factions = { ...factions, [owner.id]: { ...owner, treasury: owner.treasury + tax } };
  }

  // 維持費：州の駐留戦力と、勢力が抱える全軍団の兵数に応じて国庫から差し引く。
  for (const region of Object.values(state.regions)) {
    const owner = factions[region.owner];
    if (!owner) continue;
    factions = { ...factions, [owner.id]: { ...owner, treasury: owner.treasury - garrisonUpkeep(region) } };
  }
  for (const army of Object.values(state.armies)) {
    const owner = factions[army.faction];
    if (!owner) continue;
    factions = { ...factions, [army.faction]: { ...owner, treasury: owner.treasury - armyUpkeep(army) } };
  }

  const withEconomy: GameState = { ...state, factions };

  const warCheckResult = checkGreatWar(withEconomy);
  if (warCheckResult.triggered) {
    return { ...withEconomy, greatWarTriggered: true };
  }
  return { ...withEconomy, turn: withEconomy.turn + 1, year: withEconomy.year + 1, phase: "year_start" };
}

// --- 公開API ----------------------------------------------------------------

const PHASE_RUNNERS: Readonly<Record<TurnPhase, (state: GameState, options: TurnEngineOptions) => GameState>> = {
  year_start: runYearStart,
  diplomacy: runDiplomacy,
  action: runAction,
  battle_resolution: runBattleResolution,
  year_end: runYearEnd,
};

/** 現在のフェイズを1つだけ処理し、次のフェイズへ進める。 */
export function runPhase(state: GameState, options: TurnEngineOptions = {}): GameState {
  if (state.greatWarTriggered) return state;
  return PHASE_RUNNERS[state.phase](state, options);
}

/**
 * ちょうど1年分（呼び出し時点のフェイズから、次の年始フェイズに戻るまで）を処理する。
 * 大戦が発生した場合はその時点で停止する。
 */
export function advanceYear(state: GameState, options: TurnEngineOptions = {}): GameState {
  if (state.greatWarTriggered) return state;
  const startingYear = state.year;
  let next = state;
  do {
    next = runPhase(next, options);
    if (next.greatWarTriggered) break;
  } while (next.year === startingYear);
  return next;
}

/**
 * `advanceYear` の生成AI丸投げ版（設計書 13.1章の "major decision" エスカレーション）。
 * 年始・戦闘解決・年末集計フェイズは `advanceYear` と同じ同期処理を使い、
 * 外交・行動フェイズだけ `runDiplomacyAsync`/`runActionAsync`（`decideAction`：生成AI優先・
 * 失敗時は自動的に点数判断へフォールバック）に差し替える。1年ごとに外部LLMへ
 * 複数回問い合わせるため、`advanceYear` に比べて低速・低コストではない
 * （毎ターン使うのではなく、"major decision" と判断した局面での利用を想定）。
 */
export async function advanceYearAsync(
  state: GameState,
  aiConfig?: AIProviderConfig,
  options: TurnEngineOptions = {},
): Promise<GameState> {
  if (state.greatWarTriggered) return state;
  const startingYear = state.year;
  let next = state;
  do {
    if (next.phase === "diplomacy") next = await runDiplomacyAsync(next, aiConfig);
    else if (next.phase === "action") next = await runActionAsync(next, aiConfig);
    else next = runPhase(next, options);
    if (next.greatWarTriggered) break;
  } while (next.year === startingYear);
  return next;
}
