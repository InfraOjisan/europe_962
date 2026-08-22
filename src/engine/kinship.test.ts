import { describe, expect, it } from "vitest";
import { asCharacterId, asFactionId } from "../models/ids.js";
import type { Character } from "../models/character.js";
import { ADOPTION_MAX_DEGREE, MAX_CLAIM_DEGREE, kinshipDegree } from "./kinship.js";

/**
 * 家系:
 *   祖父母(gp, gma) -+- 父(father) -+- 母(mother)
 *                    |             +- 本人(ego) -- 配偶者(egoSpouse)
 *                    |             +- 兄弟(sibling)
 *                    +- 叔父(uncle) -- 従兄弟(cousin)
 */
function buildFamily(): Record<string, Character> {
  const base = (over: Partial<Character> & Pick<Character, "id" | "name">): Character => ({
    role: "heir",
    faction: asFactionId("faction_x"),
    skills: { command: 0, diplomacy: 0, administration: 0 },
    traits: [],
    age: 0,
    alive: true,
    policy: "self_preservation",
    spouse: null,
    children: [],
    parents: [],
    adoptedChildren: [],
    adoptedBy: null,
    ...over,
  });

  const gp = base({ id: asCharacterId("gp"), name: "祖父", children: [asCharacterId("father"), asCharacterId("uncle")] });
  const gma = base({
    id: asCharacterId("gma"),
    name: "祖母",
    spouse: gp.id,
    children: [asCharacterId("father"), asCharacterId("uncle")],
  });
  const father = base({
    id: asCharacterId("father"),
    name: "父",
    parents: [gp.id, gma.id],
    spouse: asCharacterId("mother"),
    children: [asCharacterId("ego"), asCharacterId("sibling")],
  });
  const mother = base({
    id: asCharacterId("mother"),
    name: "母",
    spouse: father.id,
    children: [asCharacterId("ego"), asCharacterId("sibling")],
  });
  const ego = base({
    id: asCharacterId("ego"),
    name: "本人",
    parents: [father.id, mother.id],
    spouse: asCharacterId("egoSpouse"),
  });
  const egoSpouse = base({ id: asCharacterId("egoSpouse"), name: "配偶者", spouse: ego.id });
  const sibling = base({ id: asCharacterId("sibling"), name: "兄弟", parents: [father.id, mother.id] });
  const uncle = base({
    id: asCharacterId("uncle"),
    name: "叔父",
    parents: [gp.id, gma.id],
    children: [asCharacterId("cousin")],
  });
  const cousin = base({ id: asCharacterId("cousin"), name: "従兄弟", parents: [uncle.id] });
  const stranger = base({ id: asCharacterId("stranger"), name: "赤の他人" });

  return Object.fromEntries(
    [gp, gma, father, mother, ego, egoSpouse, sibling, uncle, cousin, stranger].map((c) => [c.id, c]),
  );
}

describe("kinshipDegree", () => {
  const characters = buildFamily();
  const deg = (a: string, b: string) => kinshipDegree(asCharacterId(a), asCharacterId(b), characters);

  it("親子は1親等", () => {
    expect(deg("ego", "father")).toBe(1);
    expect(deg("ego", "mother")).toBe(1);
  });

  it("兄弟・祖父母は2親等", () => {
    expect(deg("ego", "sibling")).toBe(2);
    expect(deg("ego", "gp")).toBe(2);
  });

  it("叔父は3親等、従兄弟は4親等（設計書 4.1 の例と一致）", () => {
    expect(deg("ego", "uncle")).toBe(3);
    expect(deg("ego", "cousin")).toBe(4);
  });

  it("配偶者は1親等、姻族もグラフに含まれる", () => {
    expect(deg("ego", "egoSpouse")).toBe(1);
    expect(deg("egoSpouse", "father")).toBe(2); // 姻族: 配偶者の父
  });

  it("本人同士は0親等", () => {
    expect(deg("ego", "ego")).toBe(0);
  });

  it("上限距離を超える、または無関係な人物は null", () => {
    expect(deg("ego", "stranger")).toBeNull();
    expect(kinshipDegree(asCharacterId("ego"), asCharacterId("cousin"), characters, 2)).toBeNull();
  });

  it("既定の閾値定数は 養子(5) < 王権主張(9) の関係を保つ", () => {
    expect(ADOPTION_MAX_DEGREE).toBeLessThan(MAX_CLAIM_DEGREE);
  });
});
