import type {
  Army,
  Character,
  CharacterId,
  Faction,
  FactionId,
  GameState,
  Region,
  RegionId,
} from "../models/index.js";
import { asFactionId } from "../models/index.js";
import { findWithinDegree, ADOPTION_MAX_DEGREE, MAX_CLAIM_DEGREE } from "./kinship.js";

/**
 * ⚠️ 継承エンジン（草案・未バランス調整）
 * ============================================================
 * 設計書 4章「継承・養子・内乱システム」の一次実装。claimant の主張の強さの計算式や
 * 内乱発生時の州・軍団の分割方法は仮のロジックであり、combatEngine 同様に
 * 史実シナリオでの再演算を通じて調整していく前提。
 */

function livingHeirCandidates(ruler: Character, characters: Readonly<Record<CharacterId, Character>>): Character[] {
  const ids = [...ruler.children, ...ruler.adoptedChildren];
  return ids
    .map((id) => characters[id])
    .filter((c): c is Character => c !== undefined && c.alive);
}

/** 既定の後継者自動選出ルール：年長者を優先する（同年齢は先に並んでいる方を優先）。 */
export function defaultHeirPick(ruler: Character, characters: Readonly<Record<CharacterId, Character>>): Character | null {
  const candidates = livingHeirCandidates(ruler, characters);
  if (candidates.length === 0) return null;
  return candidates.reduce((eldest, c) => (c.age > eldest.age ? c : eldest));
}

/**
 * 養子縁組が実行可能か（設計書 4.2）。
 * 実子・養子いずれの生存する後継候補もいない場合にのみ true。
 */
export function canAdopt(ruler: Character, characters: Readonly<Record<CharacterId, Character>>): boolean {
  return livingHeirCandidates(ruler, characters).length === 0;
}

/**
 * 養子縁組の対象にできる人物を、親等の近い順に列挙する（設計書 4.2）。
 * 既に自分の実子・養子である人物、本人自身は除外する。
 */
export function eligibleAdoptees(
  ruler: Character,
  characters: Readonly<Record<CharacterId, Character>>,
  maxDegree: number = ADOPTION_MAX_DEGREE,
): Array<{ readonly character: Character; readonly degree: number }> {
  const within = findWithinDegree(ruler.id, maxDegree, characters);
  const ownChildren = new Set([...ruler.children, ...ruler.adoptedChildren]);

  const result: Array<{ character: Character; degree: number }> = [];
  for (const [id, degree] of within) {
    if (ownChildren.has(id)) continue;
    const candidate = characters[id];
    if (!candidate || !candidate.alive) continue;
    result.push({ character: candidate, degree });
  }
  return result.sort((a, b) => a.degree - b.degree);
}

/**
 * 養子を迎え、即座に後継指定する。呼び出し前に `canAdopt` で前提条件を確認すること。
 * 他家の子を養子にする場合の外交合意（関係値への影響）は呼び出し側（外交処理）の責務とする。
 */
export function adoptHeir(state: GameState, rulerFactionId: FactionId, adopteeId: CharacterId): GameState {
  const faction = state.factions[rulerFactionId];
  if (!faction || faction.ruler === null) return state;
  const ruler = state.characters[faction.ruler];
  const adoptee = state.characters[adopteeId];
  if (!ruler || !adoptee) return state;

  return {
    ...state,
    characters: {
      ...state.characters,
      [ruler.id]: { ...ruler, adoptedChildren: [...ruler.adoptedChildren, adopteeId] },
      [adopteeId]: { ...adoptee, adoptedBy: ruler.id },
    },
    factions: {
      ...state.factions,
      [rulerFactionId]: { ...faction, heir: adopteeId },
    },
  };
}

/** 後継指定コマンド。対象が実子・養子・生存のいずれかを満たさない場合は何もしない。 */
export function designateHeir(state: GameState, rulerFactionId: FactionId, heirId: CharacterId): GameState {
  const faction = state.factions[rulerFactionId];
  if (!faction || faction.ruler === null) return state;
  const ruler = state.characters[faction.ruler];
  const heir = state.characters[heirId];
  if (!ruler || !heir || !heir.alive) return state;
  if (!ruler.children.includes(heirId) && !ruler.adoptedChildren.includes(heirId)) return state;

  return { ...state, factions: { ...state.factions, [rulerFactionId]: { ...faction, heir: heirId } } };
}

// --- 後継者危機 -----------------------------------------------------------

export type SuccessionResultKind = "peaceful" | "auto_pick" | "personal_union" | "civil_war" | "collapse";

export interface Claimant {
  readonly character: CharacterId;
  /** claimant が現在所属する勢力（Character.faction は必須項目のため常に存在する）。 */
  readonly faction: FactionId;
  readonly degree: number;
  /** 主張の強さ（仮の指標）。値が大きいほど有力。 */
  readonly claimStrength: number;
}

export interface SuccessionResult {
  readonly kind: SuccessionResultKind;
  readonly deceasedRuler: CharacterId;
  /** 後継者危機の発生元となった（跡継ぎの絶えた）勢力。 */
  readonly faction: FactionId;
  /** peaceful / auto_pick の場合のみ設定：同じ勢力の新しい君主。 */
  readonly newRuler: CharacterId | null;
  /** personal_union の場合のみ設定：領地を吸収する勢力。 */
  readonly absorbingFaction: FactionId | null;
  /** civil_war では2人以上、personal_union では勝者1人、それ以外は空。 */
  readonly claimants: readonly Claimant[];
}

/** claimant 勢力の国力補正（仮の指標。要バランス調整）。 */
function factionPowerFactor(factionId: FactionId, state: GameState): number {
  const faction = state.factions[factionId];
  if (!faction) return 1;
  return 1 + faction.regions.length * 0.15 + faction.treasury / 10_000;
}

/** 拮抗判定の閾値（仮値）。首位の主張が次点よりこの倍率以上強ければ「拮抗なし」とみなす。 */
const DOMINANCE_RATIO = 1.5;

function findClaimants(deceasedRulerId: CharacterId, state: GameState): Claimant[] {
  const within = findWithinDegree(deceasedRulerId, MAX_CLAIM_DEGREE, state.characters);
  const claimants: Claimant[] = [];
  for (const [id, degree] of within) {
    const character = state.characters[id];
    if (!character || !character.alive) continue;
    const claimStrength = (1 / (degree + 1)) * factionPowerFactor(character.faction, state);
    claimants.push({ character: id, faction: character.faction, degree, claimStrength });
  }
  return claimants.sort((a, b) => b.claimStrength - a.claimStrength);
}

/**
 * 君主死亡時の継承処理（設計書 4.3）。年末集計フェイズから呼ばれる想定。
 * `factionId` は死亡した君主が率いていた勢力。
 */
export function resolveSuccession(state: GameState, deceasedRulerId: CharacterId, factionId: FactionId): SuccessionResult {
  const faction = state.factions[factionId];
  const base = { deceasedRuler: deceasedRulerId, faction: factionId };

  if (faction?.heir !== null && faction?.heir !== undefined) {
    const heir = state.characters[faction.heir];
    if (heir && heir.alive) {
      return { ...base, kind: "peaceful", newRuler: heir.id, absorbingFaction: null, claimants: [] };
    }
  }

  const deceasedRuler = state.characters[deceasedRulerId];
  if (deceasedRuler) {
    const picked = defaultHeirPick(deceasedRuler, state.characters);
    if (picked) {
      return { ...base, kind: "auto_pick", newRuler: picked.id, absorbingFaction: null, claimants: [] };
    }
  }

  const claimants = findClaimants(deceasedRulerId, state);
  if (claimants.length === 0) {
    return { ...base, kind: "collapse", newRuler: null, absorbingFaction: null, claimants: [] };
  }

  const top = claimants[0]!;
  const runnerUp = claimants[1];
  const dominant = !runnerUp || top.claimStrength >= runnerUp.claimStrength * DOMINANCE_RATIO;

  if (dominant) {
    return { ...base, kind: "personal_union", newRuler: null, absorbingFaction: top.faction, claimants: [top] };
  }

  const rivals = claimants.filter((c) => c.claimStrength >= top.claimStrength / DOMINANCE_RATIO);
  return { ...base, kind: "civil_war", newRuler: null, absorbingFaction: null, claimants: rivals };
}

// --- 内乱・無主化の後処理（草案） -------------------------------------------

/**
 * 無主化：勢力を消滅させ、州の owner を空の勢力IDに差し替える代わりに、
 * 便宜上「元の勢力のまま alive: false」として残し、州は接収可能な係争地として扱う。
 * 実際の無血占領の可否判定は3章の戦闘解決エンジン側の責務とする（このエンジンは
 * 状態遷移のみを行う）。
 */
export function collapseFaction(state: GameState, factionId: FactionId): GameState {
  const faction = state.factions[factionId];
  if (!faction) return state;
  return {
    ...state,
    factions: { ...state.factions, [factionId]: { ...faction, alive: false, ruler: null, heir: null } },
  };
}

/**
 * 内乱：旧勢力の州を claimant ごとにラウンドロビンで分割し、claimant を当主とする
 * 分派勢力（claimant faction）を生成する。軍団はその時点の所在州の新しい領有者に合わせて
 * 所属を付け替える。最終的な決着（全州の再統一）は3章の戦闘解決エンジンに委ねる。
 *
 * 分割の公平さ・州の隣接関係を考慮しないラウンドロビンは仮のロジックであり、
 * バランス調整フェーズで見直す前提（combatEngine と同様の位置づけ）。
 */
export function spawnCivilWarFactions(state: GameState, originalFactionId: FactionId, claimants: readonly Claimant[]): GameState {
  const original = state.factions[originalFactionId];
  if (!original || claimants.length < 2) return state;

  const claimantFactionIds = claimants.map((c) => asFactionId(`${originalFactionId}_claimant_${c.character}`));

  const newFactions: Record<string, Faction> = {};
  claimants.forEach((claimant, i) => {
    const id = claimantFactionIds[i]!;
    newFactions[id] = {
      id,
      name: `${original.name}（分派: ${claimant.character}）`,
      type: "lord",
      ruler: claimant.character,
      consort: null,
      children: [],
      heir: null,
      chancellors: [],
      warlords: [],
      regions: [],
      treasury: Math.floor(original.treasury / claimants.length),
      diplomacy: {},
      alive: true,
    };
  });

  const updatedRegions: Record<string, Region> = {};
  original.regions.forEach((regionId, i) => {
    const owner = claimantFactionIds[i % claimantFactionIds.length]!;
    const region = state.regions[regionId];
    if (!region) return;
    updatedRegions[regionId] = { ...region, owner };
    const target = newFactions[owner]!;
    newFactions[owner] = { ...target, regions: [...target.regions, regionId] };
  });

  const regionOwner = new Map<RegionId, FactionId>(
    Object.entries(updatedRegions).map(([id, r]) => [id as RegionId, r.owner]),
  );
  const updatedArmies: Record<string, Army> = {};
  for (const army of Object.values(state.armies)) {
    if (army.faction !== originalFactionId) continue;
    const newOwner = regionOwner.get(army.location);
    if (newOwner) updatedArmies[army.id] = { ...army, faction: newOwner };
  }

  return {
    ...state,
    factions: {
      ...state.factions,
      ...newFactions,
      [originalFactionId]: { ...original, alive: false, ruler: null, heir: null, regions: [] },
    },
    regions: { ...state.regions, ...updatedRegions },
    armies: { ...state.armies, ...updatedArmies },
  };
}
