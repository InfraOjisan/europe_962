import type { CharacterId, FactionId, RegionId } from "./ids.js";

/** 勢力種別。`gamesystem_europe.md` の「勢力」定義に対応する。 */
export type FactionType = "lord" | "mercenary";

/** 2勢力間の外交状態。 */
export type DiplomaticStance = "war" | "peace" | "alliance" | "vassal";

/** FactionId をキーとする外交関係の辞書。 */
export type DiplomacyTable = Readonly<Record<FactionId, DiplomaticStance>>;

export interface Faction {
  readonly id: FactionId;
  readonly name: string;
  readonly type: FactionType;

  /** 領主（lord）の場合のみ意味を持つ。傭兵団（mercenary）は null。 */
  readonly ruler: CharacterId | null;
  readonly consort: CharacterId | null;
  readonly children: readonly CharacterId[];
  /**
   * 後継指定（設計書 4.2）。実子・養子の中から君主が指定した後継者。
   * null の場合、君主死亡時に既定ルールで自動選出するか、候補が誰もいなければ
   * 後継者危機（設計書 4.3）に移行する。傭兵団では常に null。
   */
  readonly heir: CharacterId | null;

  /** 宰相（複数可）。傭兵団の場合は「経済担当」として扱う。 */
  readonly chancellors: readonly CharacterId[];
  /** 戦闘隊長（複数可）。 */
  readonly warlords: readonly CharacterId[];

  /** 領有する州。傭兵団は常に空配列（領地を持たない）。 */
  readonly regions: readonly RegionId[];

  readonly treasury: number;
  readonly diplomacy: DiplomacyTable;

  /**
   * 宗主（設計書 5.4 / 6.2章）。`diplomacy` の `"vassal"` は対称な状態表現のため、
   * どちらが宗主でどちらが臣下かを示せない。この勢力が誰かの臣下である場合のみ
   * その宗主の FactionId を持つ（自身が独立している、または他者の宗主である場合は null）。
   * `captivity.ts` の `forceVassalization` が設定する。プレイヤーのゲームオーバー判定にも使う。
   */
  readonly suzerain: FactionId | null;

  readonly alive: boolean;
}

/** 勢力が現在いずれかの相手と戦争状態にあるか。大戦判定の入力に使う。 */
export function isAtWar(faction: Faction): boolean {
  return Object.values(faction.diplomacy).includes("war");
}
