import type { Army } from "./army.js";
import type { Character } from "./character.js";
import type { Faction } from "./faction.js";
import type { ArmyId, CharacterId, FactionId, RegionId } from "./ids.js";
import type { Region } from "./region.js";

/**
 * ゲームの現在フェイズ。設計書 1.1 の5フェイズに対応する
 * ターン進行ステートマシン（TurnFSM）の状態。
 */
export type TurnPhase =
  | "year_start" // ① 年始フェイズ（イベント処理）
  | "diplomacy" // ② 外交フェイズ
  | "action" // ③ 行動フェイズ
  | "battle_resolution" // ④ 遭遇・戦闘解決フェイズ
  | "year_end"; // ⑤ 年末集計フェイズ

/**
 * ゲーム全体の状態スナップショット。セーブデータの単位でもある。
 * 各エンティティは Map ではなく Record で保持し、そのまま JSON にシリアライズできるようにする。
 */
export interface GameState {
  readonly turn: number;
  readonly year: number; // 962 起算の西暦年
  readonly phase: TurnPhase;
  readonly regions: Readonly<Record<RegionId, Region>>;
  readonly factions: Readonly<Record<FactionId, Faction>>;
  readonly armies: Readonly<Record<ArmyId, Army>>;
  readonly characters: Readonly<Record<CharacterId, Character>>;
  /** 大戦発生によりゲームが終了しているか。 */
  readonly greatWarTriggered: boolean;
}
