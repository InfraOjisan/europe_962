import type { CharacterId, FactionId, GameState } from "../models/index.js";
import { findWithinDegree, MAX_CLAIM_DEGREE } from "./kinship.js";

/**
 * ⚠️ プレイヤーのゲームオーバー判定・再起処理（草案）
 * ============================================================
 * 設計書 6.2。「世界のゲームオーバー」（大戦、`warCheck.ts`）とは別に、
 * プレイヤー自身の勢力に起きる2種類のゲームオーバーを扱う。
 *
 * - capitulation（降伏／降参／臣従）：敗退時に退却先の州がない、または捕虜・人質を
 *   介した服属強制（`captivity.ts` の `forceVassalization`）を受けた状態。
 *   選択肢：①そのまま終了、②併合先／宗主勢力（`SpectatorState.hostFactionId`）の
 *   視点で歴史を「傍観」し続ける。傍観中にホスト勢力が後継者なし・滅亡した場合は
 *   「再起チャンス」（`checkComebackOpportunity`/`reclaimIndependence`）が生まれる。
 *   傍観をあきらめて終了することもできる（`giveUpSpectating`）。
 * - annihilation（滅亡）：戦闘で一族が全滅した状態。
 *   選択肢：①そのまま終了、②姻戚関係にある最も血縁の近い、現存する領主（他家当主）
 *   として再開する（`findClosestSurvivingRuler`/`restartAsClosestKin`）。
 *
 * このモジュールは状態遷移の純粋関数のみを提供する。実際に「終了/傍観/再起」の
 * どれを選ぶかはUI層（プレイヤー入力）の責務であり、ここでは判定できない
 * （＝「そのまま終了」を選んだ場合はこのモジュールの関数を何も呼ばなくてよい）。
 */

export type PlayerGameOverKind = "capitulation" | "annihilation";
export type CapitulationReason = "surrender" | "vassalized";

export interface PlayerGameOverEvaluation {
  readonly kind: PlayerGameOverKind | null;
  /** kind が "capitulation" の場合のみ設定。 */
  readonly capitulationReason?: CapitulationReason;
}

function factionMembers(state: GameState, factionId: FactionId) {
  return Object.values(state.characters).filter((c) => c.faction === factionId);
}

/**
 * `state.playerFactionId` に対してプレイヤーのゲームオーバー条件が成立しているか判定する。
 * 年末集計フェイズ後などに毎ターン呼び出す想定。プレイヤー不在（`playerFactionId === null`）の
 * 場合や、まだ何のゲームオーバー条件も満たしていない場合は `{ kind: null }` を返す。
 */
export function evaluatePlayerGameOver(state: GameState): PlayerGameOverEvaluation {
  if (state.playerFactionId === null) return { kind: null };
  const faction = state.factions[state.playerFactionId];
  if (!faction) return { kind: null };

  // 滅亡：この勢力に所属する（＝所属していた）人物が1人以上存在し、その全員が死亡している。
  const members = factionMembers(state, faction.id);
  if (members.length > 0 && members.every((c) => !c.alive)) {
    return { kind: "annihilation" };
  }

  // 臣従：捕虜・人質を介した服属強制（forceVassalization）により宗主を持つに至った。
  if (faction.alive && faction.suzerain !== null) {
    return { kind: "capitulation", capitulationReason: "vassalized" };
  }

  // 降伏／降参：敗退により州も軍団も失い、退却先がない状態で存続している
  // （併合〈forceAnnexation〉で faction.alive が false になった場合も同様に扱う）。
  const hasNoTerritory = faction.regions.length === 0;
  const hasNoArmies = !Object.values(state.armies).some((a) => a.faction === faction.id);
  if ((!faction.alive || (hasNoTerritory && hasNoArmies)) && faction.suzerain === null) {
    return { kind: "capitulation", capitulationReason: "surrender" };
  }

  return { kind: null };
}

/**
 * 「傍観」を選んだ場合の状態遷移。`hostFactionId` は併合先／宗主勢力。
 * `state.playerFactionId` は記録として維持する（元の勢力IDを覚えておくことで、
 * 再起チャンス成立時にどの家系を再興するのか分かるようにするため）。
 */
export function enterSpectatorMode(
  state: GameState,
  hostFactionId: FactionId,
  reason: "surrender" | "vassalized" | "annexed",
): GameState {
  if (state.playerFactionId === null) return state;
  return {
    ...state,
    spectator: {
      hostFactionId,
      reason,
      since: state.year,
      originalFactionId: state.playerFactionId,
    },
  };
}

/** 傍観をあきらめて終了する。 */
export function giveUpSpectating(state: GameState): GameState {
  if (state.spectator === null) return state;
  return { ...state, spectator: null, playerFactionId: null };
}

/**
 * 傍観中、ホスト勢力（併合先／宗主）が後継者なし・滅亡した場合に「再起チャンス」が
 * 生まれる（ユーザー要望：「傍観時に他国が後継者なし・滅亡した場合に再起チャンスあり」）。
 */
export function checkComebackOpportunity(state: GameState): boolean {
  if (state.spectator === null) return false;
  const host = state.factions[state.spectator.hostFactionId];
  if (!host) return true; // ホスト自体が消滅（さらに別勢力へ吸収される等）
  return !host.alive || host.ruler === null;
}

/**
 * 再起チャンスを行使し、元の勢力を独立させて復帰する。元の勢力が併合により消滅している
 * 場合（`forceAnnexation` 済み等）はこの方法では復帰できない
 * （`restartAsClosestKin` の対象になる滅亡ケースとは異なる）。
 */
export function reclaimIndependence(state: GameState): GameState {
  if (state.spectator === null || !checkComebackOpportunity(state)) return state;
  const { originalFactionId, hostFactionId } = state.spectator;
  const original = state.factions[originalFactionId];
  if (!original || !original.alive) return state;

  return {
    ...state,
    playerFactionId: originalFactionId,
    spectator: null,
    factions: {
      ...state.factions,
      [originalFactionId]: {
        ...original,
        suzerain: null,
        diplomacy: { ...original.diplomacy, [hostFactionId]: "peace" },
      },
    },
  };
}

export interface SurvivingKinCandidate {
  readonly factionId: FactionId;
  readonly characterId: CharacterId;
  /** 滅亡した家系のメンバーからの最短親等。 */
  readonly degree: number;
}

/**
 * 滅亡した勢力の元メンバーから見て最も血縁の近い、現存する他家当主（領主）を探す。
 * `kinship.ts` の血族ネットワークBFSをそのまま流用する（後継者危機の claimant 探索と同じ考え方）。
 * 該当者がいなければ null（＝「姻戚のある再起先がない」ので終了のみが選択肢になる）。
 */
export function findClosestSurvivingRuler(state: GameState, extinctFactionId: FactionId): SurvivingKinCandidate | null {
  const extinctMembers = factionMembers(state, extinctFactionId);
  if (extinctMembers.length === 0) return null;

  let best: SurvivingKinCandidate | null = null;
  for (const member of extinctMembers) {
    const within = findWithinDegree(member.id, MAX_CLAIM_DEGREE, state.characters);
    for (const [candidateId, degree] of within) {
      const candidate = state.characters[candidateId];
      if (!candidate || !candidate.alive || candidate.role !== "ruler") continue;
      const faction = state.factions[candidate.faction];
      if (!faction || !faction.alive || faction.ruler !== candidate.id || faction.id === extinctFactionId) continue;
      if (!best || degree < best.degree) {
        best = { factionId: faction.id, characterId: candidate.id, degree };
      }
    }
  }
  return best;
}

/**
 * 滅亡した勢力から、最も血縁の近い現存する他家当主の勢力としてプレイヤーの操作対象を
 * 切り替える。姻戚関係にある再起先が見つからない場合は state をそのまま返す
 * （呼び出し側は戻り値が変化していないことをもって「再起不可・終了のみ」と判断できる）。
 */
export function restartAsClosestKin(state: GameState, extinctFactionId: FactionId): GameState {
  const found = findClosestSurvivingRuler(state, extinctFactionId);
  if (!found) return state;
  return { ...state, playerFactionId: found.factionId, spectator: null };
}
