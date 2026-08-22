import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  advanceYear,
  advanceYearAsync,
  createInitialGameState,
  evaluatePlayerGameOver,
  greatWarProximity,
  isAtWar,
} from "../dist/index.js";

/**
 * ローカルPoC用の最小サーバー（設計・バランス確認用）。
 * ------------------------------------------------------------------
 * src/ のゲームエンジン（純粋関数）を、ブラウザから叩ける薄いHTTP APIとして公開する。
 * GameStateはプロセスのメモリ上に1つだけ保持する（単一ユーザー・ローカル動作前提のため、
 * DB・セッション管理・認証は意図的に持たない）。公開ホスティングを意図した実装ではない
 * ——複数人が同時にアクセスすると状態を奪い合う点に注意。
 *
 * 事前に `npm run build` で dist/ を生成しておくこと（このファイルはビルド済みJSを読む）。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

let state = createInitialGameState();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function serializeState(s) {
  return {
    turn: s.turn,
    year: s.year,
    phase: s.phase,
    greatWarTriggered: s.greatWarTriggered,
    greatWarProximity: greatWarProximity(s),
    playerFactionId: s.playerFactionId,
    playerGameOver: evaluatePlayerGameOver(s),
    regions: Object.values(s.regions)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((r) => ({
        id: r.id,
        name: r.name,
        owner: r.owner,
        archetype: r.archetype,
        population: r.population,
        taxBase: r.taxBase,
        fortified: r.fortified,
        frontier: r.frontier,
        siege: r.siege !== null,
        adjacency: r.adjacency,
      })),
    factions: Object.values(s.factions)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((f) => ({
        id: f.id,
        name: f.name,
        type: f.type,
        alive: f.alive,
        treasury: Math.round(f.treasury),
        regions: f.regions,
        diplomacy: f.diplomacy,
        suzerain: f.suzerain,
        atWar: isAtWar(f),
      })),
    armies: Object.values(s.armies).map((a) => ({
      id: a.id,
      faction: a.faction,
      location: a.location,
      totalTroops: a.units.reduce((sum, u) => sum + u.count, 0),
      morale: a.morale,
    })),
  };
}

/** 直前のstateとの差分から、その年に何が起きたかの簡易ログ行を作る（UI表示用）。 */
function buildTurnLog(before, after) {
  const log = [];

  for (const faction of Object.values(after.factions)) {
    const prevFaction = before.factions[faction.id];
    if (!prevFaction) continue;

    for (const [counterpartId, stance] of Object.entries(faction.diplomacy)) {
      const prevStance = prevFaction.diplomacy[counterpartId];
      if (prevStance !== stance) {
        const counterpartName = after.factions[counterpartId]?.name ?? counterpartId;
        log.push(`${faction.name} と ${counterpartName} の関係: ${prevStance ?? "不明"} → ${stance}`);
      }
    }
    if (prevFaction.alive && !faction.alive) log.push(`${faction.name} が滅亡・消滅した`);
  }

  for (const region of Object.values(after.regions)) {
    const prevRegion = before.regions[region.id];
    if (prevRegion && prevRegion.owner !== region.owner) {
      const prevOwnerName = before.factions[prevRegion.owner]?.name ?? prevRegion.owner;
      const newOwnerName = after.factions[region.owner]?.name ?? region.owner;
      log.push(`${region.name} の領有者が変わった: ${prevOwnerName} → ${newOwnerName}`);
    }
  }

  if (after.greatWarTriggered && !before.greatWarTriggered) {
    log.push("⚠ 大戦が発生し、世界のゲームオーバー条件を満たした");
  }

  return log;
}

app.get("/api/state", (_req, res) => {
  res.json(serializeState(state));
});

app.post("/api/reset", (_req, res) => {
  state = createInitialGameState();
  res.json(serializeState(state));
});

app.post("/api/advance-year", async (req, res) => {
  const useAI = Boolean(req.body?.useAI);
  const before = state;
  try {
    if (useAI) {
      const aiConfig = {
        apiKey: process.env.AI_PROVIDER_API_KEY || process.env.OPENAI_API_KEY || undefined,
        endpoint: process.env.AI_PROVIDER_ENDPOINT || undefined,
        model: process.env.AI_PROVIDER_MODEL || undefined,
      };
      state = await advanceYearAsync(state, aiConfig);
    } else {
      state = advanceYear(state);
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
  res.json({ ...serializeState(state), log: buildTurnLog(before, state) });
});

app.listen(PORT, () => {
  const hasKey = Boolean(process.env.AI_PROVIDER_API_KEY || process.env.OPENAI_API_KEY);
  console.log(`会議は踊る、されど進まず — PoCサーバー起動: http://localhost:${PORT}`);
  if (!hasKey) {
    console.log(
      "(OPENAI_API_KEY が未設定です。生成AIトグルをONにしても自動的に点数判断へフォールバックします)",
    );
  }
});
