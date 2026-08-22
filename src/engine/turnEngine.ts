import { effectiveStrength, totalTroops, type Army } from "../models/army.js";
import type { CasualtyReport } from "../models/battle.js";
import { isAtWar } from "../models/faction.js";
import type { FactionId, GameState, Region, RegionId, TurnPhase } from "../models/index.js";
import type { RandomSource } from "./aiPolicy.js";
import { defaultRandomSource } from "./aiPolicy.js";
import { registerCapture } from "./captivity.js";
import type { CausalityGuardRegistry } from "./causalityGuard.js";
import { resolveBattle, type BattleResolutionInput } from "./combatEngine.js";
import { findEscapeRegion } from "./combatEngine.js";
import { armyUpkeep, calculateEffectiveTax, garrisonUpkeep, rollWeatherFactor } from "./economy.js";
import { applyYearStartEvents } from "./eventEngine.js";
import type { HistoricalEvent } from "../data/historicalEvents.js";
import { applySuccession } from "./succession.js";
import { checkGreatWar } from "./warCheck.js";

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
 * - random:  天候抽選（10.2章）などに使う乱数源。省略時は `Math.random`。
 * - events:  年始フェイズで適用する史実イベント年表（11章）。省略時は全イベント有効、
 *            空配列を渡せば無効化できる。
 */
export interface TurnEngineOptions {
  readonly guards?: CausalityGuardRegistry;
  readonly random?: RandomSource;
  readonly events?: readonly HistoricalEvent[];
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
  // TODO: 疫病（黒死病以外の局地的な発生）・宗教などのランダムイベント抽選
  return { ...next, phase: "diplomacy" };
}

// --- ② 外交フェイズ・③ 行動フェイズ（スタブ） --------------------------------

function runDiplomacy(state: GameState): GameState {
  // TODO: AI/プレイヤーの宣戦布告・同盟・婚姻協定・傭兵契約コマンド（aiPolicy.ts / aiProvider.ts を利用する想定）
  return { ...state, phase: "action" };
}

function runAction(state: GameState): GameState {
  // TODO: AI/プレイヤーの軍団移動・攻撃指示・人材登用・後継指定/養子縁組コマンド
  return { ...state, phase: "battle_resolution" };
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
