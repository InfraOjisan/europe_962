/**
 * ID型定義。
 *
 * 単なる string ではなく Brand 付き型にすることで、
 * 「RegionId を渡すべき箇所に誤って FactionId を渡す」といった
 * 取り違えバグをコンパイル時に検出できるようにする。
 */

declare const brand: unique symbol;

/** 値としては string だが、型としては区別される Brand 型。 */
export type Branded<T, B extends string> = T & { readonly [brand]: B };

export type RegionId = Branded<string, "RegionId">;
export type FactionId = Branded<string, "FactionId">;
export type ArmyId = Branded<string, "ArmyId">;
export type CharacterId = Branded<string, "CharacterId">;

export const asRegionId = (id: string): RegionId => id as RegionId;
export const asFactionId = (id: string): FactionId => id as FactionId;
export const asArmyId = (id: string): ArmyId => id as ArmyId;
export const asCharacterId = (id: string): CharacterId => id as CharacterId;
