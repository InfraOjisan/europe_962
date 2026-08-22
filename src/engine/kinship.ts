import type { Character, CharacterId } from "../models/index.js";

/**
 * 血族ネットワーク・親等計算（設計書 4.1）。
 *
 * 「親子」「配偶者」「養親子」を各重み1の辺とする無向グラフ上の最短距離を
 * 親等の近似値として扱う。カノン法上の傍系換算を厳密に再現するものではなく、
 * ゲーム的な「近さ」の指標として意図的に簡略化している。
 *
 * 例: 本人 → 父 → 祖父 → 伯父 → 従兄弟 = 4親等相当
 */

/** 養子縁組で対象にできる親等の上限（設計書 4.2）。要バランス調整。 */
export const ADOPTION_MAX_DEGREE = 5;

/**
 * 後継者危機（設計書 4.3）で王権を主張できる claimant の親等上限。
 * 「相当遡った分家筋や姻戚」を拾えるよう、養子縁組の上限より意図的に広く取る。要バランス調整。
 */
export const MAX_CLAIM_DEGREE = 9;

function neighborsOf(character: Character): readonly CharacterId[] {
  const neighbors: CharacterId[] = [
    ...character.parents,
    ...character.children,
    ...character.adoptedChildren,
  ];
  if (character.spouse !== null) neighbors.push(character.spouse);
  if (character.adoptedBy !== null) neighbors.push(character.adoptedBy);
  return neighbors;
}

/**
 * `origin` から親等 `maxDegree` 以内にいる人物を、親等の近い順に BFS で収集する。
 * 戻り値は origin 自身を含まない `CharacterId -> 親等` の Map。
 */
export function findWithinDegree(
  origin: CharacterId,
  maxDegree: number,
  characters: Readonly<Record<CharacterId, Character>>,
): Map<CharacterId, number> {
  const degrees = new Map<CharacterId, number>();
  let frontier: CharacterId[] = [origin];
  degrees.set(origin, 0);

  for (let degree = 1; degree <= maxDegree && frontier.length > 0; degree++) {
    const next: CharacterId[] = [];
    for (const id of frontier) {
      const character = characters[id];
      if (!character) continue;
      for (const neighbor of neighborsOf(character)) {
        if (degrees.has(neighbor)) continue;
        degrees.set(neighbor, degree);
        next.push(neighbor);
      }
    }
    frontier = next;
  }

  degrees.delete(origin);
  return degrees;
}

/**
 * a と b の親等を求める。`maxDegree` 以内に経路が見つからなければ null を返す
 * （「無関係」として扱ってよいという意味。実際には遠縁で繋がっている可能性はあるが、
 * ゲーム的にはこの上限を超えた血縁は無視する）。
 */
export function kinshipDegree(
  a: CharacterId,
  b: CharacterId,
  characters: Readonly<Record<CharacterId, Character>>,
  maxDegree: number = MAX_CLAIM_DEGREE,
): number | null {
  if (a === b) return 0;
  const found = findWithinDegree(a, maxDegree, characters);
  return found.get(b) ?? null;
}
