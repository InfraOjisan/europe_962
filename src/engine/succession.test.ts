import { describe, expect, it } from "vitest";
import { asCharacterId, asFactionId, asRegionId } from "../models/ids.js";
import type { Character } from "../models/character.js";
import type { Faction } from "../models/faction.js";
import type { GameState } from "../models/gameState.js";
import {
  adoptHeir,
  canAdopt,
  defaultHeirPick,
  designateHeir,
  eligibleAdoptees,
  resolveSuccession,
  spawnCivilWarFactions,
} from "./succession.js";
import { validateGameState } from "../utils/validation.js";

function makeCharacter(over: Partial<Character> & Pick<Character, "id" | "name" | "faction">): Character {
  return {
    role: "heir",
    skills: { command: 0.3, diplomacy: 0.3, administration: 0.3 },
    traits: [],
    age: 30,
    alive: true,
    policy: "self_preservation",
    spouse: null,
    children: [],
    parents: [],
    adoptedChildren: [],
    adoptedBy: null,
    ...over,
  };
}

function makeFaction(over: Partial<Faction> & Pick<Faction, "id" | "name" | "ruler">): Faction {
  return {
    type: "lord",
    consort: null,
    children: [],
    heir: null,
    chancellors: [],
    warlords: [],
    regions: [],
    treasury: 1000,
    diplomacy: {},
    suzerain: null,
    alive: true,
    ...over,
  };
}

function makeState(factions: readonly Faction[], characters: readonly Character[]): GameState {
  return {
    turn: 1,
    year: 963,
    phase: "year_end",
    regions: {},
    factions: Object.fromEntries(factions.map((f) => [f.id, f])),
    armies: {},
    characters: Object.fromEntries(characters.map((c) => [c.id, c])),
    captivities: {},
    greatWarTriggered: false,
    playerFactionId: null,
    spectator: null,
    };}

describe("後継指定・養子縁組", () => {
  it("後継候補が一人もいない場合のみ canAdopt が true", () => {
    const factionId = asFactionId("faction_a");
    const ruler = makeCharacter({ id: asCharacterId("ruler"), name: "君主", faction: factionId, role: "ruler" });
    const child = makeCharacter({
      id: asCharacterId("child"),
      name: "実子",
      faction: factionId,
      parents: [ruler.id],
    });
    const characters = { [ruler.id]: ruler, [child.id]: child };

    expect(canAdopt(ruler, characters)).toBe(true); // 実子未登録の状態

    const rulerWithChild = { ...ruler, children: [child.id] };
    expect(canAdopt(rulerWithChild, characters)).toBe(false);
  });

  it("eligibleAdoptees は親等の近い順に、既に自分の子でない人物のみ返す", () => {
    const factionId = asFactionId("faction_a");
    const commonParentId = asCharacterId("common_parent");
    const ruler = makeCharacter({
      id: asCharacterId("ruler"),
      name: "君主",
      faction: factionId,
      role: "ruler",
      parents: [commonParentId],
    });
    const nephew = makeCharacter({
      id: asCharacterId("nephew"),
      name: "甥",
      faction: factionId,
      parents: [asCharacterId("sibling_of_ruler")],
    });
    const siblingOfRuler = makeCharacter({
      id: asCharacterId("sibling_of_ruler"),
      name: "兄弟",
      faction: factionId,
      parents: [commonParentId],
      children: [nephew.id],
    });
    const commonParent = makeCharacter({
      id: commonParentId,
      name: "共通の親",
      faction: factionId,
      alive: false,
      children: [ruler.id, siblingOfRuler.id],
    });
    const characters = {
      [ruler.id]: ruler,
      [nephew.id]: nephew,
      [siblingOfRuler.id]: siblingOfRuler,
      [commonParentId]: commonParent,
    };

    const candidates = eligibleAdoptees(ruler, characters);
    expect(candidates.some((c) => c.character.id === nephew.id)).toBe(true);
  });

  it("adoptHeir で養子縁組し、即座に heir へ指定される", () => {
    const factionId = asFactionId("faction_a");
    const ruler = makeCharacter({ id: asCharacterId("ruler"), name: "君主", faction: factionId, role: "ruler" });
    const nephew = makeCharacter({ id: asCharacterId("nephew"), name: "甥", faction: asFactionId("faction_b") });
    const faction = makeFaction({ id: factionId, name: "A家", ruler: ruler.id });
    const state = makeState([faction], [ruler, nephew]);

    const next = adoptHeir(state, factionId, nephew.id);

    expect(next.factions[factionId]?.heir).toBe(nephew.id);
    expect(next.characters[ruler.id]?.adoptedChildren).toContain(nephew.id);
    expect(next.characters[nephew.id]?.adoptedBy).toBe(ruler.id);
  });

  it("designateHeir は実子/養子以外を無視する", () => {
    const factionId = asFactionId("faction_a");
    const ruler = makeCharacter({ id: asCharacterId("ruler"), name: "君主", faction: factionId, role: "ruler" });
    const outsider = makeCharacter({ id: asCharacterId("outsider"), name: "赤の他人", faction: factionId });
    const faction = makeFaction({ id: factionId, name: "A家", ruler: ruler.id });
    const state = makeState([faction], [ruler, outsider]);

    const next = designateHeir(state, factionId, outsider.id);
    expect(next.factions[factionId]?.heir).toBeNull();
  });

  it("defaultHeirPick は年長者を優先する", () => {
    const factionId = asFactionId("faction_a");
    const ruler = makeCharacter({ id: asCharacterId("ruler"), name: "君主", faction: factionId });
    const younger = makeCharacter({ id: asCharacterId("younger"), name: "弟", faction: factionId, age: 10 });
    const elder = makeCharacter({ id: asCharacterId("elder"), name: "兄", faction: factionId, age: 20 });
    const rulerWithChildren = { ...ruler, children: [younger.id, elder.id] };
    const characters = { [younger.id]: younger, [elder.id]: elder };

    expect(defaultHeirPick(rulerWithChildren, characters)?.id).toBe(elder.id);
  });
});

describe("後継者危機（resolveSuccession）", () => {
  it("heir が生存していれば平和的即位", () => {
    const factionId = asFactionId("faction_a");
    const ruler = makeCharacter({ id: asCharacterId("ruler"), name: "君主", faction: factionId });
    const heir = makeCharacter({ id: asCharacterId("heir"), name: "後継者", faction: factionId });
    const faction = makeFaction({ id: factionId, name: "A家", ruler: ruler.id, heir: heir.id });
    const state = makeState([faction], [ruler, heir]);

    const result = resolveSuccession(state, ruler.id, factionId);
    expect(result.kind).toBe("peaceful");
    expect(result.newRuler).toBe(heir.id);
  });

  it("heir未指定でも生存する実子がいれば自動選出", () => {
    const factionId = asFactionId("faction_a");
    const child = makeCharacter({ id: asCharacterId("child"), name: "子", faction: factionId });
    const ruler = makeCharacter({
      id: asCharacterId("ruler"),
      name: "君主",
      faction: factionId,
      children: [child.id],
    });
    const faction = makeFaction({ id: factionId, name: "A家", ruler: ruler.id });
    const state = makeState([faction], [ruler, child]);

    const result = resolveSuccession(state, ruler.id, factionId);
    expect(result.kind).toBe("auto_pick");
    expect(result.newRuler).toBe(child.id);
  });

  it("後継候補も血縁もいなければ無主化（collapse）", () => {
    const factionId = asFactionId("faction_a");
    const ruler = makeCharacter({ id: asCharacterId("ruler"), name: "君主", faction: factionId });
    const faction = makeFaction({ id: factionId, name: "A家", ruler: ruler.id });
    const state = makeState([faction], [ruler]);

    const result = resolveSuccession(state, ruler.id, factionId);
    expect(result.kind).toBe("collapse");
    expect(result.claimants).toHaveLength(0);
  });

  it("唯一の有力claimantがいれば同君連合/平和的併合", () => {
    const factionA = asFactionId("faction_a");
    const factionB = asFactionId("faction_b");
    const gp = makeCharacter({ id: asCharacterId("gp"), name: "祖父", faction: factionA, alive: false });
    const ruler = makeCharacter({
      id: asCharacterId("ruler"),
      name: "君主",
      faction: factionA,
      parents: [gp.id],
    });
    const cousinRuler = makeCharacter({
      id: asCharacterId("cousin_ruler"),
      name: "従兄弟の当主",
      faction: factionB,
      parents: [asCharacterId("uncle")],
    });
    const uncle = makeCharacter({
      id: asCharacterId("uncle"),
      name: "叔父",
      faction: factionB,
      parents: [gp.id],
      alive: false,
      children: [cousinRuler.id],
    });
    const rulerWithParent = { ...ruler };
    const gpWithChildren = { ...gp, children: [ruler.id, uncle.id] };

    const fA = makeFaction({ id: factionA, name: "A家", ruler: ruler.id, regions: [], treasury: 500 });
    const fB = makeFaction({
      id: factionB,
      name: "B家（従兄弟筋）",
      ruler: cousinRuler.id,
      regions: [asRegionId("r1"), asRegionId("r2")],
      treasury: 9000,
    });

    const state = makeState([fA, fB], [rulerWithParent, cousinRuler, uncle, gpWithChildren]);

    const result = resolveSuccession(state, ruler.id, factionA);
    expect(result.kind).toBe("personal_union");
    expect(result.absorbingFaction).toBe(factionB);
    expect(result.claimants).toHaveLength(1);
    expect(result.claimants[0]?.character).toBe(cousinRuler.id);
  });

  it("拮抗する複数claimantがいれば内乱（civil_war）", () => {
    const factionA = asFactionId("faction_a");
    const factionB = asFactionId("faction_b");
    const factionC = asFactionId("faction_c");
    const gp = makeCharacter({ id: asCharacterId("gp"), name: "祖父", faction: factionA, alive: false });
    const ruler = makeCharacter({ id: asCharacterId("ruler"), name: "君主", faction: factionA, parents: [gp.id] });
    const claimantB = makeCharacter({ id: asCharacterId("claimant_b"), name: "B家claimant", faction: factionB, parents: [gp.id] });
    const claimantC = makeCharacter({ id: asCharacterId("claimant_c"), name: "C家claimant", faction: factionC, parents: [gp.id] });
    const gpWithChildren = { ...gp, children: [ruler.id, claimantB.id, claimantC.id] };

    const fA = makeFaction({ id: factionA, name: "A家", ruler: ruler.id, treasury: 1000, regions: [] });
    const fB = makeFaction({ id: factionB, name: "B家", ruler: claimantB.id, treasury: 1000, regions: [] });
    const fC = makeFaction({ id: factionC, name: "C家", ruler: claimantC.id, treasury: 1000, regions: [] });

    const state = makeState([fA, fB, fC], [gpWithChildren, ruler, claimantB, claimantC]);

    const result = resolveSuccession(state, ruler.id, factionA);
    expect(result.kind).toBe("civil_war");
    expect(result.claimants.length).toBeGreaterThanOrEqual(2);
  });
});

describe("spawnCivilWarFactions", () => {
  it("州を claimant ごとに分割し、整合性の取れた状態を生成する", () => {
    const factionId = asFactionId("faction_a");
    const claimant1 = makeCharacter({ id: asCharacterId("c1"), name: "claimant1", faction: asFactionId("faction_b") });
    const claimant2 = makeCharacter({ id: asCharacterId("c2"), name: "claimant2", faction: asFactionId("faction_c") });

    const r1 = asRegionId("r1");
    const r2 = asRegionId("r2");
    const faction = makeFaction({
      id: factionId,
      name: "分裂する家",
      ruler: null,
      regions: [r1, r2],
      treasury: 1000,
    });
    // claimant の home faction（Character.faction が参照する先）も実在させておく。
    const factionOfClaimant1 = makeFaction({ id: claimant1.faction, name: "B家", ruler: claimant1.id });
    const factionOfClaimant2 = makeFaction({ id: claimant2.faction, name: "C家", ruler: claimant2.id });

    const state: GameState = {
      ...makeState([faction, factionOfClaimant1, factionOfClaimant2], [claimant1, claimant2]),
      regions: {
        [r1]: {
          id: r1,
          name: "州1",
          owner: factionId,
          terrain: "plain",
          terrainModifier: { attack: 1, defense: 1 },
          population: 1000,
          taxBase: 100,
          archetype: "continental",
          garrison: { count: 0, training: 0 },
          adjacency: [],
          fortified: false,
          siege: null,
          frontier: false,
        },
        [r2]: {
          id: r2,
          name: "州2",
          owner: factionId,
          terrain: "plain",
          terrainModifier: { attack: 1, defense: 1 },
          population: 1000,
          taxBase: 100,
          archetype: "continental",
          garrison: { count: 0, training: 0 },
          adjacency: [],
          fortified: false,
          siege: null,
          frontier: false,
        },
      },
    };

    const claimants = [
      { character: claimant1.id, faction: claimant1.faction, degree: 3, claimStrength: 1 },
      { character: claimant2.id, faction: claimant2.faction, degree: 3, claimStrength: 1 },
    ];

    const next = spawnCivilWarFactions(state, factionId, claimants);

    expect(next.factions[factionId]?.alive).toBe(false);
    expect(next.factions[factionId]?.regions).toHaveLength(0);

    const claimantFactionIds = claimants.map((c) => asFactionId(`${factionId}_claimant_${c.character}`));
    expect(claimantFactionIds.every((id) => next.factions[id] !== undefined)).toBe(true);
    const totalRegions = claimantFactionIds.reduce(
      (sum, id) => sum + (next.factions[id]?.regions.length ?? 0),
      0,
    );
    expect(totalRegions).toBe(2);

    const result = validateGameState(next);
    expect(result.issues).toEqual([]);
  });

  it("分派勢力の表示名には CharacterId ではなく人物の実際の名前を使う（ユーザー報告）", () => {
    // 内部識別子（CharacterId）がそのまま画面に出てしまっていた（例：出生キャラクターの
    // 「char_born_char_born_...」のような長いID）不具合の回帰テスト。
    const factionId = asFactionId("faction_a");
    const claimant1 = makeCharacter({ id: asCharacterId("char_born_deeply_nested_id"), name: "エドワード", faction: asFactionId("faction_b") });
    const claimant2 = makeCharacter({ id: asCharacterId("c2"), name: "エドマンド", faction: asFactionId("faction_c") });

    const faction = makeFaction({ id: factionId, name: "分裂する家", ruler: null, regions: [] });
    const factionOfClaimant1 = makeFaction({ id: claimant1.faction, name: "B家", ruler: claimant1.id });
    const factionOfClaimant2 = makeFaction({ id: claimant2.faction, name: "C家", ruler: claimant2.id });
    // spawnCivilWarFactions は claimants.length >= 2 を要求する。
    const state = makeState([faction, factionOfClaimant1, factionOfClaimant2], [claimant1, claimant2]);
    const claimants = [
      { character: claimant1.id, faction: claimant1.faction, degree: 3, claimStrength: 1 },
      { character: claimant2.id, faction: claimant2.faction, degree: 3, claimStrength: 1 },
    ];

    const next = spawnCivilWarFactions(state, factionId, claimants);

    const claimantFactionId = asFactionId(`${factionId}_claimant_${claimant1.id}`);
    expect(next.factions[claimantFactionId]?.name).toBe("分裂する家（分派: エドワード）");
    expect(next.factions[claimantFactionId]?.name).not.toContain(claimant1.id);
  });
});
