import type { CharacterId, FactionId } from "./ids.js";
import type { Policy } from "./policy.js";

/**
 * ゲーム内での人物の役割。
 * `gamesystem_europe.md` の役職定義に対応する。
 *
 * - ruler:      君主。外交・宣戦・子作り・海外開発・婚姻を行う。
 * - chancellor: 宰相。人材登用・外交・商業・税収管理を行う。複数人保持可。
 * - warlord:    戦闘隊長。部隊編成・移動・戦闘・退却・略奪・人質売買を行う。複数人保持可。
 * - consort:    妃。行動フェイズのアクションは持たないが、政略結婚・相続の対象になる。
 * - heir:       子女。政略結婚の対象・将来の後継者候補（相続処理で ruler 等に遷移しうる）。
 *               「後継者に指定されている」ことは意味しない（それは Faction.heir が指す）。
 */
export type CharacterRole = "ruler" | "chancellor" | "warlord" | "consort" | "heir";

/**
 * 指揮官特性。戦術洗練度の補正や、奇襲・挟撃などの状況補正に影響する。
 * 設計書 3.1「戦術洗練度係数」のテーブル要素に対応する拡張ポイント。
 */
export type CharacterTrait =
  | "cavalry_specialist" // 騎兵運用に長ける（ノルマン騎士、ポーランド騎兵 等）
  | "infantry_specialist" // 密集歩兵運用に長ける（スイス傭兵 等）
  | "archery_specialist" // 弓兵運用に長ける（イングランド長弓 等）
  | "siege_specialist" // 持久戦・包囲に長ける
  | "diplomat" // 外交能力が高い
  | "administrator"; // 内政・税収管理能力が高い

/** 0〜1 に正規化された能力値。 */
export type Skill01 = number;

export interface CharacterSkills {
  /** 指揮能力。戦術洗練度係数の算出に用いる。 */
  readonly command: Skill01;
  /** 外交能力。 */
  readonly diplomacy: Skill01;
  /** 内政・行政能力。 */
  readonly administration: Skill01;
}

export interface Character {
  readonly id: CharacterId;
  readonly name: string;
  readonly role: CharacterRole;
  /** 所属勢力。傭兵隊長は臣従しないが、契約中の所属先として扱う。 */
  readonly faction: FactionId;
  readonly skills: CharacterSkills;
  readonly traits: readonly CharacterTrait[];
  readonly age: number;
  readonly alive: boolean;
  /** 配偶者（君主の妻など）。政略結婚の結果として設定される。 */
  readonly spouse: CharacterId | null;
  /** 実子。相続・政略結婚のために保持する。 */
  readonly children: readonly CharacterId[];

  /**
   * 実親（0〜2人）。血族ネットワーク・親等計算（設計書 4.1）の起点になる。
   * 初期データ等で系譜が不明な人物は空配列でよい。
   */
  readonly parents: readonly CharacterId[];
  /** 養子（設計書 4.2）。実子とは区別するが、後継候補としては同格に扱う。 */
  readonly adoptedChildren: readonly CharacterId[];
  /** 自分が養子である場合の養親。実親ではない。 */
  readonly adoptedBy: CharacterId | null;

  /**
   * 行動方針（設計書 9章）。史実で行動原理が明確な人物は個別に指定し、
   * それ以外は生成時に4種から一様乱数で割り当てる（`aiPolicy.ts` の `assignRandomPolicy`）。
   */
  readonly policy: Policy;
}
