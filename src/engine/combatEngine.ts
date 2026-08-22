import { effectiveStrength, totalTroops, type Army, type DoctrineId, type UnitType } from "../models/army.js";
import type { BattleOutcome, CasualtyReport } from "../models/battle.js";
import type { Character } from "../models/character.js";
import type { FactionId } from "../models/ids.js";
import type { Region } from "../models/region.js";

/**
 * ⚠️ 戦闘解決エンジン（草案・継続チューニング対象）
 * ============================================================
 * このファイルは設計書 3章の演算モデルを「動く形」に落とした実装であり、
 * 係数はすべて史実シナリオ（`combatEngine.historical.test.ts`）で検証しながら
 * 継続的にチューニングする対象。値そのものを最終確定とは考えないこと。
 *
 * 検証プロセス（README/設計書と対応）:
 *   1. 既知の史実の戦役・戦争をシナリオ化し、このエンジンで再演算する
 *      → `combatEngine.historical.test.ts`
 *   2. 結果（占領/退却/降伏の分布、被害規模）が史実と乖離する場合、
 *      まず係数・閾値の調整で説明できないか試す
 *   3. 調整しても再現不能な事象（例: 特定の会戦の結果が確率的に起こりにくい）は、
 *      「強制イベント」（因果律の保護 = Causality Guard）として
 *      戦闘演算の外側でシナリオ的に補正する → `causalityGuard.ts`
 */

/** 戦術洗練度係数テーブル（仮値）。時代・編成ごとの相対的な強さを表す。 */
const DOCTRINE_COEFFICIENT: Readonly<Record<DoctrineId, number>> = {
  default: 1.0,
  swiss_pike: 1.25,
  english_longbow: 1.2,
  polish_hussar: 1.2,
  cossack_raiders: 1.1,
  norman_knights: 1.15,
  napoleonic_corps: 1.4,
};

/** ラウンド数上限。これを超えても未決着なら inconclusive とする。 */
export const MAX_BATTLE_ROUNDS = 3;

/** 敗走判定の閾値（稼働兵力比、仮値）。 */
const BREAK_STRENGTH_RATIO = 0.4;
/** 敗走判定の閾値（戦意、仮値）。 */
const BREAK_MORALE_THRESHOLD = 0.25;

/** 指揮官不在の場合の不利補正（army.ts のコメント通り、戦術洗練度・統率に不利がかかる）。 */
const NO_COMMANDER_PENALTY = 0.8;
/** 指揮能力(0〜1)による補正の振れ幅。command=0 で 0.85倍、command=1 で 1.15倍。 */
const COMMAND_SKILL_MIN = 0.85;
const COMMAND_SKILL_RANGE = 0.3;
/** 指揮官特性が軍の主力兵科・状況と噛み合っている場合のボーナス。 */
const COMMANDER_SPECIALIST_BONUS = 1.15;

/** 騎兵の平地突撃ボーナス／悪地形ペナルティ（仮値）。 */
const CAVALRY_PLAIN_BONUS = 1.3;
const CAVALRY_ROUGH_TERRAIN_PENALTY = 0.7;
/** 騎兵 vs 密集槍兵：突撃が阻まれる反転（設計書 3.1 の例）。 */
const CAVALRY_VS_PIKE_PENALTY = 0.6;
/** 騎兵 vs 砲兵：展開・再装填の隙を突いて蹴散らす（弓兵は含まない。弓兵は下記の対騎兵ボーナスで優位）。 */
const CAVALRY_VS_SKIRMISHER_BONUS = 1.3;

/** 弓兵の基本レンジ・アドバンテージ（仮値）。 */
const ARCHER_RANGED_BONUS = 1.2;
/** 弓兵 vs 騎兵：チャージを射抜く（クレシー/アジャンクール的な反転）。 */
const ARCHER_VS_CAVALRY_BONUS = 1.4;
/** 森林での弓兵不利（設計書 3.1 の例）：視界・機動が制限されレンジの優位が消える。 */
const ARCHER_FOREST_PENALTY = 0.75;

/** 奇襲補正：隣接州に有能な指揮官を伴う自軍がいて先制条件を満たす場合、初撃のみ有効（仮値）。 */
const SURPRISE_BONUS = 1.2;
/** 挟撃補正：複数方向から同時侵入した味方軍がいる場合、全ラウンドで有効（仮値）。 */
const FLANKING_BONUS = 1.15;

/**
 * 城塞化された州で防御する場合のボーナス（設計書 3.4）。持久戦（包囲）本体のルールとは別に、
 * 野戦の戦闘力にも防御側有利として反映する（フス派のワゴンブルクのような野戦築城も
 * `fortified` を流用して表現できる）。
 */
const FORTIFIED_DEFENSE_BONUS = 1.25;

export type CombatSide = "attack" | "defense";

/** 軍の中で最も兵数の多い兵科（同数の場合は units 配列の先頭を優先）。兵がいなければ null。 */
export function dominantUnitType(army: Army): UnitType | null {
  let best: { type: UnitType; count: number } | null = null;
  for (const unit of army.units) {
    if (!best || unit.count > best.count) best = { type: unit.type, count: unit.count };
  }
  return best && best.count > 0 ? best.type : null;
}

/**
 * 騎兵・弓兵の地形・兵科相性による状況補正（設計書 3.1）。
 * 「騎兵、弓でない限り軍の戦闘力で決まる」（gamesystem_europe.md）に対応し、
 * pike/infantry/artillery が主力の場合は 1.0（補正なし）とする。
 */
export function situationalModifier(army: Army, opponent: Army, region: Region): number {
  const mine = dominantUnitType(army);
  const theirs = dominantUnitType(opponent);
  if (mine === null) return 1.0;

  const terrain = region.terrain;
  let modifier = 1.0;

  if (mine === "cavalry") {
    if (terrain === "plain") modifier *= CAVALRY_PLAIN_BONUS;
    if (terrain === "forest" || terrain === "mountain") modifier *= CAVALRY_ROUGH_TERRAIN_PENALTY;
    if (theirs === "pike") modifier *= CAVALRY_VS_PIKE_PENALTY;
    if (theirs === "artillery") modifier *= CAVALRY_VS_SKIRMISHER_BONUS;
    // 野戦築城（ワゴンブルク等）や城塞も、密集槍兵と同様に騎兵突撃を阻む。
    if (region.fortified) modifier *= CAVALRY_VS_PIKE_PENALTY;
  }

  if (mine === "archer") {
    modifier *= terrain === "forest" ? ARCHER_FOREST_PENALTY : ARCHER_RANGED_BONUS;
    if (theirs === "cavalry" && terrain !== "forest") modifier *= ARCHER_VS_CAVALRY_BONUS;
  }

  return modifier;
}

function matchesSpecialistTrait(commander: Character, army: Army, region: Region): boolean {
  const dominant = dominantUnitType(army);
  if (commander.traits.includes("cavalry_specialist") && dominant === "cavalry") return true;
  if (commander.traits.includes("infantry_specialist") && (dominant === "pike" || dominant === "infantry")) return true;
  if (commander.traits.includes("archery_specialist") && dominant === "archer") return true;
  if (commander.traits.includes("siege_specialist") && region.fortified) return true;
  return false;
}

/**
 * 指揮官による補正。指揮官不在なら不利補正のみ（Character 情報がなくても算出可）。
 * Character オブジェクトが渡された場合は指揮能力・特性による追加補正を加える。
 */
function commanderFactor(hasCommander: boolean, commander: Character | null, army: Army, region: Region): number {
  if (!hasCommander) return NO_COMMANDER_PENALTY;
  if (!commander) return 1.0; // 指揮官はいるが詳細不明（呼び出し側が Character を渡さなかった）
  const skillFactor = COMMAND_SKILL_MIN + commander.skills.command * COMMAND_SKILL_RANGE;
  const specialistFactor = matchesSpecialistTrait(commander, army, region) ? COMMANDER_SPECIALIST_BONUS : 1.0;
  return skillFactor * specialistFactor;
}

/**
 * 軍の戦闘力(CP)を算出する。
 *   CP = Σ(兵科ごとの 兵数 × 練度) × 戦術洗練度係数 × 指揮官補正 × 状況補正（地形・兵科相性） × 士気 × 補給
 */
export function combatPower(
  army: Army,
  opponent: Army,
  region: Region,
  side: CombatSide,
  commander: Character | null = null,
): number {
  const base = effectiveStrength(army);
  const doctrineCoefficient = DOCTRINE_COEFFICIENT[army.doctrine] ?? DOCTRINE_COEFFICIENT["default"]!;
  const terrainModifier = side === "attack" ? region.terrainModifier.attack : region.terrainModifier.defense;
  const fortifiedDefenseFactor = side === "defense" && region.fortified ? FORTIFIED_DEFENSE_BONUS : 1.0;
  const moraleFactor = 0.5 + army.morale * 0.5; // 士気ゼロでも半分の力は出る、という仮モデル
  const supplyFactor = 0.5 + army.supply * 0.5; // 同上、補給切れでも壊滅はしない仮モデル
  const commanderMod = commanderFactor(army.commander !== null, commander, army, region);
  const situational = situationalModifier(army, opponent, region);

  return (
    base *
    doctrineCoefficient *
    commanderMod *
    situational *
    terrainModifier *
    fortifiedDefenseFactor *
    moraleFactor *
    supplyFactor
  );
}

/**
 * その軍が「敗走」判定の対象になっているか（稼働兵力・戦意のいずれかが閾値未満）。
 *
 * 稼働兵力は「開戦時の兵数に対する現在の残存兵数の割合」で測る。
 * effectiveStrength（練度加重の兵数）を現在の兵数で割ると常に練度そのものに
 * 一致してしまい（count*training / count = training）、損耗を全く反映しない
 * 静的な指標になってしまうため、必ず `startingTroops`（開戦時点の総兵数）を
 * 基準に減少率を測る。
 */
export function isBroken(army: Army, startingTroops: number): boolean {
  const remainingRatio = startingTroops === 0 ? 0 : totalTroops(army) / startingTroops;
  return remainingRatio < BREAK_STRENGTH_RATIO || army.morale < BREAK_MORALE_THRESHOLD;
}

/**
 * 退路が確保されているか。
 * TODO(balance): 現状は「隣接する自勢力領があるか」のみで判定する簡易版。
 * 包囲されている場合や、隣接州がすべて敵対勢力の場合は false になり降伏に分岐する。
 */
export function hasEscapeRoute(
  loserFaction: FactionId,
  region: Region,
  regionsById: Readonly<Record<string, Region>>,
): boolean {
  return findEscapeRegion(loserFaction, region, regionsById) !== null;
}

/** 退路として実際に退却する先の州IDを返す（設計書 3.3「退却」の後処理で TurnEngine が使う）。 */
export function findEscapeRegion(
  loserFaction: FactionId,
  region: Region,
  regionsById: Readonly<Record<string, Region>>,
): Region["id"] | null {
  const neighborId = region.adjacency.find((id) => regionsById[id]?.owner === loserFaction);
  return neighborId ?? null;
}

function applyCasualties(army: Army, lossRate: number): { army: Army; report: Pick<CasualtyReport, "killed"> } {
  const clampedRate = Math.max(0, Math.min(1, lossRate));
  let killed = 0;
  const units = army.units.map((u) => {
    const lost = Math.round(u.count * clampedRate);
    killed += lost;
    return { ...u, count: Math.max(0, u.count - lost) };
  });
  return { army: { ...army, units }, report: { killed } };
}

/**
 * 劣勢側の損耗率を算出する（仮モデル）。
 * 戦闘力比が拮抗するほど損耗は小さく、一方的であるほど大きくなる。
 */
function lossRate(ratio: number): number {
  // ratio: 自軍が劣勢である度合い（0=互角、1=完全劣勢）を 0..1 として受け取る想定
  return 0.05 + ratio * 0.2; // TODO(balance): 仮の一次関数。史実再現度を見て調整する。
}

export interface BattleResolutionInput {
  readonly turn: number;
  readonly region: Region;
  readonly regionsById: Readonly<Record<string, Region>>;
  readonly attackerFaction: FactionId;
  readonly defenderFaction: FactionId;
  readonly attackerArmy: Army;
  readonly defenderArmy: Army;
  /** 指揮官の詳細（能力・特性）。省略時は「指揮官の有無」のみ考慮する。 */
  readonly attackerCommander?: Character | null;
  readonly defenderCommander?: Character | null;
  /**
   * 奇襲補正（設計書 3.1）：隣接州に指揮官を伴う自軍が控えていて先制条件を満たす場合に true。
   * 判定自体（隣接州の探索）は GameState 全体を必要とするため TurnEngine 側の責務とする。
   * 初撃（1ラウンド目）のみ攻撃側に適用される。
   */
  readonly surpriseAttacker?: boolean;
  /**
   * 挟撃補正（設計書 3.1）：複数方向から同時侵入した味方軍がある場合に true。
   * 全ラウンドを通じて攻撃側に適用される。
   */
  readonly flankingAttacker?: boolean;
}

/**
 * 遭遇戦を解決する（設計書 3.2 のラウンド処理、および 3.3 の結果分岐に対応）。
 * 数値は前述のとおり仮置きであり、バランス調整フェーズで大きく変わる前提。
 */
export function resolveBattle(input: BattleResolutionInput): BattleOutcome {
  const { turn, region, regionsById, attackerFaction, defenderFaction } = input;
  const attackerCommander = input.attackerCommander ?? null;
  const defenderCommander = input.defenderCommander ?? null;
  let attacker = input.attackerArmy;
  let defender = input.defenderArmy;
  let attackerKilled = 0;
  let defenderKilled = 0;
  const attackerStartingTroops = totalTroops(input.attackerArmy);
  const defenderStartingTroops = totalTroops(input.defenderArmy);

  for (let round = 0; round < MAX_BATTLE_ROUNDS; round++) {
    let cpAttack = combatPower(attacker, defender, region, "attack", attackerCommander);
    const cpDefense = combatPower(defender, attacker, region, "defense", defenderCommander);
    if (input.surpriseAttacker && round === 0) cpAttack *= SURPRISE_BONUS;
    if (input.flankingAttacker) cpAttack *= FLANKING_BONUS;

    const total = cpAttack + cpDefense;
    if (total <= 0) break;

    const attackShare = cpAttack / total; // 攻撃側の優勢度合い
    const defenderLossRatio = attackShare; // 防御側は攻撃側が優勢なほど損害が増える
    const attackerLossRatio = 1 - attackShare;

    const defRes = applyCasualties(defender, lossRate(defenderLossRatio));
    const atkRes = applyCasualties(attacker, lossRate(attackerLossRatio));
    defender = { ...defRes.army, morale: Math.max(0, defRes.army.morale - defenderLossRatio * 0.3) };
    attacker = { ...atkRes.army, morale: Math.max(0, atkRes.army.morale - attackerLossRatio * 0.3) };
    defenderKilled += defRes.report.killed;
    attackerKilled += atkRes.report.killed;

    const defenderBroken = isBroken(defender, defenderStartingTroops);
    const attackerBroken = isBroken(attacker, attackerStartingTroops);

    if (defenderBroken || attackerBroken) {
      // 双方同時に閾値を割った場合は防御側を敗者として扱う（＝占領側の判定を優先する仮ルール）。
      const loserIsDefender = defenderBroken;
      const loserFaction = loserIsDefender ? defenderFaction : attackerFaction;
      const escaped = hasEscapeRoute(loserFaction, region, regionsById);

      const attackerCasualties: CasualtyReport = {
        killed: attackerKilled,
        captured: !loserIsDefender && !escaped ? totalTroops(attacker) : 0,
        moraleAfter: attacker.morale,
      };
      const defenderCasualties: CasualtyReport = {
        killed: defenderKilled,
        captured: loserIsDefender && !escaped ? totalTroops(defender) : 0,
        moraleAfter: defender.morale,
      };

      if (escaped) {
        return {
          kind: "retreat",
          region: region.id,
          attacker: attackerFaction,
          defender: defenderFaction,
          attackerArmy: attacker.id,
          defenderArmy: defender.id,
          attackerCasualties,
          defenderCasualties,
          newOwner: null,
          retreatingSide: loserIsDefender ? "defender" : "attacker",
          capturedCommander: null,
          turn,
        };
      }

      // 退路がない（escaped === false）ため、同行していた指揮官もそのまま捕虜になる（設計書 5.1）。
      const loserArmy = loserIsDefender ? defender : attacker;
      return {
        kind: loserIsDefender ? "occupation" : "surrender",
        region: region.id,
        attacker: attackerFaction,
        defender: defenderFaction,
        attackerArmy: attacker.id,
        defenderArmy: defender.id,
        attackerCasualties,
        defenderCasualties,
        newOwner: loserIsDefender ? attackerFaction : defenderFaction,
        retreatingSide: null,
        capturedCommander: loserArmy.commander,
        turn,
      };
    }
  }

  return {
    kind: "inconclusive",
    region: region.id,
    attacker: attackerFaction,
    defender: defenderFaction,
    attackerArmy: attacker.id,
    defenderArmy: defender.id,
    attackerCasualties: { killed: attackerKilled, captured: 0, moraleAfter: attacker.morale },
    defenderCasualties: { killed: defenderKilled, captured: 0, moraleAfter: defender.morale },
    newOwner: null,
    retreatingSide: null,
    capturedCommander: null,
    turn,
  };
}
