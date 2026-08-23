import { MAP_LAYOUT, MAP_VIEWBOX, SEA_PATCHES, SPANISH_ROAD } from "./mapLayout.js";

/**
 * 勢力一覧パネル（ユーザー要望）：27勢力すべてを常時表示すると情報過多で見たい情報が
 * 埋もれるため、既定では大陸の主要勢力＋プレイヤーの操作勢力のみを表示する。
 * それ以外は「すべて表示」トグルで一覧を開けるほか、地図上の州クリックでも
 * 領有勢力の概要を確認できる（`renderRegionDetail` 参照）。
 */
const MAJOR_FACTION_IDS = new Set(["faction_hre", "faction_papal", "faction_england", "faction_west_francia", "faction_castile"]);

const FACTION_COLORS = ["#a97729", "#5b7ea3", "#8a3b3b", "#6d5590", "#4d7c3f", "#b7862f", "#3f6b7c", "#7c3f6b"];
const factionColor = new Map();
function colorFor(factionId) {
  if (!factionColor.has(factionId)) {
    factionColor.set(factionId, FACTION_COLORS[factionColor.size % FACTION_COLORS.length]);
  }
  return factionColor.get(factionId);
}

const els = {
  year: document.getElementById("year"),
  turn: document.getElementById("turn"),
  phase: document.getElementById("phase"),
  warPct: document.getElementById("war-pct"),
  warFill: document.getElementById("war-fill"),
  mapContainer: document.getElementById("map-container"),
  regionDetail: document.getElementById("region-detail"),
  factions: document.getElementById("factions"),
  armies: document.getElementById("armies"),
  log: document.getElementById("log"),
  banner: document.getElementById("gameover-banner"),
  frozenNote: document.getElementById("player-frozen-note"),
  advanceBtn: document.getElementById("advance-btn"),
  resetBtn: document.getElementById("reset-btn"),
  useAi: document.getElementById("use-ai"),
  playerIndicatorName: document.getElementById("player-indicator-name"),
  changeFactionBtn: document.getElementById("change-faction-btn"),
  pickerOverlay: document.getElementById("faction-picker-overlay"),
  pickerList: document.getElementById("faction-picker-list"),
  pickerObserveBtn: document.getElementById("picker-observe-btn"),
  factionsToggleBtn: document.getElementById("factions-toggle-btn"),
};

let factionNameOf = new Map();
let hasShownInitialPicker = false;
let currentState = null;
let selectedRegionId = null;
let showAllFactions = false;
const logHistory = []; // { year, lines: string[] }

function render(state) {
  currentState = state;
  els.year.textContent = state.year;
  els.turn.textContent = state.turn;
  els.phase.textContent = phaseLabel(state.phase);

  const pct = Math.round(state.greatWarProximity * 100);
  els.warPct.textContent = `${pct}%`;
  els.warFill.style.width = `${pct}%`;
  els.warFill.style.background =
    pct >= 80 ? "linear-gradient(90deg, #a94b3f, #7c2222)" :
    pct >= 50 ? "linear-gradient(90deg, #b7862f, #a94b3f)" :
    "linear-gradient(90deg, #4d7c3f, #b79b3f)";

  factionNameOf = new Map(state.factions.map((f) => [f.id, f.name]));
  state.factions.forEach((f) => colorFor(f.id)); // 色割り当てを固定化

  renderRegions(state);
  renderFactions(state);
  renderArmies(state);
  renderBanner(state);
  renderPlayerIndicator(state);
}

function renderPlayerIndicator(state) {
  if (state.playerFactionId) {
    const name = factionNameOf.get(state.playerFactionId) ?? state.playerFactionId;
    els.playerIndicatorName.textContent = name;
    els.frozenNote.textContent =
      `「${name}」を操作中です。※現時点ではプレイヤー専用の外交・軍事コマンドは未実装のため、` +
      "指示を出さない限りこの勢力は動きません（他の勢力はAIが動かします）。「次の年へ」で世界の推移だけ見ることはできます。";
    els.frozenNote.classList.remove("hidden");
  } else {
    els.playerIndicatorName.textContent = "観戦のみ（CPU完全おまかせ）";
    els.frozenNote.classList.add("hidden");
  }
}

function openFactionPicker(state) {
  els.pickerList.innerHTML = "";
  const lordFactions = state.factions.filter((f) => f.type === "lord" && f.alive);
  for (const f of lordFactions) {
    const item = document.createElement("div");
    item.className = "faction-picker-item";
    item.innerHTML = `
      <div>
        <div class="fp-name"><span style="color:${colorFor(f.id)}">●</span> ${escapeHtml(f.name)}</div>
        <div class="fp-meta">州 ${f.regions.length} ／ 国庫 ${f.treasury.toLocaleString()}${f.atWar ? " ／ 戦争中" : ""}</div>
      </div>
    `;
    const selectBtn = document.createElement("button");
    selectBtn.className = "btn btn-primary btn-sm";
    selectBtn.textContent = "この勢力を選ぶ";
    selectBtn.addEventListener("click", () => selectFaction(f.id));
    item.appendChild(selectBtn);
    els.pickerList.appendChild(item);
  }
  els.pickerOverlay.classList.remove("hidden");
}

function closeFactionPicker() {
  els.pickerOverlay.classList.add("hidden");
}

async function selectFaction(factionId) {
  const res = await fetch("/api/select-faction", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ factionId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(`エラー: ${err.error ?? res.statusText}`);
    return;
  }
  closeFactionPicker();
  render(await res.json());
}

function phaseLabel(phase) {
  return {
    year_start: "年始",
    diplomacy: "外交",
    action: "行動",
    battle_resolution: "戦闘解決",
    year_end: "年末集計",
  }[phase] ?? phase;
}

/**
 * 欧州地図（設計書 15章）：都市（州）をノード、隣接関係を線で結んだ模式図。
 * design/ui-mockup/ の州ポリゴン地図と異なり、27州すべてを見渡せるよう
 * ノード＋隣接線のネットワーク図として再構成した（ユーザー要望：
 * 「ヨーロッパの地図を背景に都市を線で結んでください」）。
 */
function renderRegions(state) {
  const byId = new Map(state.regions.map((r) => [r.id, r]));

  const seaPatches = SEA_PATCHES.map(
    (p) => `<ellipse class="sea-patch" cx="${p.cx}" cy="${p.cy}" rx="${p.rx}" ry="${p.ry}"><title>${escapeHtml(p.label)}</title></ellipse>`,
  ).join("");

  const adjacencyLines = [];
  const seen = new Set();
  for (const r of state.regions) {
    const from = MAP_LAYOUT[r.id];
    if (!from) continue;
    for (const neighborId of r.adjacency) {
      const key = [r.id, neighborId].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      const to = MAP_LAYOUT[neighborId];
      if (!to) continue;
      adjacencyLines.push(`<line class="adjacency-line" x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" />`);
    }
  }

  const spanishRoadPoints = SPANISH_ROAD.map((id) => MAP_LAYOUT[id]).filter(Boolean).map((p) => `${p.x},${p.y}`).join(" ");

  const nodes = state.regions
    .map((r) => {
      const pos = MAP_LAYOUT[r.id];
      if (!pos) return "";
      const isPlayerOwned = r.owner === state.playerFactionId;
      const isSelected = r.id === selectedRegionId;
      const classes = ["region-node", r.frontier ? "is-frontier" : "", r.fortified ? "is-fortified" : "", r.siege ? "is-siege" : "", isPlayerOwned ? "is-player-owned" : "", isSelected ? "is-selected" : ""]
        .filter(Boolean)
        .join(" ");
      return `
        <g class="${classes}" data-region-id="${r.id}" transform="translate(${pos.x},${pos.y})">
          <title>${escapeHtml(r.name)}（${escapeHtml(factionNameOf.get(r.owner) ?? r.owner)}）</title>
          <circle class="region-node-halo" r="16"></circle>
          <circle class="region-node-dot" r="10" fill="${colorFor(r.owner)}"></circle>
          <text class="region-node-label" x="0" y="24" text-anchor="middle">${escapeHtml(shortLabel(r.name))}</text>
        </g>
      `;
    })
    .join("");

  els.mapContainer.innerHTML = `
    <svg viewBox="${MAP_VIEWBOX}" class="europe-map" preserveAspectRatio="xMidYMid meet">
      <rect class="map-bg" x="0" y="0" width="1500" height="1050" rx="10"></rect>
      ${seaPatches}
      <g class="adjacency-lines">${adjacencyLines.join("")}</g>
      <polyline class="spanish-road-line" points="${spanishRoadPoints}"></polyline>
      <g class="region-nodes">${nodes}</g>
    </svg>
  `;

  const svg = els.mapContainer.querySelector("svg");
  svg.addEventListener("click", (e) => {
    const nodeEl = e.target.closest("[data-region-id]");
    if (!nodeEl) return;
    selectedRegionId = nodeEl.getAttribute("data-region-id");
    renderRegionDetail(byId.get(selectedRegionId));
    // 選択状態のハイライトだけ即時反映（全体再描画は次のrenderまで待たない）
    svg.querySelectorAll(".region-node.is-selected").forEach((el) => el.classList.remove("is-selected"));
    nodeEl.classList.add("is-selected");
  });

  if (selectedRegionId && byId.has(selectedRegionId)) renderRegionDetail(byId.get(selectedRegionId));
}

/** 地図上のラベル用に、長い州名から括弧書き等を削った短縮表記を作る。 */
function shortLabel(name) {
  return name.replace(/[（(].*?[）)]/g, "").trim();
}

/**
 * 州の詳細に加え、その領有勢力の概要（国庫・州数・戦争状態）も表示する
 * （ユーザー要望：勢力一覧に出ない勢力も、地図の州クリックで様子を確認できるように）。
 */
function renderRegionDetail(region) {
  if (!region) {
    els.regionDetail.textContent = "州（ノード）をクリックすると詳細を表示します。";
    return;
  }
  const flags = [];
  if (region.frontier) flags.push('<span class="flag frontier">辺境（版図外勢力の侵寇対象）</span>');
  if (region.fortified) flags.push('<span class="flag fortified">城塞</span>');
  if (region.siege) flags.push('<span class="flag siege">包囲中</span>');

  const owner = currentState?.factions.find((f) => f.id === region.owner);
  const ownerMeta = owner
    ? `${owner.type === "lord" ? "領主" : "傭兵団"} ／ 州 ${owner.regions.length} ／ 国庫 ${owner.treasury.toLocaleString()}${owner.atWar ? " ／ 戦争中" : ""}`
    : "";

  els.regionDetail.innerHTML = `
    <div class="rd-name">${escapeHtml(region.name)}</div>
    <div class="rd-owner" style="background:${colorFor(region.owner)}">${escapeHtml(factionNameOf.get(region.owner) ?? region.owner)}</div>
    ${ownerMeta ? `<div class="rd-meta">${ownerMeta}</div>` : ""}
    <div class="rd-meta">
      人口 ${region.population.toLocaleString()} ／ 税基盤 ${region.taxBase.toLocaleString()} ／ 地勢: ${region.archetype}
    </div>
    <div class="rd-flags">${flags.join("") || '<span class="log-empty">特記事項なし</span>'}</div>
  `;
}

function renderFactions(state) {
  const visibleFactions = showAllFactions
    ? state.factions
    : state.factions.filter((f) => MAJOR_FACTION_IDS.has(f.id) || f.id === state.playerFactionId);

  els.factionsToggleBtn.textContent = showAllFactions ? "主要勢力のみ表示" : `すべて表示（全${state.factions.length}勢力）`;

  els.factions.innerHTML = "";
  if (!showAllFactions && visibleFactions.length < state.factions.length) {
    const note = document.createElement("div");
    note.className = "log-empty";
    note.textContent = "大陸の主要勢力とプレイヤー勢力のみ表示中。他は地図の州クリックか「すべて表示」で確認できます。";
    els.factions.appendChild(note);
  }
  for (const f of visibleFactions) {
    const isPlayer = f.id === state.playerFactionId;
    const card = document.createElement("div");
    card.className = "faction-card" + (f.alive ? "" : " dead") + (isPlayer ? " is-player" : "");
    const warBadge = f.atWar ? '<span class="war-badge">戦争中</span>' : "";
    const playerBadge = isPlayer ? '<span class="your-faction-badge">操作中</span>' : "";
    const suzerain = f.suzerain ? `／ 宗主: ${escapeHtml(factionNameOf.get(f.suzerain) ?? f.suzerain)}` : "";
    card.innerHTML = `
      <div class="f-name"><span style="color:${colorFor(f.id)}">●</span> ${escapeHtml(f.name)} ${warBadge}${playerBadge}</div>
      <div class="f-meta">${f.type === "lord" ? "領主" : "傭兵団"} ／ 州 ${f.regions.length} ／ 国庫 ${f.treasury.toLocaleString()}${suzerain}</div>
    `;
    els.factions.appendChild(card);
  }
}

function renderArmies(state) {
  els.armies.innerHTML = "";
  if (state.armies.length === 0) {
    els.armies.innerHTML = '<div class="log-empty">軍団なし</div>';
    return;
  }
  for (const a of state.armies) {
    const locName = state.regions.find((r) => r.id === a.location)?.name ?? a.location;
    const card = document.createElement("div");
    card.className = "army-card";
    card.innerHTML = `<span style="color:${colorFor(a.faction)}">●</span> ${escapeHtml(factionNameOf.get(a.faction) ?? a.faction)} — ${escapeHtml(locName)} ／ 兵${a.totalTroops.toLocaleString()} ／ 戦意${Math.round(a.morale * 100)}%`;
    els.armies.appendChild(card);
  }
}

function renderBanner(state) {
  if (state.greatWarTriggered) {
    els.banner.textContent = "⚠ 大戦が発生し、世界のゲームオーバー条件を満たしました（生存する全勢力が敗北）。";
    els.banner.classList.remove("hidden");
    els.advanceBtn.disabled = true;
  } else if (state.playerGameOver?.kind) {
    els.banner.textContent = `プレイヤーのゲームオーバー: ${state.playerGameOver.kind}（${state.playerGameOver.capitulationReason ?? ""}）`;
    els.banner.classList.remove("hidden");
  } else {
    els.banner.classList.add("hidden");
    els.advanceBtn.disabled = false;
  }
}

function renderLog() {
  els.log.innerHTML = "";
  if (logHistory.length === 0) {
    els.log.innerHTML = '<div class="log-empty">「次の年へ」を押すと、ここに出来事が表示されます。</div>';
    return;
  }
  for (const entry of [...logHistory].reverse()) {
    const yearEl = document.createElement("div");
    yearEl.className = "log-year";
    yearEl.textContent = `${entry.year}年`;
    els.log.appendChild(yearEl);
    if (entry.lines.length === 0) {
      const line = document.createElement("div");
      line.className = "log-line log-empty";
      line.textContent = "（目立った動きなし）";
      els.log.appendChild(line);
    } else {
      for (const l of entry.lines) {
        const line = document.createElement("div");
        line.className = "log-line";
        line.textContent = l;
        els.log.appendChild(line);
      }
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function fetchState() {
  const res = await fetch("/api/state");
  const state = await res.json();
  render(state);
  if (!hasShownInitialPicker) {
    hasShownInitialPicker = true;
    if (!state.playerFactionId) openFactionPicker(state);
  }
}

async function advanceYear() {
  els.advanceBtn.disabled = true;
  els.advanceBtn.textContent = "計算中…";
  try {
    const res = await fetch("/api/advance-year", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ useAI: els.useAi.checked }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(`エラー: ${err.error ?? res.statusText}`);
      return;
    }
    const data = await res.json();
    logHistory.push({ year: data.year, lines: data.log ?? [] });
    render(data);
    renderLog();
  } finally {
    els.advanceBtn.disabled = false;
    els.advanceBtn.textContent = "次の年へ ▶";
  }
}

async function resetGame() {
  if (!confirm("962年の初期状態にリセットします。よろしいですか？")) return;
  const res = await fetch("/api/reset", { method: "POST" });
  logHistory.length = 0;
  const state = await res.json();
  render(state);
  renderLog();
  openFactionPicker(state); // リセット＝新しいゲームの開始として、勢力選択を再度促す
}

els.advanceBtn.addEventListener("click", advanceYear);
els.resetBtn.addEventListener("click", resetGame);
els.factionsToggleBtn.addEventListener("click", () => {
  showAllFactions = !showAllFactions;
  if (currentState) renderFactions(currentState);
});
els.changeFactionBtn.addEventListener("click", () => currentState && openFactionPicker(currentState));
els.pickerObserveBtn.addEventListener("click", () => selectFaction(null));
els.pickerOverlay.addEventListener("click", (e) => {
  if (e.target === els.pickerOverlay) closeFactionPicker(); // 背景クリックで閉じる（観戦のまま）
});

renderLog();
fetchState();
