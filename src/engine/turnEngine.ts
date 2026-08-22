import { totalTroops, type Army } from "../models/army.js";
import type { CasualtyReport } from "../models/battle.js";
import type { GameState, RegionId, TurnPhase } from "../models/index.js";
import { registerCapture } from "./captivity.js";
import type { CausalityGuardRegistry } from "./causalityGuard.js";
import { resolveBattle, type BattleResolutionInput } from "./combatEngine.js";
import { findEscapeRegion } from "./combatEngine.js";
import { applySuccession } from "./succession.js";
import { checkGreatWar } from "./warCheck.js";

/**
 * ⚠️ ターンエンジン（草案）
 * ============================================================
 * 設計書 1.1 の5フェイズ（年始→外交→行動→戦闘解決→年末集計）を実際に回す
 * オーケストレーション層。combatEngine / succession / captivity / warCheck を
 * 1つの `advanceYear` にまとめ、ゲームを実際に前進させられる状態にする。
 *
 * 外交フェイズ・行動フェイズは AI・プレイヤー入力が未実装のため現状スタブ
 * （フェイズを進めるだけ）。設計書 9章の「AI勢力の意思決定ロジック」に対応する。
 * 戦闘解決フェイズは「同一州に敵対勢力の軍がいれば1戦だけ解決する」という
 * 簡略化を行っている（同一州で複数の遭遇戦が同時発生するケースは今後の課題）。
 */

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

function runYearStart(state: GameState): GameState {
  let next = state;
  for (const faction of Object.values(state.factions)) {
    if (!faction.alive || faction.ruler === null) continue;
    const ruler = next.characters[faction.ruler];
    if (ruler && !ruler.alive) {
      next = applySuccession(next, ruler.id, faction.id);
    }
  }
  // TODO: 疫病・宗教などのランダムイベント抽選（EventEngine、設計書 9章）
  return { ...next, phase: "diplomacy" };
}

// --- ② 外交フェイズ・③ 行動フェイズ（スタブ） --------------------------------

function runDiplomacy(state: GameState): GameState {
  // TODO: AI/プレイヤーの宣戦布告・同盟・婚姻協定・傭兵契約コマンド
  return { ...state, phase: "action" };
}

function runAction(state: GameState): GameState {
  // TODO: AI/プレイヤーの軍団移動・攻撃指示・人材登用・後継指定/養子縁組コマンド
  return { ...state, phase: "battle_resolution" };
}

// --- ④ 戦闘解決フェイズ ------------------------------------------------------

function findHostileArmyPair(
  armiesInRegion: readonly Army[],
  state: GameState,
): readonly [Army, Army] | null {
  for (let i = 0; i < armiesInRegion.length; i++) {
    for (let j = i + 1; j < armiesInRegion.length; j++) {
      const a = armiesInRegion[i]!;
      const b = armiesInRegion[j]!;
      if (a.faction === b.faction) continue;
      if (state.factions[a.faction]?.diplomacy[b.faction] === "war") return [a, b];
    }
  }
  return null;
}

function runBattleResolution(state: GameState, guards: CausalityGuardRegistry | undefined): GameState {
  let next = state;

  const armiesByRegion = new Map<RegionId, Army[]>();
  for (const army of Object.values(state.armies)) {
    const list = armiesByRegion.get(army.location) ?? [];
    list.push(army);
    armiesByRegion.set(army.location, list);
  }

  for (const [regionId, armiesHere] of armiesByRegion) {
    if (armiesHere.length < 2) continue;
    // 州単位で「今も存在する（前段の戦闘で消えていない）」軍だけを対象にする。
    const liveArmies = armiesHere
      .map((a) => next.armies[a.id])
      .filter((a): a is Army => a !== undefined);
    const pair = findHostileArmyPair(liveArmies, next);
    if (!pair) continue;

    const region = next.regions[regionId];
    if (!region) continue;
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
    };

    next = applyBattleOutcome(next, input, guards);
  }

  return { ...next, phase: "year_end" };
}

// --- ⑤ 年末集計フェイズ ------------------------------------------------------

function runYearEnd(state: GameState): GameState {
  // TODO: 税収・維持費の計算（設計書 9章）
  const warCheckResult = checkGreatWar(state);
  if (warCheckResult.triggered) {
    return { ...state, greatWarTriggered: true };
  }
  return { ...state, turn: state.turn + 1, year: state.year + 1, phase: "year_start" };
}

// --- 公開API ----------------------------------------------------------------

const PHASE_RUNNERS: Readonly<Record<TurnPhase, (state: GameState, guards?: CausalityGuardRegistry) => GameState>> = {
  year_start: runYearStart,
  diplomacy: runDiplomacy,
  action: runAction,
  battle_resolution: runBattleResolution,
  year_end: runYearEnd,
};

/** 現在のフェイズを1つだけ処理し、次のフェイズへ進める。 */
export function runPhase(state: GameState, guards?: CausalityGuardRegistry): GameState {
  if (state.greatWarTriggered) return state;
  return PHASE_RUNNERS[state.phase](state, guards);
}

/**
 * ちょうど1年分（呼び出し時点のフェイズから、次の年始フェイズに戻るまで）を処理する。
 * 大戦が発生した場合はその時点で停止する。
 */
export function advanceYear(state: GameState, guards?: CausalityGuardRegistry): GameState {
  if (state.greatWarTriggered) return state;
  const startingYear = state.year;
  let next = state;
  do {
    next = runPhase(next, guards);
    if (next.greatWarTriggered) break;
  } while (next.year === startingYear);
  return next;
}
