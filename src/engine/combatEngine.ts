import { effectiveStrength, totalTroops, type Army } from "../models/army.js";
import type { BattleOutcome, CasualtyReport } from "../models/battle.js";
import type { DoctrineId } from "../models/army.js";
import type { FactionId } from "../models/ids.js";
import type { Region } from "../models/region.js";

/**
 * ⚠️ 戦闘解決エンジン（草案・未バランス調整）
 * ============================================================
 * このファイルは設計書 3章の演算モデルを「動く形」に落とした一次実装であり、
 * 係数・閾値はすべて仮値。史実再現度を見ながら継続的にチューニングする対象。
 *
 * 今後の検証プロセス（README/設計書と対応）:
 *   1. 既知の史実の戦役・戦争をシナリオ化し、このエンジンで再演算する
 *   2. 結果（占領/退却/降伏の分布、被害規模）が史実と乖離する場合、
 *      まず係数・閾値の調整で説明できないか試す
 *   3. 調整しても再現不能な事象（例: 特定の会戦の結果が確率的に起こりにくい）は、
 *      「強制イベント」（因果律の保護 = Causality Guard）として
 *      戦闘演算の外側でシナリオ的に補正することを検討する
 *      → 本エンジンには手を入れず、イベント層（EventEngine）側に
 *        条件付き補正フックとして実装する想定（未実装、設計のみ）
 *
 * そのため、このモジュールの型・関数シグネチャは安定させつつ、
 * 内部の数値ロジックは今後大きく書き換わる前提で読むこと。
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

export type CombatSide = "attack" | "defense";

/**
 * 軍の戦闘力(CP)を算出する。
 *   CP = Σ(兵科ごとの 兵数 × 練度) × 戦術洗練度係数 × 状況補正
 *
 * 状況補正（地形・奇襲・挟撃・兵科相性）は現状「地形補正のみ」を実装しており、
 * 奇襲・挟撃・兵科相性の反転ルールは TODO（バランス設計と合わせて実装する）。
 */
export function combatPower(army: Army, region: Region, side: CombatSide): number {
  const base = effectiveStrength(army);
  const doctrineCoefficient = DOCTRINE_COEFFICIENT[army.doctrine] ?? DOCTRINE_COEFFICIENT["default"]!;
  const terrain = side === "attack" ? region.terrainModifier.attack : region.terrainModifier.defense;
  const moraleFactor = 0.5 + army.morale * 0.5; // 士気ゼロでも半分の力は出る、という仮モデル
  const supplyFactor = 0.5 + army.supply * 0.5; // 同上、補給切れでも壊滅はしない仮モデル

  // TODO(balance): 奇襲補正・挟撃補正・騎兵/弓兵の兵科相性反転ルールをここに追加する。
  return base * doctrineCoefficient * terrain * moraleFactor * supplyFactor;
}

/** その軍が「敗走」判定の対象になっているか（稼働兵力・戦意のいずれかが閾値未満）。 */
export function isBroken(army: Army): boolean {
  const troops = totalTroops(army);
  const strengthRatio = troops === 0 ? 0 : effectiveStrength(army) / troops;
  return strengthRatio < BREAK_STRENGTH_RATIO || army.morale < BREAK_MORALE_THRESHOLD;
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
  return region.adjacency.some((neighborId) => regionsById[neighborId]?.owner === loserFaction);
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
}

/**
 * 遭遇戦を解決する（設計書 3.2 のラウンド処理、および 3.3 の結果分岐に対応）。
 * 数値は前述のとおり仮置きであり、バランス調整フェーズで大きく変わる前提。
 */
export function resolveBattle(input: BattleResolutionInput): BattleOutcome {
  const { turn, region, regionsById, attackerFaction, defenderFaction } = input;
  let attacker = input.attackerArmy;
  let defender = input.defenderArmy;
  let attackerKilled = 0;
  let defenderKilled = 0;

  for (let round = 0; round < MAX_BATTLE_ROUNDS; round++) {
    const cpAttack = combatPower(attacker, region, "attack");
    const cpDefense = combatPower(defender, region, "defense");
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

    const defenderBroken = isBroken(defender);
    const attackerBroken = isBroken(attacker);

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
          turn,
        };
      }

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
    turn,
  };
}
