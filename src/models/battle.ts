import type { ArmyId, CharacterId, FactionId, RegionId } from "./ids.js";

/**
 * 戦闘結果の種別。
 * 設計書 3.3「結果の3類型」＋ ラウンド上限に達しても決着しない場合の
 * INCONCLUSIVE（膠着・双方消耗のみ）を加えた4種。
 *
 * 局地戦の戦術描写は行わないため、UI に表示する情報はこの結果種別と
 * BattleOutcome の損耗値のみに限定される。
 */
export type BattleResultKind = "occupation" | "retreat" | "surrender" | "inconclusive";

export interface CasualtyReport {
  /** 死傷者数（捕虜を除く）。 */
  readonly killed: number;
  /** 捕虜数。降伏時のみ発生しうる。 */
  readonly captured: number;
  /** 戦闘後の戦意（0〜1）。 */
  readonly moraleAfter: number;
}

/**
 * 戦闘解決エンジンの出力。
 * 具体的な演算（戦闘力算出・ラウンド処理・閾値判定）は
 * `src/engine/combatEngine.ts` で今後バランス調整しながら実装する。
 */
export interface BattleOutcome {
  readonly kind: BattleResultKind;
  readonly region: RegionId;
  readonly attacker: FactionId;
  readonly defender: FactionId;
  readonly attackerArmy: ArmyId;
  readonly defenderArmy: ArmyId;
  readonly attackerCasualties: CasualtyReport;
  readonly defenderCasualties: CasualtyReport;
  /**
   * kind === "occupation" の場合のみ設定される、占領後の新しい領有勢力。
   * それ以外は null。
   */
  readonly newOwner: FactionId | null;
  /**
   * kind === "surrender" で、降伏した側に同行していた指揮官が退路なく捕縛された場合に
   * その CharacterId を設定する（設計書 5.1）。指揮官不在、または捕縛が発生しない場合は null。
   * 呼び出し側（ターン処理）がこれを見て `captivities` にエントリを作成する。
   */
  readonly capturedCommander: CharacterId | null;
  /** この戦闘が発生したゲーム内ターン。 */
  readonly turn: number;
}
