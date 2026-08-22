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
  regions: document.getElementById("regions"),
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
};

let factionNameOf = new Map();
let hasShownInitialPicker = false;
let currentState = null;
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

function renderRegions(state) {
  els.regions.innerHTML = "";
  for (const r of state.regions) {
    const card = document.createElement("div");
    card.className = "region-card";
    card.style.borderColor = colorFor(r.owner);
    const flags = [];
    if (r.frontier) flags.push('<span class="flag frontier">辺境</span>');
    if (r.fortified) flags.push('<span class="flag fortified">城塞</span>');
    if (r.siege) flags.push('<span class="flag siege">包囲中</span>');
    card.innerHTML = `
      <div class="r-name">${escapeHtml(r.name)}</div>
      <div class="r-owner" style="background:${colorFor(r.owner)}">${escapeHtml(factionNameOf.get(r.owner) ?? r.owner)}</div>
      <div class="r-meta">
        人口 ${r.population.toLocaleString()} ／ 税基盤 ${r.taxBase.toLocaleString()}<br>
        地勢: ${r.archetype}
      </div>
      <div class="r-flags">${flags.join("")}</div>
    `;
    els.regions.appendChild(card);
  }
}

function renderFactions(state) {
  els.factions.innerHTML = "";
  for (const f of state.factions) {
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
els.changeFactionBtn.addEventListener("click", () => currentState && openFactionPicker(currentState));
els.pickerObserveBtn.addEventListener("click", () => selectFaction(null));
els.pickerOverlay.addEventListener("click", (e) => {
  if (e.target === els.pickerOverlay) closeFactionPicker(); // 背景クリックで閉じる（観戦のまま）
});

renderLog();
fetchState();
