import type { ArmyId, CharacterId, FactionId, RegionId } from "./ids.js";

/**
 * 兵科。史実の代表的兵種を抽象化して扱う。
 * 兵科の組み合わせと地形・相手兵科によって「騎兵・弓兵の数的優劣が反転する」
 * 特例ルール（設計書 3.1）の入力になる。
 */
export type UnitType = "pike" | "cavalry" | "archer" | "infantry" | "artillery";

export interface UnitGroup {
  readonly type: UnitType;
  /** 兵数。 */
  readonly count: number;
  /** 練度（0〜1）。 */
  readonly training: number;
}

/**
 * 戦術ドクトリン。時代・編成に紐づく戦術洗練度係数のキー。
 * 例: "swiss_pike"（スイス傭兵槍兵）, "english_longbow"（イングランド長弓）,
 *     "polish_hussar"（ポーランド騎兵）, "napoleonic_corps"（ナポレオン式軍団編制）
 */
export type DoctrineId = string;

export interface Army {
  readonly id: ArmyId;
  readonly faction: FactionId;
  /** 指揮官不在の場合は null（戦術洗練度・士気維持に不利補正がかかる）。 */
  readonly commander: CharacterId | null;
  readonly location: RegionId;
  readonly units: readonly UnitGroup[];
  readonly doctrine: DoctrineId;
  /** 戦意（0〜1）。閾値を割ると敗走判定の対象になる。 */
  readonly morale: number;
  /** 補給状態（0〜1）。持久戦・長距離移動で低下する。 */
  readonly supply: number;
}

/** 軍の総兵数。 */
export function totalTroops(army: Army): number {
  return army.units.reduce((sum, u) => sum + u.count, 0);
}

/**
 * 稼働兵力の簡易指標（練度加重の兵数）。
 * 戦闘力そのものではなく、「まだ組織立って戦える人数」の目安として
 * 敗走・降伏判定の土台に使う想定（詳細な閾値は戦闘エンジンでバランス調整する）。
 */
export function effectiveStrength(army: Army): number {
  return army.units.reduce((sum, u) => sum + u.count * u.training, 0);
}
