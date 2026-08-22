import type { BattleOutcome, CharacterId, FactionId, GameState, Region } from "../models/index.js";

/**
 * ⚠️ 捕虜・人質エンジン（草案・未バランス調整）
 * ============================================================
 * 設計書 5章の一次実装。身代金の算出式・獄死判定・併合強制の閾値は仮のロジックであり、
 * combatEngine / succession と同様に史実シナリオでの再演算を通じて調整していく前提。
 */

/** 身代金要求額の既定算出（仮値）。指揮能力が高いほど高額になる。 */
function defaultRansom(state: GameState, captiveId: CharacterId): number {
  const captive = state.characters[captiveId];
  if (!captive) return 0;
  return Math.round(500 + captive.skills.command * 1500);
}

/**
 * 戦闘解決の結果（BattleOutcome.capturedCommander）を受けて捕虜エントリを登録する。
 * 捕縛が発生していない場合は state をそのまま返す。
 */
export function registerCapture(state: GameState, outcome: BattleOutcome): GameState {
  const captiveId = outcome.capturedCommander;
  if (captiveId === null) return state;
  const captive = state.characters[captiveId];
  if (!captive) return state;

  const captor = outcome.kind === "occupation" ? outcome.attacker : outcome.defender;

  return {
    ...state,
    captivities: {
      ...state.captivities,
      [captiveId]: {
        captive: captiveId,
        captor,
        homeFaction: captive.faction,
        purpose: "war_captive",
        capturedTurn: outcome.turn,
        ransomDemand: defaultRansom(state, captiveId),
      },
    },
  };
}

/** 政治的人質を差し出す（服属・傀儡化条約の担保、設計書 5.3）。金銭のやり取りは発生しない。 */
export function offerHostage(
  state: GameState,
  homeFactionId: FactionId,
  captorFactionId: FactionId,
  hostageId: CharacterId,
  turn: number,
): GameState {
  const hostage = state.characters[hostageId];
  if (!hostage || hostage.faction !== homeFactionId) return state;

  return {
    ...state,
    captivities: {
      ...state.captivities,
      [hostageId]: {
        captive: hostageId,
        captor: captorFactionId,
        homeFaction: homeFactionId,
        purpose: "political_hostage",
        capturedTurn: turn,
        ransomDemand: 0,
      },
    },
  };
}

/**
 * 身代金を支払って釈放する（設計書 5.2）。political_hostage は対象外
 * （金銭ではなく条約遵守が対価のため、別途「返還」処理を用いる）。
 * 元の勢力の財力が不足している場合は何もしない。
 */
export function payRansom(state: GameState, captiveId: CharacterId): GameState {
  const captivity = state.captivities[captiveId];
  if (!captivity || captivity.purpose !== "war_captive") return state;

  const homeFaction = state.factions[captivity.homeFaction];
  const captorFaction = state.factions[captivity.captor];
  if (!homeFaction || !captorFaction || homeFaction.treasury < captivity.ransomDemand) return state;

  const { [captiveId]: _removed, ...remainingCaptivities } = state.captivities;

  return {
    ...state,
    captivities: remainingCaptivities,
    factions: {
      ...state.factions,
      [homeFaction.id]: { ...homeFaction, treasury: homeFaction.treasury - captivity.ransomDemand },
      [captorFaction.id]: { ...captorFaction, treasury: captorFaction.treasury + captivity.ransomDemand },
    },
  };
}

/**
 * 捕虜を寝返らせて自軍の戦闘隊長として登用する（傭兵経済の入口、設計書 5.2）。
 * 身代金交渉と排他的：登用した場合は身代金は得られない。
 */
export function recruitCaptive(state: GameState, captiveId: CharacterId): GameState {
  const captivity = state.captivities[captiveId];
  const captive = state.characters[captiveId];
  if (!captivity || !captive) return state;

  const captorFaction = state.factions[captivity.captor];
  const homeFaction = state.factions[captivity.homeFaction];
  if (!captorFaction) return state;

  const { [captiveId]: _removed, ...remainingCaptivities } = state.captivities;

  return {
    ...state,
    captivities: remainingCaptivities,
    characters: {
      ...state.characters,
      [captiveId]: { ...captive, faction: captorFaction.id, role: "warlord" },
    },
    factions: {
      ...state.factions,
      [captorFaction.id]: { ...captorFaction, warlords: [...captorFaction.warlords, captiveId] },
      ...(homeFaction
        ? { [homeFaction.id]: { ...homeFaction, warlords: homeFaction.warlords.filter((id) => id !== captiveId) } }
        : {}),
    },
  };
}

/**
 * 敵の王族（君主・後継者）の大半が捕虜になっているか（設計書 5.4）。
 * 併合・傀儡化の強制コマンドの前提条件として使う。
 */
export function canForceSubjugation(state: GameState, captorFactionId: FactionId, targetFactionId: FactionId): boolean {
  const target = state.factions[targetFactionId];
  if (!target || target.ruler === null) return false;

  const isCaptiveOf = (id: CharacterId | null): boolean =>
    id !== null && state.captivities[id]?.captor === captorFactionId;

  const rulerCaptive = isCaptiveOf(target.ruler);
  const heirCaptive = target.heir === null || isCaptiveOf(target.heir);
  return rulerCaptive && heirCaptive;
}

/** 傀儡化を強制する（設計書 5.4）。`canForceSubjugation` の成立を前提とする。 */
export function forceVassalization(state: GameState, captorFactionId: FactionId, targetFactionId: FactionId): GameState {
  if (!canForceSubjugation(state, captorFactionId, targetFactionId)) return state;
  const target = state.factions[targetFactionId]!;
  const captor = state.factions[captorFactionId];
  if (!captor) return state;

  return {
    ...state,
    factions: {
      ...state.factions,
      [targetFactionId]: { ...target, diplomacy: { ...target.diplomacy, [captorFactionId]: "vassal" } },
      [captorFactionId]: { ...captor, diplomacy: { ...captor.diplomacy, [targetFactionId]: "vassal" } },
    },
  };
}

/**
 * 併合を強制する（設計書 5.4）。`canForceSubjugation` の成立を前提とする。
 * 対象勢力の州をすべて捕らえた勢力に編入し、対象勢力は消滅する。
 */
export function forceAnnexation(state: GameState, captorFactionId: FactionId, targetFactionId: FactionId): GameState {
  if (!canForceSubjugation(state, captorFactionId, targetFactionId)) return state;
  const target = state.factions[targetFactionId]!;
  const captor = state.factions[captorFactionId];
  if (!captor) return state;

  const updatedRegions: Record<string, Region> = {};
  for (const regionId of target.regions) {
    const region = state.regions[regionId];
    if (region) updatedRegions[regionId] = { ...region, owner: captorFactionId };
  }

  const updatedArmies = { ...state.armies };
  for (const army of Object.values(state.armies)) {
    if (army.faction === targetFactionId) updatedArmies[army.id] = { ...army, faction: captorFactionId };
  }

  return {
    ...state,
    regions: { ...state.regions, ...updatedRegions },
    armies: updatedArmies,
    factions: {
      ...state.factions,
      [captorFactionId]: { ...captor, regions: [...captor.regions, ...target.regions] },
      [targetFactionId]: { ...target, alive: false, ruler: null, heir: null, regions: [] },
    },
  };
}
