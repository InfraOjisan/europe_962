import type { Army } from "./army.js";
import type { Campaign } from "./campaign.js";
import type { Captivity } from "./captivity.js";
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
 * 傍観モード（設計書 6.2）。プレイヤーの勢力が降伏・臣従・併合によって独立行動できなく
 * なった際、そのまま終了する代わりに吸収先／宗主勢力の視点で歴史を見続けられる。
 */
export interface SpectatorState {
  /** 傍観の視点を借りている勢力（併合先、または宗主）。 */
  readonly hostFactionId: FactionId;
  /** 傍観に入った経緯。 */
  readonly reason: "surrender" | "vassalized" | "annexed";
  /** 傍観を開始した西暦年（UI表示・再起チャンス演出用）。 */
  readonly since: number;
  /** 傍観の起点になった、プレイヤーの元の勢力（併合等で消滅していても記録として残す）。 */
  readonly originalFactionId: FactionId;
}

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
  /** 捕虜・人質。設計書 5章。キーは captive の CharacterId（1人1エントリ）。 */
  readonly captivities: Readonly<Record<CharacterId, Captivity>>;
  /** 大戦発生によりゲームが終了しているか。 */
  readonly greatWarTriggered: boolean;
  /**
   * プレイヤーが操作している勢力（設計書 6.2）。null は「プレイヤー不在」＝AI同士のシミュレーション
   * （テスト・観戦専用シナリオ等）を意味し、この場合 `runDiplomacy`/`runAction` は全勢力をAIが動かす。
   */
  readonly playerFactionId: FactionId | null;
  /** 傍観モード中でなければ null。 */
  readonly spectator: SpectatorState | null;
  /**
   * 大国キャンペーンAI（設計書 9.4／ユーザー要望）が現在追っている長期の対外方針。
   * キーはキャンペーンを主導する勢力の FactionId。エントリの無い勢力は現在キャンペーンを
   * 持たない。既存の GameState リテラル（テスト等）との後方互換のため任意フィールドとし、
   * 未設定は「キャンペーン無し」として扱う（`turnEngine.ts` の `getCampaigns` 参照）。
   */
  readonly campaigns?: Readonly<Record<FactionId, Campaign>>;
}
