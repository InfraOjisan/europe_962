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

  /** 宰相（複数可）。傭兵団の場合は「経済担当」として扱う。 */
  readonly chancellors: readonly CharacterId[];
  /** 戦闘隊長（複数可）。 */
  readonly warlords: readonly CharacterId[];

  /** 領有する州。傭兵団は常に空配列（領地を持たない）。 */
  readonly regions: readonly RegionId[];

  readonly treasury: number;
  readonly diplomacy: DiplomacyTable;

  readonly alive: boolean;
}

/** 勢力が現在いずれかの相手と戦争状態にあるか。大戦判定の入力に使う。 */
export function isAtWar(faction: Faction): boolean {
  return Object.values(faction.diplomacy).includes("war");
}
