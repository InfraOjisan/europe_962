import type { ArmyId, FactionId, RegionId } from "./ids.js";

/** 地形種別。戦闘補正・移動補正のキーになる。 */
export type TerrainType = "plain" | "hill" | "mountain" | "forest" | "coast";

export interface TerrainModifier {
  /** 攻撃側の戦闘力係数。 */
  readonly attack: number;
  /** 防御側の戦闘力係数。 */
  readonly defense: number;
}

/** 州直属の常備兵。軍団（Army）とは別に、州自体が持つ基礎防衛力。 */
export interface Garrison {
  readonly count: number;
  readonly training: number;
}

/** 包囲（持久戦）状態。城塞化された州が攻囲された際に発生する。 */
export interface SiegeState {
  readonly attacker: FactionId;
  readonly attackerArmy: ArmyId;
  readonly startTurn: number;
  /** 補給状態（0〜1）。毎ターン減衰し、閾値割れで自動的に降伏判定となる。 */
  readonly supplyState: number;
}

export interface Region {
  readonly id: RegionId;
  readonly name: string;
  readonly owner: FactionId;
  readonly terrain: TerrainType;
  readonly terrainModifier: TerrainModifier;
  readonly population: number;
  readonly taxBase: number;
  readonly garrison: Garrison;
  /** 隣接州。対称関係であること（validation で検証する）。 */
  readonly adjacency: readonly RegionId[];
  /** 城塞化されているか。true の場合、野戦一発では陥落せず持久戦ルールが適用される。 */
  readonly fortified: boolean;
  /** 包囲中でなければ null。 */
  readonly siege: SiegeState | null;
}
