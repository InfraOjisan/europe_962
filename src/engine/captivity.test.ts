import { describe, expect, it } from "vitest";
import { asArmyId, asCharacterId, asFactionId, asRegionId } from "../models/ids.js";
import type { BattleOutcome } from "../models/battle.js";
import type { Captivity } from "../models/captivity.js";
import type { CharacterId } from "../models/ids.js";
import type { Character } from "../models/character.js";
import type { Faction } from "../models/faction.js";
import type { GameState } from "../models/gameState.js";
import type { Region } from "../models/region.js";
import {
  canForceSubjugation,
  forceAnnexation,
  forceVassalization,
  offerHostage,
  payRansom,
  recruitCaptive,
  registerCapture,
} from "./captivity.js";
import { validateGameState } from "../utils/validation.js";

function makeCharacter(over: Partial<Character> & Pick<Character, "id" | "name" | "faction">): Character {
  return {
    role: "warlord",
    skills: { command: 0.5, diplomacy: 0.2, administration: 0.2 },
    traits: [],
    age: 30,
    alive: true,
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
    alive: true,
    ...over,
  };
}

function makeRegion(id: ReturnType<typeof asRegionId>, owner: ReturnType<typeof asFactionId>): Region {
  return {
    id,
    name: `region-${id}`,
    owner,
    terrain: "plain",
    terrainModifier: { attack: 1, defense: 1 },
    population: 1000,
    taxBase: 100,
    garrison: { count: 0, training: 0 },
    adjacency: [],
    fortified: false,
    siege: null,
  };
}

function makeState(factions: readonly Faction[], characters: readonly Character[], regions: readonly Region[] = []): GameState {
  return {
    turn: 5,
    year: 967,
    phase: "battle_resolution",
    regions: Object.fromEntries(regions.map((r) => [r.id, r])),
    factions: Object.fromEntries(factions.map((f) => [f.id, f])),
    armies: {},
    characters: Object.fromEntries(characters.map((c) => [c.id, c])),
    captivities: {},
    greatWarTriggered: false,
  };
}

describe("registerCapture", () => {
  const attackerFaction = asFactionId("faction_attacker");
  const defenderFaction = asFactionId("faction_defender");
  const commander = asCharacterId("commander");

  function baseOutcome(over: Partial<BattleOutcome>): BattleOutcome {
    return {
      kind: "surrender",
      region: asRegionId("r1"),
      attacker: attackerFaction,
      defender: defenderFaction,
      attackerArmy: asArmyId("army_a"),
      defenderArmy: asArmyId("army_d"),
      attackerCasualties: { killed: 0, captured: 0, moraleAfter: 0 },
      defenderCasualties: { killed: 0, captured: 0, moraleAfter: 0 },
      newOwner: null,
      retreatingSide: null,
      capturedCommander: commander,
      turn: 5,
      ...over,
    };
  }

  it("surrender: 攻撃側の指揮官が捕虜になった場合、防御側が captor になる", () => {
    const state = makeState(
      [makeFaction({ id: attackerFaction, name: "攻撃側", ruler: null }), makeFaction({ id: defenderFaction, name: "防御側", ruler: null })],
      [makeCharacter({ id: commander, name: "捕虜になった将軍", faction: attackerFaction })],
    );

    const next = registerCapture(state, baseOutcome({ kind: "surrender" }));
    const captivity = next.captivities[commander];
    expect(captivity?.captor).toBe(defenderFaction);
    expect(captivity?.homeFaction).toBe(attackerFaction);
    expect(captivity?.purpose).toBe("war_captive");
    expect(captivity?.ransomDemand).toBeGreaterThan(0);
  });

  it("occupation: 防御側の指揮官が捕虜になった場合、攻撃側が captor になる", () => {
    const state = makeState(
      [makeFaction({ id: attackerFaction, name: "攻撃側", ruler: null }), makeFaction({ id: defenderFaction, name: "防御側", ruler: null })],
      [makeCharacter({ id: commander, name: "捕虜になった守将", faction: defenderFaction })],
    );

    const next = registerCapture(state, baseOutcome({ kind: "occupation", newOwner: attackerFaction }));
    const captivity = next.captivities[commander];
    expect(captivity?.captor).toBe(attackerFaction);
    expect(captivity?.homeFaction).toBe(defenderFaction);
  });

  it("capturedCommander が null なら何も登録しない", () => {
    const state = makeState(
      [makeFaction({ id: attackerFaction, name: "攻撃側", ruler: null }), makeFaction({ id: defenderFaction, name: "防御側", ruler: null })],
      [],
    );
    const next = registerCapture(state, baseOutcome({ kind: "retreat", capturedCommander: null }));
    expect(Object.keys(next.captivities)).toHaveLength(0);
  });
});

describe("身代金・登用", () => {
  const captor = asFactionId("faction_captor");
  const home = asFactionId("faction_home");
  const captiveId = asCharacterId("captive");

  function setupState(homeTreasury: number) {
    const captive = makeCharacter({ id: captiveId, name: "捕虜", faction: home, role: "warlord" });
    const homeFaction = makeFaction({ id: home, name: "母国", ruler: null, warlords: [captiveId], treasury: homeTreasury });
    const captorFaction = makeFaction({ id: captor, name: "捕らえた国", ruler: null, treasury: 200 });
    let state = makeState([homeFaction, captorFaction], [captive]);
    state = {
      ...state,
      captivities: {
        [captiveId]: { captive: captiveId, captor, homeFaction: home, purpose: "war_captive", capturedTurn: 1, ransomDemand: 500 },
      },
    };
    return state;
  }

  it("身代金を支払えば釈放され、資産が移動する", () => {
    const state = setupState(1000);
    const next = payRansom(state, captiveId);

    expect(next.captivities[captiveId]).toBeUndefined();
    expect(next.factions[home]?.treasury).toBe(500);
    expect(next.factions[captor]?.treasury).toBe(700);
  });

  it("資金不足なら何も起きない", () => {
    const state = setupState(100);
    const next = payRansom(state, captiveId);

    expect(next.captivities[captiveId]).toBeDefined();
    expect(next.factions[home]?.treasury).toBe(100);
  });

  it("寝返らせて登用すると所属勢力が変わる", () => {
    const state = setupState(1000);
    const next = recruitCaptive(state, captiveId);

    expect(next.captivities[captiveId]).toBeUndefined();
    expect(next.characters[captiveId]?.faction).toBe(captor);
    expect(next.factions[captor]?.warlords).toContain(captiveId);
    expect(next.factions[home]?.warlords).not.toContain(captiveId);
  });
});

describe("併合・傀儡化の強制", () => {
  const captor = asFactionId("faction_captor");
  const target = asFactionId("faction_target");
  const rulerId = asCharacterId("target_ruler");
  const heirId = asCharacterId("target_heir");

  function setupState(rulerCaptive: boolean, heirCaptive: boolean) {
    const ruler = makeCharacter({ id: rulerId, name: "対象国の君主", faction: target, role: "ruler" });
    const heir = makeCharacter({ id: heirId, name: "対象国の後継者", faction: target, role: "heir" });
    const r1 = asRegionId("target_region");
    const targetFaction = makeFaction({ id: target, name: "対象国", ruler: rulerId, heir: heirId, regions: [r1] });
    const captorFaction = makeFaction({ id: captor, name: "捕らえた国", ruler: null, regions: [] });

    let state = makeState([targetFaction, captorFaction], [ruler, heir], [makeRegion(r1, target)]);
    const captivities: Record<CharacterId, Captivity> = {};
    if (rulerCaptive) {
      captivities[rulerId] = { captive: rulerId, captor, homeFaction: target, purpose: "war_captive", capturedTurn: 1, ransomDemand: 100 };
    }
    if (heirCaptive) {
      captivities[heirId] = { captive: heirId, captor, homeFaction: target, purpose: "war_captive", capturedTurn: 1, ransomDemand: 100 };
    }
    state = { ...state, captivities };
    return state;
  }

  it("君主のみ捕虜で後継者が自由なら強制できない", () => {
    const state = setupState(true, false);
    expect(canForceSubjugation(state, captor, target)).toBe(false);
  });

  it("君主と後継者がともに捕虜なら強制できる", () => {
    const state = setupState(true, true);
    expect(canForceSubjugation(state, captor, target)).toBe(true);
  });

  it("傀儡化を強制すると diplomacy が vassal になる", () => {
    const state = setupState(true, true);
    const next = forceVassalization(state, captor, target);
    expect(next.factions[target]?.diplomacy[captor]).toBe("vassal");
    expect(next.factions[captor]?.diplomacy[target]).toBe("vassal");
  });

  it("併合を強制すると州が captor に編入され、target は消滅する", () => {
    const state = setupState(true, true);
    const next = forceAnnexation(state, captor, target);

    expect(next.factions[target]?.alive).toBe(false);
    expect(next.factions[target]?.regions).toHaveLength(0);
    expect(next.factions[captor]?.regions).toContain(asRegionId("target_region"));
    expect(next.regions[asRegionId("target_region")]?.owner).toBe(captor);

    const result = validateGameState(next);
    expect(result.issues).toEqual([]);
  });
});
