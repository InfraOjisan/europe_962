import { describe, expect, it } from "vitest";
import { asCharacterId, asFactionId, asRegionId } from "../models/ids.js";
import type { Character } from "../models/character.js";
import type { Faction } from "../models/faction.js";
import type { GameState } from "../models/gameState.js";
import {
  checkComebackOpportunity,
  enterSpectatorMode,
  evaluatePlayerGameOver,
  findClosestSurvivingRuler,
  giveUpSpectating,
  reclaimIndependence,
  restartAsClosestKin,
} from "./playerGameOver.js";

function makeCharacter(over: Partial<Character> & Pick<Character, "id" | "name" | "faction">): Character {
  return {
    role: "ruler",
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

function makeState(factions: readonly Faction[], characters: readonly Character[], playerFactionId: ReturnType<typeof asFactionId> | null): GameState {
  return {
    turn: 1,
    year: 1000,
    phase: "year_end",
    regions: {},
    factions: Object.fromEntries(factions.map((f) => [f.id, f])),
    armies: {},
    characters: Object.fromEntries(characters.map((c) => [c.id, c])),
    captivities: {},
    greatWarTriggered: false,
    playerFactionId,
    spectator: null,
  };
}

describe("evaluatePlayerGameOver", () => {
  it("プレイヤー不在（playerFactionId が null）なら常に kind: null", () => {
    const state = makeState([], [], null);
    expect(evaluatePlayerGameOver(state)).toEqual({ kind: null });
  });

  it("勢力所属の全員が死亡していれば annihilation（滅亡）", () => {
    const factionId = asFactionId("faction_player");
    const ruler = makeCharacter({ id: asCharacterId("ruler"), name: "君主", faction: factionId, alive: false });
    const warlord = makeCharacter({ id: asCharacterId("wl"), name: "隊長", faction: factionId, role: "warlord", alive: false });
    const faction = makeFaction({ id: factionId, name: "滅亡した家", ruler: ruler.id, regions: [] });
    const state = makeState([faction], [ruler, warlord], factionId);

    expect(evaluatePlayerGameOver(state)).toEqual({ kind: "annihilation" });
  });

  it("宗主（suzerain）を持てば capitulation/vassalized", () => {
    const factionId = asFactionId("faction_player");
    const overlordId = asFactionId("faction_overlord");
    const ruler = makeCharacter({ id: asCharacterId("ruler"), name: "君主", faction: factionId });
    const faction = makeFaction({ id: factionId, name: "臣従した家", ruler: ruler.id, suzerain: overlordId, regions: [] });
    const state = makeState([faction], [ruler], factionId);

    expect(evaluatePlayerGameOver(state)).toEqual({ kind: "capitulation", capitulationReason: "vassalized" });
  });

  it("州も軍団も失い、宗主もいなければ capitulation/surrender", () => {
    const factionId = asFactionId("faction_player");
    const ruler = makeCharacter({ id: asCharacterId("ruler"), name: "君主", faction: factionId });
    const faction = makeFaction({ id: factionId, name: "降伏した家", ruler: ruler.id, regions: [] });
    const state = makeState([faction], [ruler], factionId);

    expect(evaluatePlayerGameOver(state)).toEqual({ kind: "capitulation", capitulationReason: "surrender" });
  });

  it("州を保持していれば何もゲームオーバー条件を満たさない", () => {
    const factionId = asFactionId("faction_player");
    const ruler = makeCharacter({ id: asCharacterId("ruler"), name: "君主", faction: factionId });
    const faction = makeFaction({ id: factionId, name: "健在な家", ruler: ruler.id, regions: [asRegionId("dummy_region")] });
    const state = makeState([faction], [ruler], factionId);

    expect(evaluatePlayerGameOver(state)).toEqual({ kind: null });
  });
});

describe("傍観モード・再起チャンス", () => {
  const playerFactionId = asFactionId("faction_player");
  const hostFactionId = asFactionId("faction_host");

  it("enterSpectatorMode は元の勢力IDを記録した SpectatorState を設定する", () => {
    const state = makeState([], [], playerFactionId);
    const next = enterSpectatorMode(state, hostFactionId, "vassalized");

    expect(next.spectator).toEqual({
      hostFactionId,
      reason: "vassalized",
      since: state.year,
      originalFactionId: playerFactionId,
    });
  });

  it("ホスト勢力が健在なら再起チャンスは成立しない", () => {
    const host = makeFaction({ id: hostFactionId, name: "宗主国", ruler: asCharacterId("host_ruler") });
    let state = makeState([host], [], playerFactionId);
    state = enterSpectatorMode(state, hostFactionId, "vassalized");

    expect(checkComebackOpportunity(state)).toBe(false);
  });

  it("ホスト勢力が後継者なし（ruler: null）になると再起チャンスが成立する", () => {
    const host = makeFaction({ id: hostFactionId, name: "宗主国", ruler: null });
    let state = makeState([host], [], playerFactionId);
    state = enterSpectatorMode(state, hostFactionId, "vassalized");

    expect(checkComebackOpportunity(state)).toBe(true);
  });

  it("reclaimIndependence は元の勢力の宗主を外し、独立を回復する", () => {
    const original = makeFaction({
      id: playerFactionId,
      name: "元の勢力",
      ruler: asCharacterId("original_ruler"),
      suzerain: hostFactionId,
      diplomacy: { [hostFactionId]: "vassal" },
    });
    const host = makeFaction({ id: hostFactionId, name: "宗主国", ruler: null });
    let state = makeState([original, host], [], playerFactionId);
    state = enterSpectatorMode(state, hostFactionId, "vassalized");

    const next = reclaimIndependence(state);

    expect(next.spectator).toBeNull();
    expect(next.playerFactionId).toBe(playerFactionId);
    expect(next.factions[playerFactionId]?.suzerain).toBeNull();
    expect(next.factions[playerFactionId]?.diplomacy[hostFactionId]).toBe("peace");
  });

  it("giveUpSpectating は傍観をやめ、プレイヤー不在の状態にする", () => {
    let state = makeState([], [], playerFactionId);
    state = enterSpectatorMode(state, hostFactionId, "surrender");

    const next = giveUpSpectating(state);
    expect(next.spectator).toBeNull();
    expect(next.playerFactionId).toBeNull();
  });
});

describe("血縁による再起（滅亡からの再開）", () => {
  it("最も血縁の近い、現存する他家当主を見つけて再開できる", () => {
    const extinctFactionId = asFactionId("faction_extinct");
    const distantFactionId = asFactionId("faction_distant_cousin");
    const closeFactionId = asFactionId("faction_close_cousin");

    const deceasedRuler = makeCharacter({
      id: asCharacterId("deceased"),
      name: "滅亡した当主",
      faction: extinctFactionId,
      alive: false,
      parents: [asCharacterId("shared_grandparent")],
    });
    const sharedGrandparent = makeCharacter({
      id: asCharacterId("shared_grandparent"),
      name: "共通の祖先",
      faction: extinctFactionId,
      alive: false,
      children: [deceasedRuler.id, asCharacterId("close_cousin_parent")],
    });
    const closeCousinParent = makeCharacter({
      id: asCharacterId("close_cousin_parent"),
      name: "近縁の親",
      faction: closeFactionId,
      alive: false,
      parents: [sharedGrandparent.id],
      children: [asCharacterId("close_cousin")],
    });
    const closeCousin = makeCharacter({
      id: asCharacterId("close_cousin"),
      name: "近縁の当主",
      faction: closeFactionId,
      role: "ruler",
      parents: [closeCousinParent.id],
    });
    const distantRuler = makeCharacter({
      id: asCharacterId("distant_ruler"),
      name: "無関係の当主",
      faction: distantFactionId,
      role: "ruler",
    });

    const extinctFaction = makeFaction({ id: extinctFactionId, name: "滅亡した家", ruler: null, alive: false });
    const closeFaction = makeFaction({ id: closeFactionId, name: "近縁の家", ruler: closeCousin.id });
    const distantFaction = makeFaction({ id: distantFactionId, name: "無関係の家", ruler: distantRuler.id });

    const state = makeState(
      [extinctFaction, closeFaction, distantFaction],
      [deceasedRuler, sharedGrandparent, closeCousinParent, closeCousin, distantRuler],
      extinctFactionId,
    );

    const found = findClosestSurvivingRuler(state, extinctFactionId);
    expect(found?.factionId).toBe(closeFactionId);

    const next = restartAsClosestKin(state, extinctFactionId);
    expect(next.playerFactionId).toBe(closeFactionId);
    expect(next.spectator).toBeNull();
  });

  it("姻戚関係にある再起先が見つからなければ state をそのまま返す", () => {
    const extinctFactionId = asFactionId("faction_extinct");
    const deceasedRuler = makeCharacter({ id: asCharacterId("deceased"), name: "滅亡した当主", faction: extinctFactionId, alive: false });
    const extinctFaction = makeFaction({ id: extinctFactionId, name: "滅亡した家", ruler: null, alive: false });
    const state = makeState([extinctFaction], [deceasedRuler], extinctFactionId);

    expect(findClosestSurvivingRuler(state, extinctFactionId)).toBeNull();
    expect(restartAsClosestKin(state, extinctFactionId)).toBe(state);
  });
});
