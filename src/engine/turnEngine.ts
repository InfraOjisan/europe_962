import { effectiveStrength, totalTroops, type Army } from "../models/army.js";
import type { CasualtyReport } from "../models/battle.js";
import type { Campaign } from "../models/campaign.js";
import type { Character } from "../models/character.js";
import { isAtWar, type DiplomaticStance, type Faction } from "../models/faction.js";
import { asArmyId, asCharacterId, asFactionId } from "../models/ids.js";
import type { ImperialTitle } from "../models/imperialTitle.js";
import type { FactionId, GameState, Policy, Region, RegionId, TurnPhase } from "../models/index.js";
import type { DecisionOption, RandomSource } from "./aiPolicy.js";
import { assignRandomPolicy, decideByScoring, defaultRandomSource, scoreOption } from "./aiPolicy.js";
import type { AIProviderConfig } from "./aiProvider.js";
import { decideAction } from "./aiProvider.js";
import { registerCapture } from "./captivity.js";
import type { CausalityGuardRegistry } from "./causalityGuard.js";
import { resolveBattle, type BattleResolutionInput } from "./combatEngine.js";
import { findEscapeRegion } from "./combatEngine.js";
import { armyUpkeep, calculateEffectiveTax, garrisonUpkeep, rollWeatherFactor } from "./economy.js";
import { applyYearStartEvents } from "./eventEngine.js";
import { HRE_CORE_FACTION_IDS, HRE_ELECTOR_FACTION_IDS, type HistoricalEvent } from "../data/historicalEvents.js";
import type { OffMapThreatDefinition } from "../data/offMapThreats.js";
import { rollOffMapThreats } from "./offMapThreats.js";
import { applySuccession } from "./succession.js";
import { checkGreatWar, greatWarProximity } from "./warCheck.js";

/**
 * ⚠️ ターンエンジン（草案）
 * ============================================================
 * 設計書 1.1 の5フェイズ（年始→外交→行動→戦闘解決→年末集計）を実際に回す
 * オーケストレーション層。combatEngine / succession / captivity / warCheck /
 * economy / eventEngine を1つの `advanceYear` にまとめ、ゲームを実際に
 * 前進させられる状態にする。
 *
 * 外交フェイズ・行動フェイズは AI・プレイヤー入力が未実装のため現状スタブ
 * （フェイズを進めるだけ）。設計書 9章の「AI意思決定システム」に対応する。
 * 戦闘解決フェイズは設計書 3.7 節の多重戦闘・奇襲・挟撃の判定ロジックに従う。
 * 年末集計フェイズは設計書 10章の税収・維持費計算を行う。
 */

/** 奇襲成立の指揮能力の閾値（設計書 3.7、仮値）。 */
const SURPRISE_COMMAND_THRESHOLD = 0.7;
/** 同一州・同一ターン内で連続解決する遭遇戦の上限（無限ループ防止の安全弁）。 */
const MAX_ENCOUNTERS_PER_REGION = 20;
/**
 * 「近攻遠交」（設計書 9.4）：隣接する相手との軍事力比がこの値を下回ると
 * 「明確に劣勢＝脅威」とみなし、その脅威を挟んで反対側にいる勢力へ同盟を
 * 持ちかける動機になる（`findThreatNeighbor`）。仮値・要継続バランス調整。
 */
const THREAT_RATIO_THRESHOLD = 0.75;
/**
 * 帝位の特典（設計書 4.4／ユーザー要望）：神聖ローマ皇帝への大義なき開戦は
 * 正当性（legitimacy）・安全性（safety、他の諸侯の介入を招く政治的リスクとして表現）の
 * 両スコアをこの分だけ下げる（あくまで穏やかなバイアスであり、絶対的な禁止ではない
 * ——史実でも皇帝への反乱・帝国追放〈Reichsacht〉は起きている）。仮値・要継続バランス調整。
 */
const IMPERIAL_TITLE_WAR_LEGITIMACY_PENALTY = 0.3;
const IMPERIAL_TITLE_WAR_SAFETY_PENALTY = 0.25;
/** 帝位保持者への毎年の帝国税収ボーナス（設計書 4.4／ユーザー要望、仮値）。 */
const IMPERIAL_TITLE_TAX_BONUS = 500;

/**
 * ターン進行の各フェイズに渡す実行時オプション。
 * - guards:  因果律の保護（3.6章）。省略時は何も補正しない。
 * - random:  天候抽選（10.2章）・版図外勢力の襲来抽選（13章）などに使う乱数源。省略時は `Math.random`。
 * - events:  年始フェイズで適用する史実イベント年表（11章）。省略時は全イベント有効、
 *            空配列を渡せば無効化できる。
 * - offMapThreats: 年始フェイズで判定する版図外勢力の襲来定義（13章）。省略時は全脅威有効、
 *            空配列を渡せば無効化できる。
 */
export interface TurnEngineOptions {
  readonly guards?: CausalityGuardRegistry;
  readonly random?: RandomSource;
  readonly events?: readonly HistoricalEvent[];
  readonly offMapThreats?: readonly OffMapThreatDefinition[];
}

/** 戦闘結果の死傷者数・捕虜数を実際の Army の兵科構成に按分して反映する（近似）。 */
function applyArmyCasualties(army: Army, casualties: CasualtyReport): Army {
  const startTotal = totalTroops(army);
  const totalLost = casualties.killed + casualties.captured;
  if (startTotal === 0) return { ...army, morale: casualties.moraleAfter };

  const survivingFraction = Math.max(0, Math.min(1, (startTotal - totalLost) / startTotal));
  const units = army.units.map((u) => ({ ...u, count: Math.max(0, Math.round(u.count * survivingFraction)) }));
  return { ...army, units, morale: casualties.moraleAfter };
}

/**
 * 州の占領によって最後の領土を失った勢力を滅亡（`alive: false`）として扱う
 * （`succession.ts` の家系断絶・拘束による解体と同じ表現規約：勢力そのものは
 * 残すが、州は接収可能な係争地として扱う）。
 *
 * これが無いと、征服し尽くした後も敗者が「生存」扱いのまま外交関係だけが
 * 残り続け、`pickBestDiplomaticMove` が実体のない相手との関係（もはや動かしようが
 * ない継続中の「戦争」など）を毎ターン最善手として選び続けてしまい、他の生きた
 * 勢力との新たな外交・軍事上の変化が起きにくくなる（「変化が少ない」という
 * フィードバックの一因）。
 */
function eliminateFactionIfLandless(factions: GameState["factions"], factionId: FactionId): GameState["factions"] {
  const faction = factions[factionId];
  if (!faction || !faction.alive || faction.regions.length > 0) return factions;
  return { ...factions, [factionId]: { ...faction, alive: false, ruler: null, heir: null } };
}

/** 1件の戦闘結果（因果律の保護を通した後）を GameState に反映する。 */
function applyBattleOutcome(
  state: GameState,
  input: BattleResolutionInput,
  guards: CausalityGuardRegistry | undefined,
): GameState {
  const rawOutcome = resolveBattle(input);
  const outcome = guards ? guards.apply(rawOutcome, { turn: state.turn }, input) : rawOutcome;

  const attackerArmy = state.armies[outcome.attackerArmy];
  const defenderArmy = state.armies[outcome.defenderArmy];
  if (!attackerArmy || !defenderArmy) return state;

  let updatedAttacker = applyArmyCasualties(attackerArmy, outcome.attackerCasualties);
  let updatedDefender = applyArmyCasualties(defenderArmy, outcome.defenderCasualties);

  let regions = state.regions;
  let factions = state.factions;
  if (outcome.kind === "occupation" && outcome.newOwner) {
    const region = regions[outcome.region];
    const previousOwner = region?.owner;
    const newOwner = outcome.newOwner;
    if (region && previousOwner && previousOwner !== newOwner) {
      regions = { ...regions, [outcome.region]: { ...region, owner: newOwner } };
      const loserFaction = factions[previousOwner];
      const winnerFaction = factions[newOwner];
      factions = {
        ...factions,
        ...(loserFaction
          ? { [previousOwner]: { ...loserFaction, regions: loserFaction.regions.filter((r) => r !== outcome.region) } }
          : {}),
        ...(winnerFaction
          ? { [newOwner]: { ...winnerFaction, regions: [...winnerFaction.regions, outcome.region] } }
          : {}),
      };
      if (previousOwner) factions = eliminateFactionIfLandless(factions, previousOwner);
    }
  }

  if (outcome.kind === "retreat" && outcome.retreatingSide) {
    const region = regions[outcome.region];
    const loserFaction = outcome.retreatingSide === "attacker" ? outcome.attacker : outcome.defender;
    const escapeRegionId = region ? findEscapeRegion(loserFaction, region, regions) : null;
    if (escapeRegionId) {
      if (outcome.retreatingSide === "attacker") updatedAttacker = { ...updatedAttacker, location: escapeRegionId };
      else updatedDefender = { ...updatedDefender, location: escapeRegionId };
    }
  }

  let next: GameState = { ...state, regions, factions };
  next = registerCapture(next, outcome);

  const armies = { ...next.armies };
  if (totalTroops(updatedAttacker) > 0) armies[updatedAttacker.id] = updatedAttacker;
  else delete armies[updatedAttacker.id];
  if (totalTroops(updatedDefender) > 0) armies[updatedDefender.id] = updatedDefender;
  else delete armies[updatedDefender.id];

  return { ...next, armies };
}

/**
 * 州の駐留兵（`Region.garrison`）を、野戦軍が不在の州へ侵入してきた敵に対する
 * 防衛力として一時的な Army 形へ変換する。`state.armies` には登録しない
 * （駐留兵はArmyエンティティではなく州直属の防衛力という位置づけを保つため）。
 */
function phantomGarrisonArmy(region: Region): Army {
  return {
    id: asArmyId(`__garrison_${region.id}`),
    faction: region.owner,
    commander: null,
    location: region.id,
    units: [{ type: "infantry", count: region.garrison.count, training: region.garrison.training }],
    doctrine: "default",
    morale: 0.5,
    supply: 1.0,
  };
}

/**
 * 野戦軍が守っていない州（領有勢力側の Army が既に不在／全滅済み）へ、敵対勢力の
 * 軍が侵入した場合の戦闘解決。`applyBattleOutcome` と異なり、防御側は
 * `phantomGarrisonArmy` で表現される駐留兵であり、Army エンティティとして
 * 永続化しない（占領されなかった場合は `Region.garrison.count` を直接減らす）。
 *
 * 駐留兵は州に固定された防衛力であり、他州へ移動しうる野戦軍とは性質が異なるため、
 * 「退却」判定（`retreatingSide === "defender"`）になった場合も駐留兵を隣接州へ
 * 移動させることはせず、消耗のみを反映する（占領には至らない、という結果は保持する）。
 */
function resolveGarrisonDefense(
  state: GameState,
  input: BattleResolutionInput,
  guards: CausalityGuardRegistry | undefined,
): GameState {
  const rawOutcome = resolveBattle(input);
  const outcome = guards ? guards.apply(rawOutcome, { turn: state.turn }, input) : rawOutcome;

  const attackerArmy = state.armies[outcome.attackerArmy];
  const region = state.regions[outcome.region];
  if (!attackerArmy || !region) return state;

  let updatedAttacker = applyArmyCasualties(attackerArmy, outcome.attackerCasualties);
  if (outcome.kind === "retreat" && outcome.retreatingSide === "attacker") {
    const escapeRegionId = findEscapeRegion(outcome.attacker, region, state.regions);
    if (escapeRegionId) updatedAttacker = { ...updatedAttacker, location: escapeRegionId };
  }
  const garrisonLoss = outcome.defenderCasualties.killed + outcome.defenderCasualties.captured;
  const survivingGarrison = Math.max(0, region.garrison.count - garrisonLoss);

  let regions = state.regions;
  let factions = state.factions;

  if (outcome.kind === "occupation" && outcome.newOwner && outcome.newOwner !== region.owner) {
    const previousOwner = region.owner;
    const newOwner = outcome.newOwner;
    regions = { ...regions, [region.id]: { ...region, owner: newOwner, garrison: { count: 0, training: 0 } } };
    const loserFaction = factions[previousOwner];
    const winnerFaction = factions[newOwner];
    factions = {
      ...factions,
      ...(loserFaction
        ? { [previousOwner]: { ...loserFaction, regions: loserFaction.regions.filter((r) => r !== region.id) } }
        : {}),
      ...(winnerFaction ? { [newOwner]: { ...winnerFaction, regions: [...winnerFaction.regions, region.id] } } : {}),
    };
    factions = eliminateFactionIfLandless(factions, previousOwner);
  } else {
    regions = { ...regions, [region.id]: { ...region, garrison: { ...region.garrison, count: survivingGarrison } } };
  }

  let next: GameState = { ...state, regions, factions };
  next = registerCapture(next, outcome); // 攻撃側指揮官が守備隊に敗れ捕縛される可能性のみ登録される

  const armies = { ...next.armies };
  if (totalTroops(updatedAttacker) > 0) armies[updatedAttacker.id] = updatedAttacker;
  else delete armies[updatedAttacker.id];

  return { ...next, armies };
}

// --- 神聖ローマ皇帝の継承・選挙（設計書 4.4／ユーザー要望） -------------------
//
// 「神聖ローマ帝国」を特定の家系（`faction_hre`）に固定しないための独立した状態
// （`GameState.imperialTitle`、`models/imperialTitle.ts`）。保持者の家系が存続する
// 限り帝位はそのまま——「元帝の嫡出子が優先される」というユーザー要望のルールは、
// 既存の継承システム（`resolveSuccession` が `Faction.heir` を優先する）にそのまま
// 委ねる形で実現している：帝位保持者の勢力が同じ家系のまま存続すれば、それだけで
// 「嫡出子（後継者）が継いだ」ことになるため、改めて判定する必要が無い。
// 保持者の勢力が滅亡・解体（後継者危機で継ぐ者がいなかった場合を含む）、または
// 誰かに服属した場合にのみ、選帝侯による選挙（`electImperialTitle`）を行う。

/**
 * 選帝侯による皇帝選挙（ユーザー要望）。優先順位：
 *   1. 選帝侯7家（`HRE_ELECTOR_FACTION_IDS`）のうち、同盟関係にある家の数が
 *      最も多い候補を選ぶ（＝選帝侯からの支持が厚い候補）
 *   2. 同数なら、経済力（`factionEconomicStrength`）に対して軍事力
 *      （`factionMilitaryStrength`）が小さい候補を優先する——「賄賂を贈れて、
 *      選帝侯自身の脅威にならない」候補ほど選ばれやすい、というルール
 *      （史実でルドルフ1世が選ばれた事情の再現）
 *   3. 教皇領と交戦中の候補は除外する
 * 候補者プールは帝国本体14勢力（`HRE_CORE_FACTION_IDS`）——史実のルドルフ1世同様、
 * 選帝侯自身である必要はない。服属中（`suzerain !== null`）の勢力も除外する
 * （独立して立てる主体ではないため）。該当者がいなければ null（空位）。
 */
function electImperialTitle(state: GameState): FactionId | null {
  const papal = asFactionId("faction_papal");
  let best: { readonly id: FactionId; readonly allianceCount: number; readonly wealthPerThreat: number } | null = null;

  for (const candidateId of HRE_CORE_FACTION_IDS) {
    const candidate = state.factions[candidateId];
    if (!candidate || !candidate.alive || candidate.type !== "lord" || candidate.suzerain !== null) continue;
    if (candidate.diplomacy[papal] === "war") continue;

    const allianceCount = HRE_ELECTOR_FACTION_IDS.filter((electorId) => {
      if (electorId === candidateId) return false;
      const elector = state.factions[electorId];
      return elector?.alive && elector.diplomacy[candidateId] === "alliance";
    }).length;
    const wealthPerThreat = factionEconomicStrength(state, candidateId) / Math.max(1, factionMilitaryStrength(state, candidateId));

    if (
      !best ||
      allianceCount > best.allianceCount ||
      (allianceCount === best.allianceCount && wealthPerThreat > best.wealthPerThreat)
    ) {
      best = { id: candidateId, allianceCount, wealthPerThreat };
    }
  }
  return best?.id ?? null;
}

/**
 * 帝位の状態を1年分進める。`runYearStart` の継承処理の直後に呼ぶ。
 * `imperialTitle === undefined`（フィールド自体が無い、既存の GameState リテラルとの
 * 後方互換）は帝位継承の仕組みを無効化した状態として扱い、以後一切手を付けない。
 * 対して `imperialTitle === null` は「制度は有効だが現在空位」を意味し、こちらは
 * 埋まる候補が現れるまで毎年選挙を試み続ける（さもないと一度空位になった帝位が
 * 二度と埋まらなくなる——シミュレーションで実際に確認したバグ）。
 */
function advanceImperialTitle(state: GameState): GameState {
  if (state.imperialTitle === undefined) return state;
  const holder = state.imperialTitle ? state.factions[state.imperialTitle.holderId] : null;
  if (holder && holder.alive && holder.suzerain === null) return state; // 家系が存続中はそのまま

  const winnerId = electImperialTitle(state);
  const nextTitle: ImperialTitle | null = winnerId ? { holderId: winnerId, since: state.year } : null;
  return { ...state, imperialTitle: nextTitle };
}

// --- ① 年始フェイズ ---------------------------------------------------------

function runYearStart(state: GameState, options: TurnEngineOptions): GameState {
  const random = options.random ?? defaultRandomSource;
  let next = state;
  for (const faction of Object.values(state.factions)) {
    if (!faction.alive || faction.ruler === null) continue;
    const ruler = next.characters[faction.ruler];
    if (ruler && !ruler.alive) {
      next = applySuccession(next, ruler.id, faction.id);
    }
  }
  // 神聖ローマ皇帝の継承・選挙（設計書 4.4／ユーザー要望）。上記の継承処理の直後に行うことで、
  // 帝位保持者の家系が（平和的に）存続したかどうかを判定できる。
  next = advanceImperialTitle(next);
  // 史実イベント年表（設計書 11章）。options.events に空配列を渡せば無効化できる。
  next = applyYearStartEvents(next, options.events).state;
  // 版図外勢力（モンゴル・ティムール・オスマン＝ペルシャ等）の天災的襲来（設計書 13章）。
  // options.offMapThreats に空配列を渡せば無効化できる。
  next = rollOffMapThreats(next, random, options.offMapThreats).state;
  // TODO: 疫病（黒死病以外の局地的な発生）・宗教などのランダムイベント抽選
  return { ...next, phase: "diplomacy" };
}

// --- ② 外交フェイズ・③ 行動フェイズ（設計書 9.4／13章：AI接続） ---------------
//
// 方針（設計書 9.4）：ゲームは約1000ターンに及ぶため、毎ターン・全勢力ペア・全軍団に
// 生成AI丸投げ方式（ネットワークI/O、非同期）を使うのは性能・コスト面で非現実的。
// そこで `runDiplomacy`/`runAction`（本体・同期）は常に `decideByScoring`（点数判断、
// ネットワーク不要・決定的）で全AI勢力を動かす。生成AI丸投げ方式は、これと業務ロジックを
// 完全に共有した非同期版 `runDiplomacyAsync`/`runActionAsync` として別途提供し、
// 「大戦への接近が著しい」「歴史的な転換点」など、呼び出し側が"major decision"と判断した
// ターン・局面でだけ、これらの非同期版を代わりに呼び出す形でオプトインする
// （AIInvocationPolicy: "scoring_only"（既定・本体が使う） | "llm_for_major_decisions"）。
//
// AIが選択肢を評価する際、「大戦（世界同時多発戦争）への近さ」（`warCheck.ts` の
// `greatWarProximity`）を必ず考慮する。生成AI丸投げ方式では `DecisionContext.greatWarProximity`
// として必須で渡し（ユーザー要望：「世界のゲームオーバーは必ずAIへの丸投げ時は前提に入れる」）、
// 点数判断でも同じ値を使って開戦・同盟破棄系の選択肢の safety スコアを下げることで、
// 両方式で「無闇な開戦は破局を早める」という一貫したバイアスをかける。
//
// プレイヤーの勢力（`GameState.playerFactionId`）は自動決定の対象から常に除外する
// （傍観モード中にホスト勢力の行動までAIに委ねるかはUI層の選択に委ねる）。
//
// スコープの限定（設計書 12章、今後の課題）：外交フェイズの選択肢は、UIモックアップの
// 深さに合わせて「継続/和平」「宣戦/同盟提案/現状維持」「同盟維持/破棄」に限定し、
// 婚姻協定・人質提供・傭兵雇用交渉は現時点ではAIの自動判断対象に含めない
// （プレイヤーコマンドとしては `succession.ts`/`captivity.ts` に実装済み）。

/** 外交フェイズの意思決定における「世界情勢」共通コンテキスト。 */
function worldSituationSummary(proximity: number): string {
  return `大戦（世界同時多発戦争によるゲームオーバー）への近さ: ${Math.round(proximity * 100)}%`;
}

/** 勢力の総合軍事力（保有する全野戦軍の実効兵力＋全州の駐留兵）。 */
function factionMilitaryStrength(state: GameState, factionId: FactionId): number {
  let total = 0;
  for (const army of Object.values(state.armies)) {
    if (army.faction === factionId) total += effectiveStrength(army);
  }
  for (const region of Object.values(state.regions)) {
    if (region.owner === factionId) total += region.garrison.count * region.garrison.training;
  }
  return total;
}

/** 2勢力間の軍事力比（自軍 / 相手軍、駐留兵含む）。1を超えるほど自軍優勢。 */
function militaryStrengthRatio(state: GameState, selfId: FactionId, counterpartId: FactionId): number {
  return factionMilitaryStrength(state, selfId) / Math.max(1, factionMilitaryStrength(state, counterpartId));
}

/**
 * 自勢力に隣接（＝ `Faction.diplomacy` にエントリがある）する勢力の中で、自分が
 * 明確に劣勢な相手（＝軍事的な脅威）を1つ返す。複数いる場合は最も強い（比率が最小の）
 * ものを選ぶ。存在しなければ null。
 */
function findThreatNeighbor(state: GameState, selfId: FactionId): { readonly threatId: FactionId; readonly ratio: number } | null {
  const self = state.factions[selfId];
  if (!self) return null;

  let worst: { threatId: FactionId; ratio: number } | null = null;
  for (const counterpartId of Object.keys(self.diplomacy) as FactionId[]) {
    const counterpart = state.factions[counterpartId];
    if (!counterpart || !counterpart.alive) continue;
    const ratio = militaryStrengthRatio(state, selfId, counterpartId);
    if (ratio < THREAT_RATIO_THRESHOLD && (!worst || ratio < worst.ratio)) {
      worst = { threatId: counterpartId, ratio };
    }
  }
  return worst;
}

/**
 * `threatId` の勢力が領有する州に隣接する州を持つ、`selfId`・`threatId` 以外の勢力一覧
 * （＝threatを挟んで自分の反対側にいる、"遠交" の候補）。
 */
function findSharedBorderFactions(state: GameState, selfId: FactionId, threatId: FactionId): readonly FactionId[] {
  const threat = state.factions[threatId];
  if (!threat) return [];
  const candidates = new Set<FactionId>();
  for (const regionId of threat.regions) {
    const region = state.regions[regionId];
    if (!region) continue;
    for (const neighborId of region.adjacency) {
      const ownerId = state.regions[neighborId]?.owner;
      if (ownerId && ownerId !== selfId && ownerId !== threatId) candidates.add(ownerId);
    }
  }
  return [...candidates];
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/**
 * ある外交上の決定を適用した結果、その一手だけで大戦（世界のゲームオーバー）が
 * 発生してしまうかを判定する。個々のAIの選択肢スコアリングは「大戦への近さ」を
 * 徐々に safety へ織り込むだけの緩やかなバイアスに留まる（設計書 9.4）ため、
 * 小規模シナリオでは複数勢力の"局所的には合理的な"決定が同一ターン内で積み重なり、
 * 誰も意図せず大戦条件を満たしてしまうことがありうる。
 * これを避ける最終防波堤として、「自分のこの一手が単独で世界を終わらせる」場合に限り、
 * その決定を見送る（ユーザー要望：「世界のゲームオーバーは必ずAIへの丸投げ時は前提に入れる」の
 * 最も強い実装形。無条件の厭戦ではなく、まさに引き金を引く一手だけを拒否する）。
 */
function wouldSingleHandedlyTriggerGreatWar(state: GameState, candidateFactions: GameState["factions"]): boolean {
  return checkGreatWar({ ...state, factions: candidateFactions }).triggered;
}

interface DiplomaticOptionsResult {
  readonly stance: DiplomaticStance;
  readonly options: readonly DecisionOption[];
}

/**
 * 現在の外交状態（war/peace/alliance）に応じた選択肢を組み立てる（設計書 9.4）。
 * "vassal" 状態（宗主・臣下関係）は本パスでは自動判断の対象外（臣下側の反乱等は今後の課題）。
 * 相手が死亡している、または関係が未定義（`diplomacy` にキーがない）場合は null。
 */
function buildDiplomaticOptions(
  state: GameState,
  selfId: FactionId,
  counterpartId: FactionId,
  proximity: number,
): DiplomaticOptionsResult | null {
  const self = state.factions[selfId];
  const counterpart = state.factions[counterpartId];
  if (!self || !counterpart || !counterpart.alive) return null;
  const stance = self.diplomacy[counterpartId];
  if (stance === undefined || stance === "vassal") return null;

  const ratio = militaryStrengthRatio(state, selfId, counterpartId);
  // 帝位の特典（実装済み、ユーザー要望）：神聖ローマ皇帝への大義なき開戦は
  // 正当性（legitimacy）を損なう。`imperialTitle` は特定の家系に固定されないため、
  // 保持者は史実の推移次第で入れ替わりうる（4.4章）。
  const isCounterpartEmperor = state.imperialTitle?.holderId === counterpartId;

  if (stance === "war") {
    return {
      stance,
      options: [
        {
          label: "A",
          description: `${counterpart.name}との戦争を継続する`,
          safety: clamp01((ratio >= 1 ? 0.6 : 0.3) - proximity * 0.3),
          expansion: ratio >= 1 ? 0.8 : 0.3,
          profit: 0.3,
          legitimacy: 0.3,
        },
        {
          label: "B",
          description: `${counterpart.name}に和平を申し入れる`,
          safety: clamp01(0.7 + proximity * 0.3),
          expansion: 0.1,
          profit: 0.4,
          legitimacy: 0.6,
        },
      ],
    };
  }

  if (stance === "peace") {
    return {
      stance,
      options: [
        {
          label: "A",
          description: `${counterpart.name}に宣戦布告する`,
          safety: clamp01((ratio >= 1.3 ? 0.6 : 0.25) - proximity * 0.4 - (isCounterpartEmperor ? IMPERIAL_TITLE_WAR_SAFETY_PENALTY : 0)),
          expansion: ratio >= 1.3 ? 0.9 : 0.4,
          profit: 0.3,
          legitimacy: clamp01(0.1 - (isCounterpartEmperor ? IMPERIAL_TITLE_WAR_LEGITIMACY_PENALTY : 0)),
        },
        {
          label: "B",
          description: `${counterpart.name}に同盟を提案する`,
          safety: 0.6,
          expansion: 0.3,
          profit: 0.3,
          legitimacy: 0.7,
        },
        {
          label: "C",
          description: `${counterpart.name}との和平を維持する`,
          safety: 0.8,
          expansion: 0.1,
          profit: 0.4,
          legitimacy: 0.6,
        },
      ],
    };
  }

  // stance === "alliance"
  return {
    stance,
    options: [
      {
        label: "A",
        description: `${counterpart.name}との同盟を維持する`,
        safety: 0.7,
        expansion: 0.3,
        profit: 0.4,
        legitimacy: 0.8,
      },
      {
        label: "B",
        description: `${counterpart.name}との同盟を破棄して開戦する`,
        safety: clamp01((ratio >= 1.6 ? 0.45 : 0.1) - proximity * 0.4 - (isCounterpartEmperor ? IMPERIAL_TITLE_WAR_SAFETY_PENALTY : 0)),
        expansion: ratio >= 1.6 ? 0.85 : 0.2,
        profit: 0.3,
        legitimacy: clamp01(0.03 - (isCounterpartEmperor ? IMPERIAL_TITLE_WAR_LEGITIMACY_PENALTY : 0)),
      },
    ],
  };
}

/** 選択された外交選択肢を実際の外交状態遷移に変換する（現状維持を選んだ場合は変化なし）。 */
function applyDiplomaticChoice(
  factions: GameState["factions"],
  selfId: FactionId,
  counterpartId: FactionId,
  stance: DiplomaticStance,
  chosenLabel: string,
): GameState["factions"] {
  const self = factions[selfId];
  const counterpart = factions[counterpartId];
  if (!self || !counterpart) return factions;

  let newStance: DiplomaticStance | null = null;
  if (stance === "war" && chosenLabel === "B") newStance = "peace";
  else if (stance === "peace" && chosenLabel === "A") newStance = "war";
  else if (stance === "peace" && chosenLabel === "B") newStance = "alliance";
  else if (stance === "alliance" && chosenLabel === "B") newStance = "war";
  if (newStance === null) return factions;

  return {
    ...factions,
    [selfId]: { ...self, diplomacy: { ...self.diplomacy, [counterpartId]: newStance } },
    [counterpartId]: { ...counterpart, diplomacy: { ...counterpart.diplomacy, [selfId]: newStance } },
  };
}

/**
 * 外交上の一手。既存の関係（war/peace/alliance）を遷移させる "adjust" と、
 * まだ関係を持たない遠方の勢力へ新たに同盟を持ちかける "new_alliance"（近攻遠交、下記）
 * の2種類がある。
 */
type DiplomaticMove =
  | { readonly kind: "adjust"; readonly counterpartId: FactionId; readonly stance: DiplomaticStance; readonly option: DecisionOption; readonly score: number }
  | { readonly kind: "new_alliance"; readonly counterpartId: FactionId; readonly option: DecisionOption; readonly score: number };

/** 「脅威を挟んで反対側の勢力に同盟を持ちかける（遠交）」選択肢のスコア（設計書 9.4、仮値）。 */
function distantAllianceOption(threatName: string, candidateName: string): DecisionOption {
  return {
    label: "E",
    description: `${threatName}への牽制を念頭に、${candidateName}に同盟を持ちかける（遠交）`,
    safety: 0.8,
    expansion: 0.2,
    profit: 0.1,
    legitimacy: 0.7,
  };
}

/**
 * ある勢力について、まだこのターン処理されていない相手ごとに最善手を評価し、
 * 勢力全体としては最もスコアの高い1件だけを実行対象として選ぶ。
 * 「1年（1ターン）につき、外交上の大きな方針転換は1つまで」という抽象化により、
 * 同時多方面への宣戦布告のような不自然な暴走（史実にそぐわず、大戦条件も
 * 不用意に満たしてしまう）を避ける（設計書 9.4、要継続バランス調整）。
 *
 * 「近攻遠交」（ユーザー要望）：隣接する既存の関係の見直しに加えて、自分にとって
 * 明確な脅威となっている隣国（`findThreatNeighbor`）がいる場合、その脅威を挟んで
 * 反対側にいる勢力（`findSharedBorderFactions`）へ新たに同盟を持ちかける選択肢も
 * 候補に加える——遠くの勢力と結び、近くの脅威を包囲する動機を持たせる。
 *
 * `commitmentTargetId`（大国キャンペーンAI、下記参照）が指定されている場合、その相手との
 * 関係が交戦中であれば「和平を申し入れる」選択肢を評価対象から外す——キャンペーンが
 * annihilate フェイズにある間は、通常の点数判断で偶然「和平」が最高スコアになっても
 * 妥協しないようにするため。
 */
function pickBestDiplomaticMove(
  state: GameState,
  selfId: FactionId,
  policy: Policy,
  proximity: number,
  processedPairs: Set<string>,
  commitmentTargetId: FactionId | null = null,
): DiplomaticMove | null {
  const self = state.factions[selfId];
  if (!self) return null;

  let best: DiplomaticMove | null = null;
  for (const counterpartId of Object.keys(self.diplomacy) as FactionId[]) {
    const pairKey = [selfId, counterpartId].sort().join("|");
    if (processedPairs.has(pairKey)) continue;

    const built = buildDiplomaticOptions(state, selfId, counterpartId, proximity);
    if (!built) continue;
    const availableOptions =
      commitmentTargetId !== null && counterpartId === commitmentTargetId && built.stance === "war"
        ? built.options.filter((o) => o.label !== "B") // 「和平を申し入れる」を除外
        : built.options;
    if (availableOptions.length === 0) continue;
    const chosen = decideByScoring(policy, availableOptions);
    const score = scoreOption(chosen, policy);
    if (!best || score > best.score) best = { kind: "adjust", counterpartId, stance: built.stance, option: chosen, score };
  }

  const threat = findThreatNeighbor(state, selfId);
  if (threat) {
    const threatFaction = state.factions[threat.threatId];
    for (const candidateId of findSharedBorderFactions(state, selfId, threat.threatId)) {
      const pairKey = [selfId, candidateId].sort().join("|");
      if (processedPairs.has(pairKey)) continue;
      const candidateFaction = state.factions[candidateId];
      if (!candidateFaction || !candidateFaction.alive || candidateFaction.type !== "lord") continue;
      const existingStance = self.diplomacy[candidateId];
      if (existingStance === "alliance" || existingStance === "vassal") continue; // 既に友好的なら不要

      const option = distantAllianceOption(threatFaction?.name ?? threat.threatId, candidateFaction.name);
      const score = scoreOption(option, policy);
      if (!best || score > best.score) best = { kind: "new_alliance", counterpartId: candidateId, option, score };
    }
  }

  return best;
}

/** `pickBestDiplomaticMove` の結果を実際の外交状態遷移に変換する。 */
function applyDiplomaticMove(factions: GameState["factions"], selfId: FactionId, move: DiplomaticMove): GameState["factions"] {
  if (move.kind === "new_alliance") {
    const self = factions[selfId];
    const other = factions[move.counterpartId];
    if (!self || !other) return factions;
    return {
      ...factions,
      [selfId]: { ...self, diplomacy: { ...self.diplomacy, [move.counterpartId]: "alliance" } },
      [move.counterpartId]: { ...other, diplomacy: { ...other.diplomacy, [selfId]: "alliance" } },
    };
  }
  return applyDiplomaticChoice(factions, selfId, move.counterpartId, move.stance, move.option.label);
}

// --- 大国キャンペーンAI（設計書 9.4／ユーザー要望） --------------------------
//
// 「序盤の淘汰の後は均衡状態に入ってしまう」というフィードバックに対応し、一部の
// 有力勢力には単発の点数判断を超えた、複数ターンにまたがる長期的な野心を持たせる。
// 対象は下記5大勢力のみ（全勢力に適用すると計算量・暴走リスクが跳ね上がるため）。
// 962年開始時点ではハプスブルク家は未成立のため、史実でハプスブルク家が帝位を継ぐ
// 神聖ローマ帝国（faction_hre）で代替する。
//
// 流れ：(1) 一定間隔で仮想敵国を選定 → (2) isolate フェイズで標的の隣国と同盟し
// 標的を孤立させる（近攻遠交の応用）→ (3) 一定年数で annihilate フェイズへ移行し、
// 宣戦布告・和平拒否・退路を断つ侵攻優先度（`buildActionOptions` 側）で標的を追い詰める
// → (4) 標的が滅亡する（`eliminateFactionIfLandless`）か期限切れになったら終了し、
// 次の標的探しに戻る。大戦回避の最終防波堤（`wouldSingleHandedlyTriggerGreatWar`）は
// キャンペーン由来の一手にも例外なく適用される（無条件の暴走を防ぐ）。
const GREAT_POWER_FACTION_IDS: readonly FactionId[] = [
  asFactionId("faction_hre"), // ハプスブルク家（史実の帝位継承）の代替
  asFactionId("faction_papal"),
  asFactionId("faction_england"),
  asFactionId("faction_west_francia"),
  asFactionId("faction_brandenburg"),
];

/** 標的選定を再評価する間隔（年）。 */
const CAMPAIGN_REEVALUATION_INTERVAL_YEARS = 20;
/** isolate フェイズを続ける年数。これを超えると自動的に annihilate フェイズへ移行する。 */
const CAMPAIGN_ISOLATE_PHASE_YEARS = 15;
/** キャンペーンが長期化しすぎた場合の強制終了（安全弁、仮値）。 */
const CAMPAIGN_MAX_DURATION_YEARS = 80;
/** 標的として着手する最低条件（軍事力比・経済力比の平均、仮値）。優位が無ければ手を出さない。 */
const CAMPAIGN_MIN_SUPERIORITY_RATIO = 1.2;
/** 標的探索の射程（州の隣接グラフ上のホップ数、仮値）。行軍で実際に届く範囲に絞る。 */
const CAMPAIGN_MAX_HOP_DISTANCE = 3;

/** `state.campaigns` は後方互換のため任意フィールド。未設定は「キャンペーン無し」として読む。 */
function getCampaigns(state: GameState): Readonly<Record<string, Campaign>> {
  return state.campaigns ?? {};
}

function removeCampaign(campaigns: Readonly<Record<string, Campaign>>, factionId: FactionId): Readonly<Record<string, Campaign>> {
  if (!(factionId in campaigns)) return campaigns;
  const next = { ...campaigns };
  delete next[factionId];
  return next;
}

/** 勢力の経済力の簡易指標（国庫＋領有州の税基盤の合計）。真の成長率トレンドではなく現在値の比較に留める仮モデル。 */
function factionEconomicStrength(state: GameState, factionId: FactionId): number {
  const faction = state.factions[factionId];
  if (!faction) return 0;
  let strength = faction.treasury;
  for (const regionId of faction.regions) {
    const region = state.regions[regionId];
    if (region) strength += region.taxBase;
  }
  return strength;
}

/** 複数の起点州から州の隣接グラフ上を幅優先探索し、到達可能な全ての州までのホップ数を求める。 */
function regionHopDistances(state: GameState, sourceRegionIds: readonly RegionId[]): Map<RegionId, number> {
  const distances = new Map<RegionId, number>();
  let frontier: RegionId[] = [];
  for (const id of sourceRegionIds) {
    if (!distances.has(id)) {
      distances.set(id, 0);
      frontier.push(id);
    }
  }
  let hop = 0;
  while (frontier.length > 0) {
    hop++;
    const next: RegionId[] = [];
    for (const id of frontier) {
      const region = state.regions[id];
      if (!region) continue;
      for (const neighborId of region.adjacency) {
        if (distances.has(neighborId)) continue;
        distances.set(neighborId, hop);
        next.push(neighborId);
      }
    }
    frontier = next;
  }
  return distances;
}

/**
 * 大国キャンペーンAIの次の標的を選ぶ。軍事力・経済力の双方で明確に優位
 * （`CAMPAIGN_MIN_SUPERIORITY_RATIO` 以上）にあり、行軍で実際に届く範囲
 * （`CAMPAIGN_MAX_HOP_DISTANCE` ホップ以内）にいる相手の中から、外交的に孤立していて
 * （同盟数が少ない）近い（isolate・侵攻の労力が小さい）ほど高スコアとして最善の1件を選ぶ。
 * 該当者がいなければ null（無理に手を出さない）。
 */
function selectCampaignTarget(state: GameState, selfId: FactionId): FactionId | null {
  const self = state.factions[selfId];
  if (!self || !self.alive || self.regions.length === 0) return null;

  const distances = regionHopDistances(state, self.regions);
  const selfMilitary = factionMilitaryStrength(state, selfId);
  const selfEconomy = factionEconomicStrength(state, selfId);

  let best: { id: FactionId; score: number } | null = null;
  for (const candidate of Object.values(state.factions)) {
    if (candidate.id === selfId || !candidate.alive || candidate.type !== "lord" || candidate.regions.length === 0) continue;
    const stance = self.diplomacy[candidate.id];
    if (stance === "alliance" || stance === "vassal") continue;

    const hop = Math.min(...candidate.regions.map((r) => distances.get(r) ?? Number.POSITIVE_INFINITY));
    if (!Number.isFinite(hop) || hop > CAMPAIGN_MAX_HOP_DISTANCE) continue;

    const militaryRatio = selfMilitary / Math.max(1, factionMilitaryStrength(state, candidate.id));
    const economicRatio = selfEconomy / Math.max(1, factionEconomicStrength(state, candidate.id));
    const superiority = (militaryRatio + economicRatio) / 2;
    if (superiority < CAMPAIGN_MIN_SUPERIORITY_RATIO) continue;

    const allianceCount = Object.values(candidate.diplomacy).filter((s) => s === "alliance").length;
    const isolationBonus = 1 / (1 + allianceCount);
    const proximityBonus = 1 / hop;
    const score = superiority * isolationBonus * proximityBonus;

    if (!best || score > best.score) best = { id: candidate.id, score };
  }
  return best?.id ?? null;
}

/**
 * 大国キャンペーンAIの状態を1年分進める：期限切れ・標的滅亡による終了、isolateからの
 * フェイズ遷移、新規標的の選定（`CAMPAIGN_REEVALUATION_INTERVAL_YEARS` 年ごと）。
 * `runDiplomacy`/`runDiplomacyAsync` の冒頭で呼び、以降はその年の間ずっと同じ
 * `state.campaigns` を参照する。
 */
function advanceCampaigns(state: GameState): GameState {
  let campaigns = getCampaigns(state);
  let changed = false;

  for (const greatPowerId of GREAT_POWER_FACTION_IDS) {
    const faction = state.factions[greatPowerId];
    if (!faction || !faction.alive) {
      const cleared = removeCampaign(campaigns, greatPowerId);
      if (cleared !== campaigns) {
        campaigns = cleared;
        changed = true;
      }
      continue;
    }

    const active = campaigns[greatPowerId];
    if (active) {
      const target = state.factions[active.targetFactionId];
      const targetDead = !target || !target.alive;
      const duration = state.year - active.startedYear;
      const stance = faction.diplomacy[active.targetFactionId];
      // annihilateフェイズで、既に宣戦布告を終えているはずの時期
      // （isolateフェイズの年数を超えて経過している）になっても交戦状態でない場合、
      // 標的が自発的に和平を申し入れて決着した（またはそもそも宣戦布告が大戦回避の
      // 最終防波堤に阻まれ続けている）とみなしてキャンペーンを終了する。これが無いと、
      // annihilateフェイズは「戦争でなければ即座に宣戦布告する」だけの判断を毎年
      // 繰り返すため、標的が和平を選ぶたびに翌年また宣戦布告——を無限に繰り返す
      // （ユーザー報告：特定の2勢力が開戦・和平を交互に繰り返す）。
      const warConcludedByPeace =
        active.phase === "annihilate" && duration > CAMPAIGN_ISOLATE_PHASE_YEARS && stance !== "war" && stance !== "vassal";
      if (targetDead || warConcludedByPeace || duration > CAMPAIGN_MAX_DURATION_YEARS) {
        campaigns = removeCampaign(campaigns, greatPowerId);
        changed = true;
        continue;
      }
      if (active.phase === "isolate" && duration >= CAMPAIGN_ISOLATE_PHASE_YEARS) {
        campaigns = { ...campaigns, [greatPowerId]: { ...active, phase: "annihilate" } };
        changed = true;
      }
      continue;
    }

    if (state.year % CAMPAIGN_REEVALUATION_INTERVAL_YEARS !== 0) continue;
    const targetId = selectCampaignTarget(state, greatPowerId);
    if (targetId) {
      campaigns = { ...campaigns, [greatPowerId]: { targetFactionId: targetId, phase: "isolate", startedYear: state.year } };
      changed = true;
    }
  }

  return changed ? { ...state, campaigns } : state;
}

/**
 * 大国キャンペーンAIによる、通常の `pickBestDiplomaticMove` より優先される一手。
 * null の場合はキャンペーンとして特に強制することが無い（通常の判断へフォールバック）。
 *
 * - isolate フェイズ：標的の隣国（`findSharedBorderFactions` を標的中心に流用）のうち、
 *   まだ自分と同盟していない相手へ同盟を持ちかける（＝標的を外交的に孤立させる）。
 * - annihilate フェイズ：まだ交戦していなければ即座に宣戦布告する。既に交戦中なら
 *   ここでは何もしない（`runDiplomacy` 側で「和平を申し入れる」を選ばせない抑制を別途行う）。
 */
function campaignDiplomaticMove(
  state: GameState,
  selfId: FactionId,
  campaign: Campaign,
  processedPairs: Set<string>,
): DiplomaticMove | null {
  const self = state.factions[selfId];
  const target = state.factions[campaign.targetFactionId];
  if (!self || !target || !target.alive) return null;

  if (campaign.phase === "annihilate") {
    const stance = self.diplomacy[campaign.targetFactionId];
    if (stance === "war" || stance === "vassal") return null;
    const pairKey = [selfId, campaign.targetFactionId].sort().join("|");
    if (processedPairs.has(pairKey)) return null;

    const option: DecisionOption = {
      label: "A",
      description: `${target.name}を仮想敵国と定め、宣戦布告する（大国キャンペーン）`,
      safety: 0.5,
      expansion: 0.9,
      profit: 0.3,
      legitimacy: 0.15,
    };
    return { kind: "adjust", counterpartId: campaign.targetFactionId, stance: stance ?? "peace", option, score: 999 };
  }

  // isolate フェイズ：標的を挟んで反対側にいる勢力（＝標的の隣国）へ同盟を持ちかける。
  for (const candidateId of findSharedBorderFactions(state, selfId, campaign.targetFactionId)) {
    const pairKey = [selfId, candidateId].sort().join("|");
    if (processedPairs.has(pairKey)) continue;
    const candidateFaction = state.factions[candidateId];
    if (!candidateFaction || !candidateFaction.alive || candidateFaction.type !== "lord") continue;
    const existingStance = self.diplomacy[candidateId];
    if (existingStance === "alliance" || existingStance === "vassal") continue;

    const option = distantAllianceOption(target.name, candidateFaction.name);
    return { kind: "new_alliance", counterpartId: candidateId, option, score: 999 };
  }
  return null;
}

/**
 * 外交フェイズ本体（同期・点数判断）。`Object.values` の列挙順で先に現れた勢力
 * （プレイヤー勢力は除外）から順に、`pickBestDiplomaticMove` で選んだ最善の1手だけを実行する。
 *
 * 冒頭で `advanceCampaigns` により大国キャンペーンAIの状態を更新し、5大勢力については
 * `campaignDiplomaticMove` が返す一手（あれば）を通常の `pickBestDiplomaticMove` より
 * 優先する。
 */
export function runDiplomacy(state: GameState, _options: TurnEngineOptions = {}): GameState {
  const proximity = greatWarProximity(state);
  const withCampaigns = advanceCampaigns(state);
  let factions = withCampaigns.factions;
  const processedPairs = new Set<string>();

  for (const self of Object.values(withCampaigns.factions)) {
    if (self.type !== "lord" || !self.alive || self.ruler === null || self.id === withCampaigns.playerFactionId) continue;
    const ruler = withCampaigns.characters[self.ruler];
    if (!ruler) continue;

    const campaign = getCampaigns(withCampaigns)[self.id] ?? null;
    const commitmentTargetId = campaign?.phase === "annihilate" ? campaign.targetFactionId : null;
    const best =
      (campaign && campaignDiplomaticMove(withCampaigns, self.id, campaign, processedPairs)) ??
      pickBestDiplomaticMove(withCampaigns, self.id, ruler.policy, proximity, processedPairs, commitmentTargetId);
    if (!best) continue;
    processedPairs.add([self.id, best.counterpartId].sort().join("|"));

    const candidateFactions = applyDiplomaticMove(factions, self.id, best);
    if (candidateFactions !== factions && wouldSingleHandedlyTriggerGreatWar(withCampaigns, candidateFactions)) continue;
    factions = candidateFactions;
  }

  return { ...withCampaigns, factions, phase: "action" };
}

/**
 * 外交フェイズ・生成AI丸投げ版（設計書 9.4 の "major decision" エスカレーション用）。
 * `runDiplomacy` と全く同じ選択肢・状態遷移ロジックを共有し、意思決定方式のみ
 * `decideAction`（LLM優先・失敗時は点数判断に自動フォールバック）に差し替える。
 * `DecisionContext.greatWarProximity` を必ず渡すため、生成AIの判断にも大戦接近度が
 * 常に反映される。
 *
 * ユーザー要望（ターン進行速度）：LLMへの問い合わせは `GREAT_POWER_FACTION_IDS`
 * （5大勢力）のみに限定し、それ以外の勢力は（トグルがONでも）常に点数判断で高速に処理する。
 * さらに5大勢力についても、大国キャンペーンAIが強制する一手（`campaignDiplomaticMove`）が
 * あればLLMへの問い合わせ自体を省略する——キャンペーンの長期方針はLLMの応答ゆらぎに
 * 左右されない決定論的なロジックであるべき、という設計判断（詳細は9.4章）。
 */
export async function runDiplomacyAsync(
  state: GameState,
  aiConfig?: AIProviderConfig,
): Promise<GameState> {
  const proximity = greatWarProximity(state);
  const withCampaigns = advanceCampaigns(state);
  let factions = withCampaigns.factions;
  const processedPairs = new Set<string>();

  for (const self of Object.values(withCampaigns.factions)) {
    if (self.type !== "lord" || !self.alive || self.ruler === null || self.id === withCampaigns.playerFactionId) continue;
    const ruler = withCampaigns.characters[self.ruler];
    if (!ruler) continue;

    const campaign = getCampaigns(withCampaigns)[self.id] ?? null;
    const campaignMove = campaign ? campaignDiplomaticMove(withCampaigns, self.id, campaign, processedPairs) : null;
    if (campaignMove) {
      processedPairs.add([self.id, campaignMove.counterpartId].sort().join("|"));
      const candidateFactions = applyDiplomaticMove(factions, self.id, campaignMove);
      if (!(candidateFactions !== factions && wouldSingleHandedlyTriggerGreatWar(withCampaigns, candidateFactions))) {
        factions = candidateFactions;
      }
      continue;
    }
    const commitmentTargetId = campaign?.phase === "annihilate" ? campaign.targetFactionId : null;
    const isGreatPower = GREAT_POWER_FACTION_IDS.includes(self.id);

    // runDiplomacy と同じく「1ターンにつき1手」に絞る。相手ごとに（5大勢力のみ）生成AIへ
    // 問い合わせ、返ってきた選択肢群の中で最もスコアの高い1件だけを実行する。
    let best: DiplomaticMove | null = null;
    for (const counterpartId of Object.keys(self.diplomacy) as FactionId[]) {
      const pairKey = [self.id, counterpartId].sort().join("|");
      if (processedPairs.has(pairKey)) continue;

      const built = buildDiplomaticOptions(withCampaigns, self.id, counterpartId, proximity);
      if (!built) continue;
      const availableOptions =
        commitmentTargetId !== null && counterpartId === commitmentTargetId && built.stance === "war"
          ? built.options.filter((o) => o.label !== "B")
          : built.options;
      if (availableOptions.length === 0) continue;
      const counterpart = withCampaigns.factions[counterpartId]!;
      const chosen = isGreatPower
        ? await decideAction(
            {
              actorRole: `${self.name}の君主`,
              summary: `${counterpart.name}との関係は現在「${built.stance}」。${worldSituationSummary(proximity)}`,
              greatWarProximity: proximity,
            },
            availableOptions,
            ruler.policy,
            aiConfig,
          )
        : decideByScoring(ruler.policy, availableOptions);
      const score = scoreOption(chosen, ruler.policy);
      if (!best || score > best.score) best = { kind: "adjust", counterpartId, stance: built.stance, option: chosen, score };
    }

    // 近攻遠交（runDiplomacy と同じロジックを共有）：LLMへの追加問い合わせはせず、
    // 点数判断でこの副次的な判断を行う（LLM呼び出し回数を抑えるため）。
    const threat = findThreatNeighbor(withCampaigns, self.id);
    if (threat) {
      const threatFaction = withCampaigns.factions[threat.threatId];
      for (const candidateId of findSharedBorderFactions(withCampaigns, self.id, threat.threatId)) {
        const pairKey = [self.id, candidateId].sort().join("|");
        if (processedPairs.has(pairKey)) continue;
        const candidateFaction = withCampaigns.factions[candidateId];
        if (!candidateFaction || !candidateFaction.alive || candidateFaction.type !== "lord") continue;
        const existingStance = self.diplomacy[candidateId];
        if (existingStance === "alliance" || existingStance === "vassal") continue;

        const option = distantAllianceOption(threatFaction?.name ?? threat.threatId, candidateFaction.name);
        const score = scoreOption(option, ruler.policy);
        if (!best || score > best.score) best = { kind: "new_alliance", counterpartId: candidateId, option, score };
      }
    }

    if (best) {
      processedPairs.add([self.id, best.counterpartId].sort().join("|"));
      const candidateFactions = applyDiplomaticMove(factions, self.id, best);
      if (!(candidateFactions !== factions && wouldSingleHandedlyTriggerGreatWar(withCampaigns, candidateFactions))) {
        factions = candidateFactions;
      }
    }
  }

  return { ...withCampaigns, factions, phase: "action" };
}

// --- 行動フェイズ（軍団の移動・侵攻・退却・略奪） -----------------------------

type ArmyActionTarget =
  | { readonly kind: "hold" }
  | { readonly kind: "move"; readonly to: RegionId }
  | { readonly kind: "pillage" };

/**
 * 隣接州に侵攻対象がない場合のフォールバック：交戦中の勢力が領有する最寄りの州へ向けて、
 * 州の隣接グラフ上を幅優先探索し、最初の1歩だけを返す（設計書 9.4／ユーザー要望対応）。
 *
 * 各勢力の野戦軍は基本的に1個のみで、`buildActionOptions` は自軍がいる州に
 * 直接隣接する敵州にしか侵攻できなかった。そのため、隣接していない相手と開戦しても
 * 軍団が前線へ到達する手段が無く、宣戦布告そのものが領土の変化に繋がらないケースが
 * 大半だった（1000年シミュレーションで領有変更が数件しか発生しない主因）。
 * 本関数は簡易的な経路探索で「前線へ向けて行軍する」選択肢を用意し、複数ターンかけて
 * 実際に交戦・占領へ到達できるようにする。
 */
function findMarchStepTowardFront(state: GameState, army: Army, selfFaction: Faction): RegionId | null {
  const start = army.location;
  const visited = new Set<RegionId>([start]);
  const cameFrom = new Map<RegionId, RegionId>();
  const queue: RegionId[] = [start];
  let head = 0;

  while (head < queue.length) {
    const current = queue[head++]!;
    const currentRegion = state.regions[current];
    if (!currentRegion) continue;

    for (const neighborId of currentRegion.adjacency) {
      if (visited.has(neighborId)) continue;
      visited.add(neighborId);
      cameFrom.set(neighborId, current);

      const neighborRegion = state.regions[neighborId];
      if (neighborRegion && selfFaction.diplomacy[neighborRegion.owner] === "war") {
        // start からこの州までの経路を遡り、start の直後の1歩を割り出す。
        let step = neighborId;
        while (cameFrom.get(step) !== start && cameFrom.has(step)) {
          step = cameFrom.get(step)!;
        }
        return step;
      }
      queue.push(neighborId);
    }
  }
  return null;
}

/** 傭兵団が「食い詰めて」略奪に転じる treasury のしきい値（軍団維持費のおよそ3年分、仮値）。 */
const MERCENARY_STARVATION_UPKEEP_MULTIPLIER = 3;

/**
 * 傭兵団（`type: "mercenary"`）は課税対象の領地を持たないため、通常の勢力のような
 * 恒常収入源（10.4章の税収）が無く、契約・略奪でしか国庫を維持できない（設計書 5.2章）。
 * 契約（雇用交渉）のAI自動化はまだ未実装のため（12章）、現状は「一定以上の蓄えが無くなると
 * 周辺を襲う」というフォールバックのみ実装する（ユーザー要望：放っておくと飢えて先細りする
 * だけだった問題への対応）。
 */
function isMercenaryStarving(faction: Faction, army: Army): boolean {
  if (faction.type !== "mercenary") return false;
  return faction.treasury < armyUpkeep(army) * MERCENARY_STARVATION_UPKEEP_MULTIPLIER;
}

/**
 * 大国キャンペーンAI（annihilate フェイズ、ユーザー要望「退路を塞いで滅亡までのシナリオ」）
 * の侵攻優先度ボーナス：標的が領有する州のうち、標的自身の他の州との隣接が少ない
 * （＝標的の版図の中でも周辺・孤立させやすい）ものほど高いボーナスを返す。侵攻選択肢の
 * expansion に上乗せすることで、中心部より先に周辺の州から切り崩し、標的を各個撃破・
 * 孤立させていく優先度を持たせる（仮値）。対象外（annihilateフェイズでない／標的でない）なら0。
 */
function campaignIsolationBonus(state: GameState, selfId: FactionId, region: Region): number {
  const campaign = getCampaigns(state)[selfId];
  if (!campaign || campaign.phase !== "annihilate" || campaign.targetFactionId !== region.owner) return 0;
  const ownNeighborCount = region.adjacency.filter((id) => state.regions[id]?.owner === region.owner).length;
  return 0.15 / (1 + ownNeighborCount);
}

/**
 * 1軍団分の行動選択肢を組み立てる（設計書 9.4／12章：ArmyPanel.dc.html の
 * 移動/攻撃/退却/略奪コマンドに対応する自動判断版）。
 */
function buildActionOptions(
  state: GameState,
  army: Army,
  proximity: number,
): { readonly options: readonly DecisionOption[]; readonly targetsByLabel: ReadonlyMap<string, ArmyActionTarget> } {
  const region = state.regions[army.location];
  const selfFaction = state.factions[army.faction];
  if (!region || !selfFaction) return { options: [], targetsByLabel: new Map() };

  const options: DecisionOption[] = [];
  const targetsByLabel = new Map<string, ArmyActionTarget>();
  let labelIndex = 0;
  const nextLabel = (): string => String.fromCharCode(65 + labelIndex++);

  const holdLabel = nextLabel();
  options.push({ label: holdLabel, description: "現在地に留まり守りを固める", safety: 0.7, expansion: 0.1, profit: 0.2, legitimacy: 0.5 });
  targetsByLabel.set(holdLabel, { kind: "hold" });

  const selfStrength = effectiveStrength(army);
  const starving = isMercenaryStarving(selfFaction, army);
  let hasAdjacentInvasionTarget = false;
  const targetedNeighborIds = new Set<RegionId>(); // 略奪ループでの重複選択肢を避けるための記録

  for (const neighborId of region.adjacency) {
    const neighbor = state.regions[neighborId];
    if (!neighbor) continue;
    const neighborOwner = state.factions[neighbor.owner];
    // 無主化した州（領有勢力が滅亡・断絶したが、州の owner フィールドはその旧勢力IDの
    // ままになっている——設計書 4.3章「無主化」）：owner が生存していなければ、戦争状態を
    // 問わず「接収する」選択肢を出す（ユーザー報告：滅亡した勢力の州がいつまでも
    // 誰にも占領されず空白のまま残り続けていた。実際の接収処理は `runBattleResolution` の
    // `resolveInterregnumAnnexation` が行う）。傭兵団は領地を持たない設計のため対象外。
    const isInterregnum = selfFaction.type === "lord" && (!neighborOwner || !neighborOwner.alive);
    if (!isInterregnum && selfFaction.diplomacy[neighbor.owner] !== "war") continue;
    hasAdjacentInvasionTarget = true;
    targetedNeighborIds.add(neighborId);

    const defenderArmyStrength = Object.values(state.armies)
      .filter((a) => a.location === neighborId && a.faction === neighbor.owner)
      .reduce((sum, a) => sum + effectiveStrength(a), 0);
    const defenderStrength = defenderArmyStrength + neighbor.garrison.count * neighbor.garrison.training;
    const ratio = selfStrength / Math.max(1, defenderStrength);

    const label = nextLabel();
    options.push(
      isInterregnum
        ? {
            label,
            description: `${neighbor.name}（無主化）を接収する`,
            safety: clamp01(0.8 - proximity * 0.1),
            expansion: 0.9,
            profit: 0.4,
            legitimacy: 0.5,
          }
        : {
            label,
            description: `${neighbor.name}へ侵攻する`,
            safety: clamp01((ratio >= 1 ? 0.65 : 0.3) - proximity * 0.2),
            expansion: clamp01((ratio >= 1 ? 0.95 : 0.45) + campaignIsolationBonus(state, army.faction, neighbor)),
            profit: 0.4,
            legitimacy: 0.2,
          },
    );
    targetsByLabel.set(label, { kind: "move", to: neighborId });
  }

  // 傭兵団が食い詰めている場合：隣接するどの州も（交戦の有無を問わず）略奪目的の襲撃先になる
  // （上記 isMercenaryStarving 参照）。侵攻ループで既に選択肢化した隣接州は除外する。
  if (starving) {
    for (const neighborId of region.adjacency) {
      if (targetedNeighborIds.has(neighborId)) continue;
      const neighbor = state.regions[neighborId];
      if (!neighbor || neighbor.owner === army.faction) continue;

      const defenderArmyStrength = Object.values(state.armies)
        .filter((a) => a.location === neighborId && a.faction === neighbor.owner)
        .reduce((sum, a) => sum + effectiveStrength(a), 0);
      const defenderStrength = defenderArmyStrength + neighbor.garrison.count * neighbor.garrison.training;
      const ratio = selfStrength / Math.max(1, defenderStrength);

      const label = nextLabel();
      options.push({
        label,
        description: `${neighbor.name}を略奪目的で襲撃する`,
        safety: clamp01((ratio >= 1 ? 0.6 : 0.35) - proximity * 0.1),
        expansion: 0.05,
        profit: 0.7,
        legitimacy: 0.05,
      });
      targetsByLabel.set(label, { kind: "move", to: neighborId });
    }
  }

  // 隣接州に侵攻対象がない場合のフォールバック（前線への行軍、上記 findMarchStepTowardFront 参照）。
  if (!hasAdjacentInvasionTarget && isAtWar(selfFaction)) {
    const step = findMarchStepTowardFront(state, army, selfFaction);
    if (step) {
      const label = nextLabel();
      options.push({
        label,
        description: `前線へ向けて行軍する`,
        safety: clamp01(0.5 - proximity * 0.2),
        expansion: 0.5,
        profit: 0.2,
        legitimacy: 0.3,
      });
      targetsByLabel.set(label, { kind: "move", to: step });
    }
  }

  const hostileHereStrength = Object.values(state.armies)
    .filter((a) => a.location === army.location && a.faction !== army.faction && selfFaction.diplomacy[a.faction] === "war")
    .reduce((sum, a) => sum + effectiveStrength(a), 0);

  if (hostileHereStrength > selfStrength * 1.3) {
    const friendlyNeighbor = region.adjacency.map((id) => state.regions[id]).find((r) => r && r.owner === army.faction);
    if (friendlyNeighbor) {
      const label = nextLabel();
      options.push({
        label,
        description: `${friendlyNeighbor.name}へ退却する`,
        safety: 0.9,
        expansion: 0.05,
        profit: 0.1,
        legitimacy: 0.3,
      });
      targetsByLabel.set(label, { kind: "move", to: friendlyNeighbor.id });
    }
  }

  // 通常の勢力は交戦中の敵地でのみ略奪できるが、食い詰めた傭兵団は交戦の有無を問わず略奪する。
  if (region.owner !== army.faction && hostileHereStrength === 0 && (selfFaction.diplomacy[region.owner] === "war" || starving)) {
    const label = nextLabel();
    options.push({ label, description: `${region.name}で略奪を行う`, safety: 0.6, expansion: 0.1, profit: 0.8, legitimacy: 0.05 });
    targetsByLabel.set(label, { kind: "pillage" });
  }

  return { options, targetsByLabel };
}

/** 略奪の効果：州の人口・税基盤をわずかに減らし、実行した勢力の国庫に戦利品を加える。 */
function applyPillage(state: GameState, region: Region, factionId: FactionId): GameState {
  const faction = state.factions[factionId];
  if (!faction) return state;
  const loot = Math.round(region.taxBase * 0.5);
  const updatedRegion: Region = {
    ...region,
    population: Math.round(region.population * 0.9),
    taxBase: Math.round(region.taxBase * 0.85),
  };
  return {
    ...state,
    regions: { ...state.regions, [region.id]: updatedRegion },
    factions: { ...state.factions, [factionId]: { ...faction, treasury: faction.treasury + loot } },
  };
}

/** 指揮官がいればその方針、いなければ勢力の君主の方針で代行する。どちらもいなければ null。 */
function effectivePolicyForArmy(state: GameState, army: Army) {
  if (army.commander) {
    const commander = state.characters[army.commander];
    if (commander) return commander.policy;
  }
  const faction = state.factions[army.faction];
  if (faction?.ruler) return state.characters[faction.ruler]?.policy ?? null;
  return null;
}

/** 行動フェイズ本体（同期・点数判断）。プレイヤー勢力の軍団は自動決定の対象外。 */
export function runAction(state: GameState, _options: TurnEngineOptions = {}): GameState {
  const proximity = greatWarProximity(state);
  let next = state;

  for (const army of Object.values(state.armies)) {
    if (army.faction === state.playerFactionId) continue;
    const faction = next.factions[army.faction];
    if (!faction || !faction.alive) continue;
    const policy = effectivePolicyForArmy(next, army);
    if (!policy) continue;

    const { options, targetsByLabel } = buildActionOptions(next, army, proximity);
    if (options.length === 0) continue;
    const chosen = decideByScoring(policy, options);
    const target = targetsByLabel.get(chosen.label);
    if (!target || target.kind === "hold") continue;

    if (target.kind === "move") {
      const current = next.armies[army.id];
      if (current) next = { ...next, armies: { ...next.armies, [army.id]: { ...current, location: target.to } } };
    } else {
      const region = next.regions[army.location];
      if (region) next = applyPillage(next, region, army.faction);
    }
  }

  return { ...next, phase: "battle_resolution" };
}

/**
 * 行動フェイズ・生成AI丸投げ版（`runDiplomacyAsync` と同じ位置づけ）。
 * 選択肢・状態遷移ロジックは `runAction` と共有し、意思決定方式のみ `decideAction` に差し替える。
 *
 * ユーザー要望（ターン進行速度）：`runDiplomacyAsync` と同じく、LLMへの問い合わせは
 * `GREAT_POWER_FACTION_IDS`（5大勢力）の軍団のみに限定する。
 */
export async function runActionAsync(state: GameState, aiConfig?: AIProviderConfig): Promise<GameState> {
  const proximity = greatWarProximity(state);
  let next = state;

  for (const army of Object.values(state.armies)) {
    if (army.faction === state.playerFactionId) continue;
    const faction = next.factions[army.faction];
    if (!faction || !faction.alive) continue;
    const policy = effectivePolicyForArmy(next, army);
    if (!policy) continue;

    const { options, targetsByLabel } = buildActionOptions(next, army, proximity);
    if (options.length === 0) continue;
    const region = next.regions[army.location];
    const chosen = GREAT_POWER_FACTION_IDS.includes(army.faction)
      ? await decideAction(
          {
            actorRole: army.commander ? "戦闘隊長" : `${faction.name}の君主（現地指揮官不在のため代行）`,
            summary: `${region?.name ?? "不明な州"}に駐留する軍団の行動を決める。${worldSituationSummary(proximity)}`,
            greatWarProximity: proximity,
          },
          options,
          policy,
          aiConfig,
        )
      : decideByScoring(policy, options);
    const target = targetsByLabel.get(chosen.label);
    if (!target || target.kind === "hold") continue;

    if (target.kind === "move") {
      const current = next.armies[army.id];
      if (current) next = { ...next, armies: { ...next.armies, [army.id]: { ...current, location: target.to } } };
    } else if (region) {
      next = applyPillage(next, region, army.faction);
    }
  }

  return { ...next, phase: "battle_resolution" };
}

// --- ④ 戦闘解決フェイズ（設計書 3.7：多重戦闘・奇襲・挟撃） -------------------

/**
 * 州にいる敵対ペアを全て列挙する（互いに戦争状態にある異なる勢力の軍の組）。
 * 複数ペアが存在する場合、最も決着に大きな影響を持つ（実効兵力の合計が最大の）
 * ペアを優先する。3勢力以上が同じ州に居合わせた場合も、この関数を戦闘解決の
 * ループ内で繰り返し呼ぶことで「最大の衝突から逐次解決していく」処理になる。
 */
export function findMostConsequentialHostilePair(
  armiesInRegion: readonly Army[],
  state: GameState,
): readonly [Army, Army] | null {
  let best: readonly [Army, Army] | null = null;
  let bestStrength = -1;

  for (let i = 0; i < armiesInRegion.length; i++) {
    for (let j = i + 1; j < armiesInRegion.length; j++) {
      const a = armiesInRegion[i]!;
      const b = armiesInRegion[j]!;
      if (a.faction === b.faction) continue;
      if (state.factions[a.faction]?.diplomacy[b.faction] !== "war") continue;

      const combinedStrength = effectiveStrength(a) + effectiveStrength(b);
      if (combinedStrength > bestStrength) {
        best = [a, b];
        bestStrength = combinedStrength;
      }
    }
  }
  return best;
}

/**
 * 奇襲成立の判定（設計書 3.7）：
 * 攻撃側と同じ勢力の別の軍が、戦場に隣接する州に駐留しており、
 * その軍の指揮官の指揮能力が閾値以上であれば、事前に敵情を探り攻撃の
 * タイミングを整えたとみなし、奇襲が成立する。
 */
export function detectSurprise(attackerFaction: FactionId, region: Region, state: GameState): boolean {
  return region.adjacency.some((neighborId) =>
    Object.values(state.armies).some((army) => {
      if (army.faction !== attackerFaction || army.location !== neighborId || army.commander === null) return false;
      const commander = state.characters[army.commander];
      return (commander?.skills.command ?? 0) >= SURPRISE_COMMAND_THRESHOLD;
    }),
  );
}

/**
 * 挟撃成立の判定（設計書 3.7）：
 * 攻撃側と同じ勢力の別の軍が、この戦闘の起きている州そのものに同時に
 * 所在していれば、複数方向からの同時侵入とみなし挟撃が成立する。
 */
export function detectFlanking(attackerFaction: FactionId, attackerArmyId: Army["id"], region: Region, state: GameState): boolean {
  return Object.values(state.armies).some(
    (army) => army.faction === attackerFaction && army.location === region.id && army.id !== attackerArmyId,
  );
}

/**
 * 無主化した州（領有していた勢力が滅亡・断絶したが、`Region.owner` は旧勢力IDのまま
 * 残っている状態——設計書 4.3章）を、そこに居合わせた生存勢力の軍が無血に近い形で
 * 接収する。`succession.ts` の `collapseFaction` は「実際の無血占領の可否判定は
 * 戦闘解決エンジン側の責務とする」とだけ書いて実装されておらず、無主化した州が
 * いつまでも誰にも占領されないままになっていた（ユーザー報告により発覚）。
 * 複数勢力の軍が同時に居合わせた場合は、最も実効兵力の大きい軍の勢力が接収する。
 * 傭兵団（領地を持たない設計）は対象外。
 */
function resolveInterregnumAnnexation(state: GameState): GameState {
  let regions = state.regions;
  let factions = state.factions;

  for (const region of Object.values(state.regions)) {
    // 累積中の factions から読む（同じ滅亡勢力が複数州を領有していた場合、前の州の処理で
    // 既に regions から取り除いた更新を、後の州の処理が古い state.factions から読み直して
    // 上書き・巻き戻してしまうバグを避けるため）。
    const owner = factions[region.owner];
    if (owner && owner.alive) continue; // 通常どおり誰かが領有している

    const claimants = Object.values(state.armies).filter((a) => {
      if (a.location !== region.id) return false;
      const faction = state.factions[a.faction];
      return faction && faction.alive && faction.type === "lord";
    });
    if (claimants.length === 0) continue;

    const strongest = claimants.reduce((best, a) => (effectiveStrength(a) > effectiveStrength(best) ? a : best));
    const newOwner = factions[strongest.faction];
    if (!newOwner || newOwner.regions.includes(region.id)) continue;

    regions = { ...regions, [region.id]: { ...region, owner: strongest.faction, garrison: { count: 0, training: 0 } } };
    factions = {
      ...factions,
      [strongest.faction]: { ...newOwner, regions: [...newOwner.regions, region.id] },
      // 旧領有勢力（滅亡済み）の regions からも取り除く（validateGameState の整合性チェック対応）。
      ...(owner ? { [owner.id]: { ...owner, regions: owner.regions.filter((id) => id !== region.id) } } : {}),
    };
  }

  return { ...state, regions, factions };
}

function runBattleResolution(state: GameState, options: TurnEngineOptions): GameState {
  const guards = options.guards;
  let next = state;

  const armiesByRegion = new Map<RegionId, Army[]>();
  for (const army of Object.values(state.armies)) {
    const list = armiesByRegion.get(army.location) ?? [];
    list.push(army);
    armiesByRegion.set(army.location, list);
  }

  for (const [regionId] of armiesByRegion) {
    // 同じ州で敵対ペアが尽きるまで、最大の衝突から逐次解決し続ける
    // （3勢力以上が同じ州に居合わせるケースにも対応する）。
    // MAX_ENCOUNTERS_PER_REGION は、練度0の軍同士など極端な入力で決着が
    // つかず無限ループになることを防ぐための安全弁（通常は数戦で決着する）。
    for (let encounter = 0; encounter < MAX_ENCOUNTERS_PER_REGION; encounter++) {
      const region = next.regions[regionId];
      if (!region) break;

      const liveArmies = Object.values(next.armies).filter((a) => a.location === regionId);
      const pair = findMostConsequentialHostilePair(liveArmies, next);
      if (!pair) break;

      const [a, b] = pair;
      // 州の領有者側を防御側として扱う（どちらも領有者でなければ a を攻撃側とする）。
      const [attackerArmy, defenderArmy] = region.owner === b.faction ? [a, b] : [b, a];

      const input: BattleResolutionInput = {
        turn: next.turn,
        region,
        regionsById: next.regions,
        attackerFaction: attackerArmy.faction,
        defenderFaction: defenderArmy.faction,
        attackerArmy,
        defenderArmy,
        attackerCommander: attackerArmy.commander ? (next.characters[attackerArmy.commander] ?? null) : null,
        defenderCommander: defenderArmy.commander ? (next.characters[defenderArmy.commander] ?? null) : null,
        surpriseAttacker: detectSurprise(attackerArmy.faction, region, next),
        flankingAttacker: detectFlanking(attackerArmy.faction, attackerArmy.id, region, next),
      };

      next = applyBattleOutcome(next, input, guards);
    }

    // 野戦軍同士の遭遇戦が尽きたあとも、なお敵対勢力の軍がこの州に留まっている場合
    // （＝領有勢力側の野戦軍が不在／全滅済み）、州直属の駐留兵を防衛力として戦わせる。
    // これが無いと、駐留兵しかいない州へ野戦軍を進めるだけで無血占領できてしまう
    // （3.1章の Region.garrison を実際の防衛力として扱っていなかった実装漏れの補正）。
    for (let encounter = 0; encounter < MAX_ENCOUNTERS_PER_REGION; encounter++) {
      const region = next.regions[regionId];
      if (!region || region.garrison.count <= 0) break;

      const intruder = Object.values(next.armies).find(
        (a) => a.location === regionId && a.faction !== region.owner && next.factions[region.owner]?.diplomacy[a.faction] === "war",
      );
      if (!intruder) break;

      const input: BattleResolutionInput = {
        turn: next.turn,
        region,
        regionsById: next.regions,
        attackerFaction: intruder.faction,
        defenderFaction: region.owner,
        attackerArmy: intruder,
        defenderArmy: phantomGarrisonArmy(region),
        attackerCommander: intruder.commander ? (next.characters[intruder.commander] ?? null) : null,
        defenderCommander: null,
        surpriseAttacker: detectSurprise(intruder.faction, region, next),
        flankingAttacker: detectFlanking(intruder.faction, intruder.id, region, next),
      };

      next = resolveGarrisonDefense(next, input, guards);
    }
  }

  next = resolveInterregnumAnnexation(next);
  return { ...next, phase: "year_end" };
}

// --- ⑤ 年末集計フェイズ（設計書 10章：税制・天候・地勢） ----------------------

/**
 * 年齢に応じた死亡確率（仮実装、設計書 4章）。婚姻システム本格実装までの暫定値で、
 * 厳密な人口統計モデルではない。中世〜近世の大まかな死亡曲線（壮年期はほぼ死なず、
 * 高齢になるほど急上昇する）を模す。
 *
 * これが無いと当主が死亡することが無く、継承・後継者危機・帝位継承（4.4章）の
 * いずれも実際には発火しなかった（ユーザー報告により発覚：継承システム自体は
 * 完成しているが、それを起動する「死亡」イベントが存在していなかった）。
 */
function mortalityProbability(age: number): number {
  if (age < 20) return 0.002;
  if (age < 40) return 0.005;
  if (age < 60) return 0.015;
  if (age < 70) return 0.03;
  if (age < 80) return 0.06;
  return 0.12;
}

/** 生存する全キャラクターを1歳加齢させ、年齢に応じた確率で死亡させる（仮実装）。 */
function ageAndRollMortality(state: GameState, random: RandomSource): GameState {
  let characters = state.characters;
  for (const character of Object.values(state.characters)) {
    if (!character.alive) continue;
    const age = character.age + 1;
    const dies = random() < mortalityProbability(age);
    characters = { ...characters, [character.id]: { ...character, age, alive: !dies } };
  }
  return { ...state, characters };
}

/** 出産適齢とみなす年齢範囲（仮値）。 */
const CHILDBEARING_MIN_AGE = 16;
const CHILDBEARING_MAX_AGE = 45;
/** 出産適齢の当主に、1年あたり子が生まれる確率（仮値）。 */
const CHILDBIRTH_PROBABILITY_PER_YEAR = 0.15;

/**
 * 出生（仮実装、設計書4章）。上記の死亡ロールに対して後継者の供給源が無いと、
 * 数十年で全ての家系が後継者不在の断絶（`succession.ts` の後継者危機）に陥り、
 * 帝国どころか大半の勢力が消滅してしまうことを実際のシミュレーションで確認した。
 *
 * 婚姻システム本格実装までの最小限のつなぎとして、出産適齢の当主にのみ、一定確率で
 * 子（`role: "heir"`）が生まれる処理を入れる。当初は「配偶者がいること」も条件にしたが、
 * それだと初代の（既に配偶者持ちで開始する）当主の代でしか子が生まれず、跡を継いだ
 * 2代目以降には配偶者を得る手段（婚姻）が無いため即座に血筋が途絶えることが
 * シミュレーションで判明した。婚姻を経ずに「当主本人の年齢」だけを条件にする形へ
 * 簡略化し、配偶者は `parents` に含めない（単親記録、婚姻システム実装時に置き換える
 * 前提の割り切り）。
 */
function rollChildbirths(state: GameState, random: RandomSource): GameState {
  let characters = state.characters;
  let serial = 0;
  for (const character of Object.values(state.characters)) {
    if (!character.alive || character.role !== "ruler") continue;
    if (character.age < CHILDBEARING_MIN_AGE || character.age > CHILDBEARING_MAX_AGE) continue;
    if (random() >= CHILDBIRTH_PROBABILITY_PER_YEAR) continue;

    const childId = asCharacterId(`char_born_${character.id}_${state.year}_${serial++}`);
    const child: Character = {
      id: childId,
      name: `${character.name}の子`,
      role: "heir",
      faction: character.faction,
      skills: { command: random(), diplomacy: random(), administration: random() },
      traits: [],
      age: 0,
      alive: true,
      spouse: null,
      children: [],
      parents: [character.id],
      adoptedChildren: [],
      adoptedBy: null,
      policy: assignRandomPolicy(random),
    };
    characters = {
      ...characters,
      [childId]: child,
      [character.id]: { ...characters[character.id]!, children: [...characters[character.id]!.children, childId] },
    };
  }
  return { ...state, characters };
}

function runYearEnd(state: GameState, options: TurnEngineOptions): GameState {
  const random = options.random ?? defaultRandomSource;
  let factions = state.factions;

  // 税収：州ごとに天候を抽選し、地勢アーキタイプ・戦争状態・疫病・包囲を加味した
  // 実効税収を領有勢力の国庫に加算する。
  for (const region of Object.values(state.regions)) {
    const owner = factions[region.owner];
    if (!owner) continue;
    const weatherFactor = rollWeatherFactor(random);
    const atWar = isAtWar(owner);
    // TODO: 疫病が局地的に発生している州の判定（現状は黒死病のような年表イベントのみが
    // taxBase を直接減衰させる形で反映されており、専用の "plagueActive" フラグは未実装）。
    const plagueActive = false;
    const tax = calculateEffectiveTax({ region, weatherFactor, atWar, plagueActive });
    factions = { ...factions, [owner.id]: { ...owner, treasury: owner.treasury + tax } };
  }

  // 帝位の特典（実装済み、ユーザー要望）：保持者に毎年帝国税収を加算する。
  if (state.imperialTitle) {
    const holder = factions[state.imperialTitle.holderId];
    if (holder && holder.alive) {
      factions = { ...factions, [holder.id]: { ...holder, treasury: holder.treasury + IMPERIAL_TITLE_TAX_BONUS } };
    }
  }

  // 維持費：州の駐留戦力と、勢力が抱える全軍団の兵数に応じて国庫から差し引く。
  for (const region of Object.values(state.regions)) {
    const owner = factions[region.owner];
    if (!owner) continue;
    factions = { ...factions, [owner.id]: { ...owner, treasury: owner.treasury - garrisonUpkeep(region) } };
  }
  for (const army of Object.values(state.armies)) {
    const owner = factions[army.faction];
    if (!owner) continue;
    factions = { ...factions, [army.faction]: { ...owner, treasury: owner.treasury - armyUpkeep(army) } };
  }

  const aged = ageAndRollMortality({ ...state, factions }, random);
  const withEconomy: GameState = rollChildbirths(aged, random);

  const warCheckResult = checkGreatWar(withEconomy);
  if (warCheckResult.triggered) {
    return { ...withEconomy, greatWarTriggered: true };
  }
  return { ...withEconomy, turn: withEconomy.turn + 1, year: withEconomy.year + 1, phase: "year_start" };
}

// --- 公開API ----------------------------------------------------------------

const PHASE_RUNNERS: Readonly<Record<TurnPhase, (state: GameState, options: TurnEngineOptions) => GameState>> = {
  year_start: runYearStart,
  diplomacy: runDiplomacy,
  action: runAction,
  battle_resolution: runBattleResolution,
  year_end: runYearEnd,
};

/** 現在のフェイズを1つだけ処理し、次のフェイズへ進める。 */
export function runPhase(state: GameState, options: TurnEngineOptions = {}): GameState {
  if (state.greatWarTriggered) return state;
  return PHASE_RUNNERS[state.phase](state, options);
}

/**
 * ちょうど1年分（呼び出し時点のフェイズから、次の年始フェイズに戻るまで）を処理する。
 * 大戦が発生した場合はその時点で停止する。
 */
export function advanceYear(state: GameState, options: TurnEngineOptions = {}): GameState {
  if (state.greatWarTriggered) return state;
  const startingYear = state.year;
  let next = state;
  do {
    next = runPhase(next, options);
    if (next.greatWarTriggered) break;
  } while (next.year === startingYear);
  return next;
}

/**
 * `advanceYear` の生成AI丸投げ版（設計書 13.1章の "major decision" エスカレーション）。
 * 年始・戦闘解決・年末集計フェイズは `advanceYear` と同じ同期処理を使い、
 * 外交・行動フェイズだけ `runDiplomacyAsync`/`runActionAsync`（`decideAction`：生成AI優先・
 * 失敗時は自動的に点数判断へフォールバック）に差し替える。1年ごとに外部LLMへ
 * 複数回問い合わせるため、`advanceYear` に比べて低速・低コストではない
 * （毎ターン使うのではなく、"major decision" と判断した局面での利用を想定）。
 */
export async function advanceYearAsync(
  state: GameState,
  aiConfig?: AIProviderConfig,
  options: TurnEngineOptions = {},
): Promise<GameState> {
  if (state.greatWarTriggered) return state;
  const startingYear = state.year;
  let next = state;
  do {
    if (next.phase === "diplomacy") next = await runDiplomacyAsync(next, aiConfig);
    else if (next.phase === "action") next = await runActionAsync(next, aiConfig);
    else next = runPhase(next, options);
    if (next.greatWarTriggered) break;
  } while (next.year === startingYear);
  return next;
}
