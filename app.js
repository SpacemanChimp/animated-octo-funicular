// EVE Ore/Ice Harvesting Rate Calculator
// Static site friendly (GitHub Pages). No build step.
// Data sources:
// - Type + reprocessing materials: https://ref-data.everef.net/types/{type_id}
// - Jita prices (fast): https://market.fuzzwork.co.uk/aggregates/?station=60003760&types=...
// - Name -> type ID resolver (optional): https://esi.evetech.net/latest/universe/ids/ (POST)
//
// Notes:
// - We show "Jita Sell" as the lowest sell order price (min sell) at Jita 4-4.
// - Reprocessing assumes a user-specified yield percent (default 100%) and floors quantities to integers.

const JITA_STATION_ID = 60003760;

// The Forge region (Jita is in The Forge)
const THE_FORGE_REGION_ID = 10000002;

// Suggested ore/ice names (exact in-game names recommended)
const MATERIAL_SUGGESTIONS = [
  // Common ores
  "Veldspar",
  "Scordite",
  "Pyroxeres",
  "Plagioclase",
  "Omber",
  "Kernite",
  "Jaspet",
  "Hemorphite",
  "Hedbergite",
  "Gneiss",
  "Dark Ochre",
  "Spodumain",
  "Crokite",
  "Bistot",
  "Arkonor",
  "Mercoxit",

  // Common ice
  "Blue Ice",
  "Clear Icicle",
  "Glacial Mass",
  "White Glaze",
  "Dark Glitter",
  "Gelidus",
  "Krystallos",

  // Compressed variants (optional convenience)
  "Compressed Veldspar",
  "Compressed Scordite",
  "Compressed Pyroxeres",
  "Compressed Plagioclase",
  "Compressed Omber",
  "Compressed Kernite",
  "Compressed Jaspet",
  "Compressed Hemorphite",
  "Compressed Hedbergite",
  "Compressed Gneiss",
  "Compressed Dark Ochre",
  "Compressed Spodumain",
  "Compressed Crokite",
  "Compressed Bistot",
  "Compressed Arkonor",
  "Compressed Mercoxit",

  "Compressed Blue Ice",
  "Compressed Clear Icicle",
  "Compressed Glacial Mass",
  "Compressed White Glaze",
  "Compressed Dark Glitter",
  "Compressed Gelidus",
  "Compressed Krystallos",
];

// ---------------------------
// Tiny helpers
// ---------------------------
const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function fmtInt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return nf0.format(n);
}
function fmtNum(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return digits === 0 ? nf0.format(n) : nf2.format(n);
}
function fmtISK(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return nf2.format(n);
}
function fmtSeconds(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  if (m <= 0) return `${fmtNum(rem, 1)}s`;
  return `${m}m ${fmtNum(rem, 1)}s`;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function setStatus(msg, kind = "") {
  const el = document.getElementById("status");
  el.className = "status " + (kind || "");
  el.innerHTML = msg;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ---------------------------
// Simple fetch cache (memory + localStorage)
// ---------------------------
const memCache = new Map();

function cacheKey(url) {
  return `eveharvestcache:${url}`;
}

async function fetchJson(url, { ttlMs = 0 } = {}) {
  const now = Date.now();

  const mem = memCache.get(url);
  if (mem && (ttlMs <= 0 || now - mem.time < ttlMs)) return mem.data;

  if (ttlMs > 0) {
    try {
      const raw = localStorage.getItem(cacheKey(url));
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.time === "number" && now - parsed.time < ttlMs) {
          memCache.set(url, parsed);
          return parsed.data;
        }
      }
    } catch {
      // ignore
    }
  }

  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  const data = await res.json();

  const record = { time: now, data };
  memCache.set(url, record);

  if (ttlMs > 0) {
    try {
      localStorage.setItem(cacheKey(url), JSON.stringify(record));
    } catch {
      // ignore
    }
  }
  return data;
}

// ---------------------------
// Data source helpers
// ---------------------------

// Resolve an inventory type name to a type ID using ESI.
// ESI requires exact name matches; we also let the user paste a type_id directly.
async function resolveTypeIdFromName(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return null;

  const url = "https://esi.evetech.net/latest/universe/ids/?datasource=tranquility";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify([trimmed]),
  });
  if (!res.ok) throw new Error(`ESI /universe/ids failed: HTTP ${res.status}`);
  const data = await res.json();
  const inv = data?.inventory_types || [];
  if (!Array.isArray(inv) || inv.length === 0) return null;

  const lower = trimmed.toLowerCase();
  const exact = inv.find((x) => String(x.name || "").toLowerCase() === lower);
  return (exact || inv[0]).id ?? null;
}

// Fetch type data (including type_materials) from EVE Ref.
async function getTypeData(typeId) {
  const id = Number(typeId);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Invalid type ID.");
  const url = `https://ref-data.everef.net/types/${id}`;
  // Type data is mostly static: cache for 7 days.
  const data = await fetchJson(url, { ttlMs: 7 * 24 * 60 * 60 * 1000 });

  return {
    typeId: data.type_id,
    name: data?.name?.en ?? `Type ${id}`,
    volume: data.volume,
    portionSize: data.portion_size ?? 1,
    typeMaterials: data.type_materials || {}, // { materialTypeId: {material_type_id, quantity}, ... }
  };
}

// Fuzzwork aggregates price fetch for a station, multiple types.
// Returns a map: typeId -> { sellMin, buyMax, ... }
async function getPricesFuzzwork(typeIds) {
  const ids = Array.from(new Set(typeIds.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0)));
  if (ids.length === 0) return new Map();

  const url = `https://market.fuzzwork.co.uk/aggregates/?station=${JITA_STATION_ID}&types=${ids.join(",")}`;
  // Market snapshots update ~30 minutes; cache for 5 minutes to be gentle.
  const data = await fetchJson(url, { ttlMs: 5 * 60 * 1000 });

  const out = new Map();
  for (const id of ids) {
    const rec = data?.[String(id)];
    const sellMin = rec?.sell?.min ?? 0;
    const buyMax = rec?.buy?.max ?? 0;
    out.set(id, {
      sellMin: sellMin > 0 ? sellMin : null,
      buyMax: buyMax > 0 ? buyMax : null,
      raw: rec ?? null,
    });
  }
  return out;
}

// Direct ESI price fetch: min sell order price in Jita 4-4 for a given type.
// This can require paging through many results; we limit pages for safety.
async function getBestJitaSell_ESI(typeId, { maxPages = 25, onProgress = null } = {}) {
  const id = Number(typeId);
  if (!Number.isFinite(id) || id <= 0) return null;

  let best = Infinity;
  let pages = 1;

  for (let page = 1; page <= pages && page <= maxPages; page++) {
    if (typeof onProgress === "function") onProgress({ typeId: id, page, pages, limited: pages > maxPages });

    const url = `https://esi.evetech.net/latest/markets/${THE_FORGE_REGION_ID}/orders/?datasource=tranquility&order_type=sell&type_id=${id}&page=${page}`;
    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!res.ok) throw new Error(`ESI market orders failed: HTTP ${res.status} for type ${id}`);

    const pageCount = res.headers.get("x-pages");
    if (pageCount) {
      const p = Number(pageCount);
      if (Number.isFinite(p) && p >= 1) pages = p;
    }

    const orders = await res.json();
    if (Array.isArray(orders)) {
      for (const o of orders) {
        if (o?.location_id === JITA_STATION_ID && (o?.volume_remain ?? 0) > 0) {
          const price = Number(o.price);
          if (Number.isFinite(price) && price < best) best = price;
        }
      }
    }
  }

  if (!Number.isFinite(best)) return null;
  return best;
}

// Fetch ESI prices for multiple types, sequentially (with progress).
async function getPricesESI(typeIds, { onProgress = null } = {}) {
  const ids = Array.from(new Set(typeIds.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0)));
  const out = new Map();
  let done = 0;

  for (const id of ids) {
    const price = await getBestJitaSell_ESI(id, {
      maxPages: 25,
      onProgress: (p) => {
        if (typeof onProgress === "function") {
          onProgress({ ...p, done, total: ids.length });
        }
      },
    });
    out.set(id, { sellMin: price, buyMax: null, raw: null });
    done++;
    if (typeof onProgress === "function") onProgress({ typeId: id, done, total: ids.length, stage: "doneOne" });
  }

  return out;
}

// ---------------------------
// Calculation
// ---------------------------
function calcCycles(durationMinutes, cycleTimeSeconds) {
  const totalSeconds = Math.max(0, durationMinutes * 60);
  const cycles = cycleTimeSeconds > 0 ? Math.floor(totalSeconds / cycleTimeSeconds) : 0;
  const usedSeconds = cycles * cycleTimeSeconds;
  const leftoverSeconds = totalSeconds - usedSeconds;
  return { totalSeconds, cycles, usedSeconds, leftoverSeconds };
}

function calcUnitsMined(volumeM3, unitVolumeM3) {
  if (!(unitVolumeM3 > 0)) return 0;
  // Avoid floating point edge cases
  return Math.floor(volumeM3 / unitVolumeM3 + 1e-9);
}

function computeReprocessOutputs({ units, portionSize, typeMaterials, yieldPct }) {
  const eff = clamp(yieldPct, 0, 100) / 100;

  const ps = Math.max(1, Number(portionSize) || 1);
  const batches = units / ps;

  const outputs = [];
  for (const key of Object.keys(typeMaterials || {})) {
    const rec = typeMaterials[key];
    const matId = Number(rec?.material_type_id ?? key);
    const qtyPerPortion = Number(rec?.quantity ?? 0);

    if (!Number.isFinite(matId) || matId <= 0) continue;
    if (!Number.isFinite(qtyPerPortion) || qtyPerPortion <= 0) continue;

    const qty = Math.floor(batches * qtyPerPortion * eff + 1e-9);
    outputs.push({ typeId: matId, qty, qtyPerPortion });
  }

  // Sort by qty desc (nice UX)
  outputs.sort((a, b) => (b.qty - a.qty) || (a.typeId - b.typeId));
  return outputs;
}

// ---------------------------
// Rendering
// ---------------------------
function renderSummary({ input, cyclesInfo, typeData, units, rawValue, reprocessValue }) {
  const perHourFactor = cyclesInfo.usedSeconds > 0 ? 3600 / cyclesInfo.usedSeconds : 0;

  const minedM3 = units * (typeData.volume ?? 0);
  const minedM3Str = Number.isFinite(minedM3) ? fmtNum(minedM3, 2) : "—";

  const hrM3 = cyclesInfo.usedSeconds > 0 ? (minedM3 / cyclesInfo.usedSeconds) * 3600 : 0;
  const hrRaw = cyclesInfo.usedSeconds > 0 ? rawValue * perHourFactor : 0;
  const hrRe = cyclesInfo.usedSeconds > 0 ? reprocessValue * perHourFactor : 0;

  const el = document.getElementById("summary");
  el.innerHTML = [
    kpi("Material", escapeHtml(typeData.name), `Type ID: ${typeData.typeId}`),
    kpi("Duration entered", `${fmtNum(input.durationMinutes, 0)} min`, `Cycles (full): ${fmtInt(cyclesInfo.cycles)}`),
    kpi("Cycle time", `${fmtNum(input.cycleTimeSeconds, 1)} s`, `Time used: ${fmtSeconds(cyclesInfo.usedSeconds)} • Left: ${fmtSeconds(cyclesInfo.leftoverSeconds)}`),
    kpi("Mined volume", `${minedM3Str} m³`, `${fmtNum(hrM3, 2)} m³/hour`),
    kpi("Mined units", fmtInt(units), `${fmtNum(units * perHourFactor, 2)} units/hour`),
    kpi("Values", `Raw: ${fmtISK(rawValue)} ISK`, `Reprocessed: ${fmtISK(reprocessValue)} ISK`),
    kpi("ISK/hour", `Raw: ${fmtISK(hrRaw)}`, `Reprocessed: ${fmtISK(hrRe)}`),
    kpi("Reprocess yield", `${fmtNum(input.reprocessYieldPct, 1)}%`, `Portion size: ${fmtInt(typeData.portionSize)} units${window.__reprocessTaxPct && Number(window.__reprocessTaxPct) > 0 ? ` • Tax: ${fmtNum(Number(window.__reprocessTaxPct),1)}%` : ""}`),
  ].join("");
}

function kpi(label, value, sub) {
  return `
    <div class="kpi">
      <div class="label">${label}</div>
      <div class="value">${value}</div>
      ${sub ? `<div class="sub">${sub}</div>` : ""}
    </div>
  `;
}

function setTableMessage(tableId, colspan, msg) {
  const tbody = document.querySelector(`#${tableId} tbody`);
  tbody.innerHTML = `<tr><td colspan="${colspan}" class="muted">${escapeHtml(msg)}</td></tr>`;
}

function renderRawRow({ typeData, units, price }) {
  const tbody = document.querySelector("#rawTable tbody");
  const p = price ?? null;

  const total = p ? units * p : null;

  tbody.innerHTML = `
    <tr>
      <td>${escapeHtml(typeData.name)}</td>
      <td class="num">${fmtInt(typeData.typeId)}</td>
      <td class="num">${fmtNum(typeData.volume, 3)}</td>
      <td class="num">${fmtInt(units)}</td>
      <td class="num">${p ? fmtISK(p) : "—"}</td>
      <td class="num">${total !== null ? fmtISK(total) : "—"}</td>
    </tr>
  `;
}

function renderReprocessTable({ materialsRows, total }) {
  const tbody = document.querySelector("#reprocessTable tbody");

  if (materialsRows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">No reprocessing materials found for this type.</td></tr>`;
  } else {
    tbody.innerHTML = materialsRows.map((r) => `
      <tr>
        <td>${escapeHtml(r.name)}</td>
        <td class="num">${fmtInt(r.typeId)}</td>
        <td class="num">${fmtInt(r.qty)}</td>
        <td class="num">${r.sellMin ? fmtISK(r.sellMin) : "—"}</td>
        <td class="num">${r.totalValue !== null ? fmtISK(r.totalValue) : "—"}</td>
      </tr>
    `).join("");
  }

  document.getElementById("reprocessTotalCell").textContent = fmtISK(total);
}


function renderCompare({ rawTotal, reprocessTotal, usedSeconds, taxPct = 0 }) {
  const el = document.getElementById("compareBox");
  if (!Number.isFinite(rawTotal) && !Number.isFinite(reprocessTotal)) {
    el.innerHTML = "";
    return;
  }

  const diff = (reprocessTotal ?? 0) - (rawTotal ?? 0);
  const cls = diff >= 0 ? "pos" : "neg";
  const perHour = usedSeconds > 0 ? diff * (3600 / usedSeconds) : 0;

  const taxLine = taxPct > 0
    ? `<div class="muted" style="margin-top:6px">Reprocessed total shown is <b>net</b> after an approximate ${fmtNum(taxPct, 1)}% reprocessing fee (valued using Jita sell).</div>`
    : "";

  el.innerHTML = `
    <div>
      <b>Raw vs Reprocessed</b>: Difference (Reprocessed − Raw) =
      <span class="${cls}">${fmtISK(diff)} ISK</span>
      (${fmtISK(perHour)} ISK/hour at your settings)
    </div>
    ${taxLine}
  `;
}


// URL share state
// ---------------------------
function getStateFromUrl() {
  const params = new URLSearchParams(location.search);
  const state = {
    yieldPerCycle: params.get("y") ? Number(params.get("y")) : null,
    cycleTimeSeconds: params.get("c") ? Number(params.get("c")) : null,
    durationMinutes: params.get("m") ? Number(params.get("m")) : null,
    materialName: params.get("name") ? String(params.get("name")) : null,
    materialTypeId: params.get("type") ? Number(params.get("type")) : null,
    reprocessYieldPct: params.get("r") ? Number(params.get("r")) : null,
    priceSource: params.get("p") ? String(params.get("p")) : null,
  };
  return state;
}

function applyStateToInputs(state) {
  if (state.yieldPerCycle !== null && Number.isFinite(state.yieldPerCycle)) {
    document.getElementById("yieldPerCycle").value = String(state.yieldPerCycle);
  }
  if (state.cycleTimeSeconds !== null && Number.isFinite(state.cycleTimeSeconds)) {
    document.getElementById("cycleTimeSeconds").value = String(state.cycleTimeSeconds);
  }
  if (state.durationMinutes !== null && Number.isFinite(state.durationMinutes)) {
    document.getElementById("durationMinutes").value = String(state.durationMinutes);
  }
  if (state.materialName) {
    document.getElementById("materialName").value = state.materialName;
  }
  if (state.materialTypeId !== null && Number.isFinite(state.materialTypeId)) {
    document.getElementById("materialTypeId").value = String(state.materialTypeId);
  }
  if (state.reprocessYieldPct !== null && Number.isFinite(state.reprocessYieldPct)) {
    document.getElementById("reprocessYieldPct").value = String(state.reprocessYieldPct);
  }
  if (state.priceSource) {
    const sel = document.getElementById("priceSource");
    if ([...sel.options].some((o) => o.value === state.priceSource)) {
      sel.value = state.priceSource;
    }
  }
}

function buildShareUrl() {
  const y = Number(document.getElementById("yieldPerCycle").value);
  const c = Number(document.getElementById("cycleTimeSeconds").value);
  const m = Number(document.getElementById("durationMinutes").value);
  const name = document.getElementById("materialName").value.trim();
  const type = Number(document.getElementById("materialTypeId").value);
  const r = Number(document.getElementById("reprocessYieldPct").value);
  const p = document.getElementById("priceSource").value;

  const params = new URLSearchParams();
  if (Number.isFinite(y)) params.set("y", String(y));
  if (Number.isFinite(c)) params.set("c", String(c));
  if (Number.isFinite(m)) params.set("m", String(m));
  if (name) params.set("name", name);
  if (Number.isFinite(type) && type > 0) params.set("type", String(type));
  if (Number.isFinite(r)) params.set("r", String(r));
  if (p) params.set("p", p);

  return `${location.origin}${location.pathname}?${params.toString()}`;
}

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for older browsers / insecure contexts
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      ta.remove();
      return true;
    } catch {
      ta.remove();
      return false;
    }
  }
}

// ---------------------------
// Main
// ---------------------------
function populateSuggestions() {
  const dl = document.getElementById("materialSuggestions");
  dl.innerHTML = MATERIAL_SUGGESTIONS.map((s) => `<option value="${escapeHtml(s)}"></option>`).join("");
}

function resetUi() {
  document.getElementById("yieldPerCycle").value = "1000";
  document.getElementById("cycleTimeSeconds").value = "92.2";
  document.getElementById("durationMinutes").value = "15";
  document.getElementById("materialName").value = "";
  document.getElementById("materialTypeId").value = "";
  document.getElementById("reprocessYieldPct").value = "100";
  window.__reprocessTaxPct = 0;
  document.getElementById("priceSource").value = "fuzzwork";

  document.getElementById("summary").innerHTML = `<div class="placeholder">Enter inputs and click <b>Calculate</b>.</div>`;
  setTableMessage("rawTable", 6, "No calculation yet.");
  setTableMessage("reprocessTable", 5, "No calculation yet.");
  document.getElementById("reprocessTotalCell").textContent = "—";
  document.getElementById("compareBox").innerHTML = "";
  setStatus("Ready.");
}


async function getNamesESI(typeIds) {
  const ids = Array.from(new Set(typeIds.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0)));
  if (ids.length === 0) return new Map();
  // ESI /universe/names supports bulk resolution.
  const url = "https://esi.evetech.net/latest/universe/names/?datasource=tranquility";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(ids),
  });
  if (!res.ok) throw new Error(`ESI universe/names failed: HTTP ${res.status}`);
  const arr = await res.json();
  const out = new Map();
  if (Array.isArray(arr)) {
    for (const rec of arr) {
      if (rec?.category === "inventory_type" && Number.isFinite(Number(rec.id))) {
        out.set(Number(rec.id), String(rec.name));
      }
    }
  }
  return out;
}

function getPriceSellMin(priceMap, typeId) {
  const rec = priceMap.get(Number(typeId));
  return rec ? (rec.sellMin ?? null) : null;
}

function updateUrlFromInputs(selectedTypeId) {
  const y = Number(document.getElementById("yieldPerCycle").value);
  const c = Number(document.getElementById("cycleTimeSeconds").value);
  const m = Number(document.getElementById("durationMinutes").value);
  const name = document.getElementById("materialName").value.trim();
  const r = Number(document.getElementById("reprocessYieldPct").value);
  const p = document.getElementById("priceSource").value;

  const params = new URLSearchParams();
  if (Number.isFinite(y)) params.set("y", String(y));
  if (Number.isFinite(c)) params.set("c", String(c));
  if (Number.isFinite(m)) params.set("m", String(m));
  if (name) params.set("name", name);
  if (Number.isFinite(selectedTypeId) && selectedTypeId > 0) params.set("type", String(selectedTypeId));
  if (Number.isFinite(r)) params.set("r", String(r));
  if (p) params.set("p", p);

  history.replaceState({}, "", `${location.pathname}?${params.toString()}`);
}

function renderRawSelected(row) {
  renderRawRow({
    typeData: row.typeData,
    units: row.unitsMined,
    price: row.oreSell,
  });
}

function renderComparison(rows, usedSeconds, taxPct) {
  const el = document.getElementById("compareBox");

  // Default sort: best reprocessed ISK/hr desc
  const state = window.__compareState || { key: "reprocessPerHour", dir: "desc", selectedTypeId: null };
  window.__compareState = state;

  const sorted = rows.slice().sort((a, b) => {
    const av = a[state.key] ?? 0;
    const bv = b[state.key] ?? 0;
    return state.dir === "asc" ? (av - bv) : (bv - av);
  });

  const headers = [
    { key: "name", label: "Material" },
    { key: "unitsMined", label: "Units" },
    { key: "rawPerHour", label: "Raw ISK/hr" },
    { key: "reprocessPerHour", label: "Repro ISK/hr" },
    { key: "rawTotal", label: "Raw total" },
    { key: "reprocessNet", label: "Repro total" },
  ];

  const headHtml = headers.map((h) => {
    const active = state.key === h.key ? " active" : "";
    const arrow = state.key === h.key ? (state.dir === "asc" ? " ▲" : " ▼") : "";
    return `<th class="sortable${active}" data-key="${h.key}">${escapeHtml(h.label)}${arrow}</th>`;
  }).join("");

  const bodyHtml = sorted.map((r) => {
    const sel = (state.selectedTypeId ?? sorted[0]?.typeId) === r.typeId ? ` class="row-selected"` : "";
    return `
      <tr data-typeid="${r.typeId}"${sel}>
        <td>${escapeHtml(r.typeData.name)}</td>
        <td class="num">${fmtInt(r.unitsMined)}</td>
        <td class="num">${r.rawPerHour !== null ? fmtISK(r.rawPerHour) : "—"}</td>
        <td class="num"><b>${fmtISK(r.reprocessPerHour)}</b></td>
        <td class="num">${r.rawTotal !== null ? fmtISK(r.rawTotal) : "—"}</td>
        <td class="num"><b>${fmtISK(r.reprocessNet)}</b></td>
      </tr>
    `;
  }).join("");

  const taxNote = taxPct > 0 ? ` (tax approx: ${fmtNum(taxPct,1)}%)` : "";

  el.innerHTML = `
    <div style="margin-bottom:8px">
      <b>Ore/Ice comparison</b>: click headers to sort; click a row to view details in the tables below.${taxNote}
    </div>
    <div class="table-wrap">
      <table class="table compare-table" id="compareTable">
        <thead><tr>${headHtml}</tr></thead>
        <tbody>${bodyHtml}</tbody>
      </table>
    </div>
  `;

  // Header sort wiring
  el.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.getAttribute("data-key");
      if (!key) return;
      if (state.key === key) state.dir = state.dir === "asc" ? "desc" : "asc";
      else { state.key = key; state.dir = "desc"; }
      renderComparison(rows, usedSeconds, taxPct);
    });
  });

  // Row selection wiring
  el.querySelectorAll("tbody tr").forEach((tr) => {
    tr.addEventListener("click", () => {
      const id = Number(tr.getAttribute("data-typeid"));
      const picked = rows.find((x) => x.typeId === id) || rows[0];
      state.selectedTypeId = picked.typeId;

      renderRawSelected(picked);
      renderReprocessTable({ materialsRows: picked.reprocessRows, total: picked.reprocessNet });

      renderComparison(rows, usedSeconds, taxPct);
    });
  });
}

async function onCalculate(e) {
  e.preventDefault();

  try {
    setStatus("Calculating…");

    const yieldPerCycle = Number(document.getElementById("yieldPerCycle").value);
    const cycleTimeSeconds = Number(document.getElementById("cycleTimeSeconds").value);
    const durationMinutes = Number(document.getElementById("durationMinutes").value);

    const materialNameInput = document.getElementById("materialName").value.trim();
    const materialTypeIdInput = Number(document.getElementById("materialTypeId").value);

    const reprocessYieldPct = Number(document.getElementById("reprocessYieldPct").value);
    const priceSource = document.getElementById("priceSource").value;

    const taxPct = window.__reprocessTaxPct ? Number(window.__reprocessTaxPct) : 0;

    if (!(yieldPerCycle > 0)) throw new Error("Yield per cycle must be > 0.");
    if (!(cycleTimeSeconds > 0)) throw new Error("Cycle time must be > 0.");
    if (!(durationMinutes >= 0)) throw new Error("Duration must be >= 0.");

    const { cycles, usedSeconds, leftoverSeconds } = calcCycles(durationMinutes, cycleTimeSeconds);
        const totalM3 = cycles * yieldPerCycle;
    if (cycles <= 0) {
      renderEmptyAfterCalc();
      setStatus("No full cycles to compute.", "warn");
      return;
    }

    // Targets
    let targets = [];
    if (Number.isFinite(materialTypeIdInput) && materialTypeIdInput > 0) {
      targets = [{ name: materialNameInput || `Type ${Math.floor(materialTypeIdInput)}`, typeId: Math.floor(materialTypeIdInput) }];
    } else {
      if (!materialNameInput) throw new Error("Enter a material name or a Type ID.");

      const names = materialNameInput.split(",").map((s) => s.trim()).filter(Boolean);
      if (names.length === 0) throw new Error("Enter a material name.");

      setStatus(`Resolving type IDs (${Math.min(names.length, 12)})…`);
      for (const nm of names.slice(0, 12)) {
        const id = await resolveTypeIdFromName(nm);
        if (!id) throw new Error(`Could not resolve "${nm}". Make sure it matches the in-game name.`);
        targets.push({ name: nm, typeId: id });
      }
      if (names.length > 12) setStatus(`Resolved first 12 materials (you entered ${names.length}).`, "warn");
    }

    // Fetch type data for targets
    setStatus("Fetching type data…");
    const typeDatas = new Map();
    for (const t of targets) {
      typeDatas.set(t.typeId, await getTypeData(t.typeId));
    }

    const mined = targets.map((t) => {
      const td = typeDatas.get(t.typeId);
      const units = Math.floor(totalM3 / (td.volume || 1));
      return { ...t, typeData: td, unitsMined: units };
    });

    // Need prices for ores + all outputs
    const priceTypeIds = new Set();
    for (const m of mined) {
      priceTypeIds.add(m.typeId);
      for (const mat of Object.values(m.typeData.typeMaterials || {})) priceTypeIds.add(mat.material_type_id);
    }
    const idsAll = [...priceTypeIds];

    // Names for output ids (bulk)
    setStatus("Resolving type names…");
    const namesMap = await getNamesESI(idsAll);

    // Prices
    let priceMap = new Map();
    if (priceSource === "esi" && mined.length > 1) {
      setStatus("Comparison mode: using Fuzzwork prices (ESI is too heavy for many items).", "warn");
      priceMap = await getPricesFuzzwork(idsAll);
    } else if (priceSource === "esi") {
      setStatus("Fetching prices from ESI (can take a bit)…");
      priceMap = await getPricesESI(idsAll, {
        onProgress: (p) => {
          if (p?.stage === "doneOne") setStatus(`ESI pricing… ${p.done}/${p.total}`);
        },
      });
    } else {
      setStatus("Fetching prices from Fuzzwork…");
      priceMap = await getPricesFuzzwork(idsAll);
    }

    const yieldFrac = Math.max(0, Math.min(1, reprocessYieldPct / 100));

    const rows = mined.map((m) => {
      const td = m.typeData;

      const oreSell = getPriceSellMin(priceMap, m.typeId);
      const rawTotal = oreSell !== null ? oreSell * m.unitsMined : null;

      const portion = Math.max(1, Number(td.portionSize || 1));
      const portions = Math.floor(m.unitsMined / portion);

      let reprocessRows = [];
      let reprocessTotal = 0;

      for (const mat of Object.values(td.typeMaterials || {})) {
        const outId = Number(mat.material_type_id);
        const baseQty = Number(mat.quantity || 0);
        const qty = Math.floor(portions * baseQty * yieldFrac);

        const sellMin = getPriceSellMin(priceMap, outId);
        const totalValue = sellMin !== null ? sellMin * qty : null;
        if (totalValue !== null) reprocessTotal += totalValue;

        reprocessRows.push({
          typeId: outId,
          name: namesMap.get(outId) || `Type ${outId}`,
          qty,
          sellMin,
          totalValue,
        });
      }

      reprocessRows.sort((a, b) => (b.totalValue ?? 0) - (a.totalValue ?? 0));

      const taxFee = taxPct > 0 ? reprocessTotal * (taxPct / 100) : 0;
      const reprocessNet = reprocessTotal - taxFee;

      const rawPerHour = usedSeconds > 0 && rawTotal !== null ? rawTotal * (3600 / usedSeconds) : null;
      const reprocessPerHour = usedSeconds > 0 ? reprocessNet * (3600 / usedSeconds) : null;

      return {
        typeId: m.typeId,
        typeData: td,
        unitsMined: m.unitsMined,
        oreSell,
        rawTotal,
        rawPerHour,
        reprocessRows,
        reprocessTotal,
        taxFee,
        reprocessNet,
        reprocessPerHour,
      };
    });

    // Default selection = best reprocessed ISK/hr
    const best = rows.slice().sort((a, b) => (b.reprocessPerHour ?? 0) - (a.reprocessPerHour ?? 0))[0] || rows[0];

    renderSummary({
      input: { durationMinutes, cycleTimeSeconds, reprocessYieldPct },
      cyclesInfo: { cycles, usedSeconds, leftoverSeconds },
      typeData: best.typeData,
      units: best.unitsMined,
      rawValue: best.rawTotal ?? 0,
      reprocessValue: best.reprocessNet ?? 0,
    });

    renderRawSelected(best);
    renderReprocessTable({ materialsRows: best.reprocessRows, total: best.reprocessNet });

    if (rows.length === 1) {
      renderCompare({ rawTotal: best.rawTotal, reprocessTotal: best.reprocessNet, usedSeconds, taxPct });
    } else {
      window.__compareState = window.__compareState || { key: "reprocessPerHour", dir: "desc", selectedTypeId: best.typeId };
      window.__compareState.selectedTypeId = best.typeId;
      renderComparison(rows, usedSeconds, taxPct);
    }

    updateUrlFromInputs(best.typeId);
    setStatus("Done.");
  } catch (err) {
    console.error(err);
    setStatus(err?.message ? String(err.message) : "Something went wrong.", "error");
  }
}


function renderEmptyAfterCalc() {
  document.getElementById("summary").innerHTML = `<div class="placeholder">No full cycles to compute.</div>`;
  setTableMessage("rawTable", 6, "No full cycles to compute.");
  setTableMessage("reprocessTable", 5, "No full cycles to compute.");
  document.getElementById("reprocessTotalCell").textContent = "—";
  document.getElementById("compareBox").innerHTML = "";
}

function wireEvents() {
  document.getElementById("calcForm").addEventListener("submit", onCalculate);

  document.getElementById("shareBtn").addEventListener("click", async () => {
    const url = buildShareUrl();
    const ok = await copyTextToClipboard(url);
    setStatus(ok ? `Copied link to clipboard.` : `Could not copy automatically. Here it is: <code>${escapeHtml(url)}</code>`, ok ? "ok" : "");
  });

  document.getElementById("resetBtn").addEventListener("click", () => {
    resetUi();
    history.replaceState(null, "", location.pathname);
  });

  // Auto-save URL params on calculate? Keep explicit for now.


// Advanced refining math: compute effective yield (%)
const presetEl = document.getElementById("facilityPreset");
const baseEl = document.getElementById("facilityBasePct");
const rigEl = document.getElementById("rigBonusPts");
const secEl = document.getElementById("securityModPct");
const rEl = document.getElementById("skillR");
const reEl = document.getElementById("skillRE");
const opEl = document.getElementById("skillOP");
const impEl = document.getElementById("implantPct");
const taxEl = document.getElementById("taxPct");
const applyBtn = document.getElementById("applyAdvancedBtn");

function applyPreset() {
  if (!presetEl || !baseEl) return;
  const v = presetEl.value;
  if (v === "npc50") baseEl.value = "50";
  if (v === "athanor51") baseEl.value = "51";
  if (v === "tatara52") baseEl.value = "52";
}
if (presetEl) presetEl.addEventListener("change", applyPreset);
applyPreset();

if (applyBtn) {
  applyBtn.addEventListener("click", () => {
    const basePct = Number(baseEl?.value ?? 50);
    const rigPts = Number(rigEl?.value ?? 0);
    const secPct = Number(secEl?.value ?? 0);

    const R = Math.max(0, Math.min(5, Math.floor(Number(rEl?.value ?? 0))));
    const RE = Math.max(0, Math.min(5, Math.floor(Number(reEl?.value ?? 0))));
    const OP = Math.max(0, Math.min(5, Math.floor(Number(opEl?.value ?? 0))));
    const implantPct = Math.max(0, Number(impEl?.value ?? 0));
    const taxPct = Math.max(0, Number(taxEl?.value ?? 0));

    // Base yield: start from facility base, add rig bonus (percentage points),
    // and apply the security modifier ONLY if a rig is installed.
    let by = (basePct + rigPts) / 100;
    if (rigPts > 0 && secPct > 0) by *= (1 + (secPct / 100));

    // Character yield multipliers (exact EVE formula)
    let eff = by
      * (1 + (0.03 * R))
      * (1 + (0.02 * RE))
      * (1 + (0.02 * OP))
      * (1 + (implantPct / 100));

    // Clamp to [0, 1]
    eff = Math.max(0, Math.min(1, eff));

    document.getElementById("reprocessYieldPct").value = fmtNum(eff * 100, 2);
    window.__reprocessTaxPct = taxPct;

    setStatus(`Applied advanced yield: <b>${fmtNum(eff * 100, 2)}%</b>${taxPct > 0 ? ` (tax ${fmtNum(taxPct,1)}%)` : ""}.`);
  });
}

}

function boot() {
  populateSuggestions();
  wireEvents();
  resetUi();

  // Apply URL params if present
  const state = getStateFromUrl();
  applyStateToInputs(state);

  if (location.search) {
    setStatus("Loaded settings from URL. Click Calculate.", "");
  }
}

boot();
