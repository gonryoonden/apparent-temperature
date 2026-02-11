import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "../../data");

const STATIONS_PATH = path.join(DATA_DIR, "warnings_stations.json");
const AREA_CODES_PATH = path.join(DATA_DIR, "warnings_area_codes.json");
const OVERRIDES_PATH = path.join(DATA_DIR, "warnings_overrides.json");

let cache = null;

function loadJsonIfExists(p, fallback) {
  try {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    }
  } catch {
    /* ignore */
  }
  return fallback;
}

function buildIndex() {
  const stationsFile = loadJsonIfExists(STATIONS_PATH, { stations: [] });
  const areaCodesFile = loadJsonIfExists(AREA_CODES_PATH, { areas: [] });
  const overrides = loadJsonIfExists(OVERRIDES_PATH, {});

  const stations = Array.isArray(stationsFile.stations)
    ? stationsFile.stations
    : Array.isArray(stationsFile)
      ? stationsFile
      : [];

  const areas = Array.isArray(areaCodesFile.areas)
    ? areaCodesFile.areas
    : Array.isArray(areaCodesFile)
      ? areaCodesFile
      : [];

  const byStnId = new Map();
  const byAreaCode = new Map();

  for (const s of stations) {
    if (!s?.stnId) continue;
    byStnId.set(String(s.stnId), s);
    if (s.areaCode) {
      const code = String(s.areaCode);
      if (!byAreaCode.has(code)) {
        byAreaCode.set(code, { areaCode: code, areaName: s.areaName || null, stnIds: [], repStnId: null });
      }
      const entry = byAreaCode.get(code);
      entry.stnIds.push(String(s.stnId));
      if (s.sfcStnId && String(s.stnId) === String(s.sfcStnId)) {
        entry.repStnId = String(s.stnId);
      }
      if (!entry.areaName && s.areaName) entry.areaName = s.areaName;
    }
  }

  for (const a of areas) {
    if (!a?.areaCode) continue;
    const code = String(a.areaCode);
    if (!byAreaCode.has(code)) {
      byAreaCode.set(code, { areaCode: code, areaName: a.areaName || null, stnIds: [], repStnId: null });
    } else if (!byAreaCode.get(code).areaName && a.areaName) {
      byAreaCode.get(code).areaName = a.areaName;
    }
  }

  cache = { stations, areas, byStnId, byAreaCode, overrides };
  return cache;
}

function getData() {
  return cache || buildIndex();
}

function distance(nx, ny, s) {
  if (nx == null || ny == null || s?.nx == null || s?.ny == null) return null;
  const dx = nx - s.nx;
  const dy = ny - s.ny;
  return Math.sqrt(dx * dx + dy * dy);
}

function scoreByAdmin(areaName = "", adminKey = "") {
  const tokens = String(adminKey || "").split(" ").filter(Boolean).slice(0, 2);
  if (!tokens.length) return 0;
  let score = 0;
  for (const t of tokens) {
    if (areaName.includes(t)) score += 10;
  }
  return score;
}

export function resolveWarningsMapping({ adminKey, nx, ny, stnId, areaCode } = {}) {
  const { stations, byStnId, byAreaCode, overrides } = getData();
  const logEnabled = process.env.WARNINGS_LOG === "1";
  const warnEnabled = process.env.WARNINGS_WARN === "1";
  const logAndReturn = (result) => {
    if (logEnabled) {
      const safe = {
        adminKey,
        nx,
        ny,
        stnId: result?.stnId || null,
        areaCode: result?.areaCode || null,
        method: result?.method || null,
        confidence: result?.confidence || null,
        distance: result?.distance ?? null,
      };
      console.log("[warnings-mapping]", safe);
    }
    if (warnEnabled && (result?.confidence === "low" || result?.confidence === "none")) {
      console.warn("[warnings-mapping-warn]", {
        adminKey,
        nx,
        ny,
        method: result?.method || null,
        confidence: result?.confidence || null,
        distance: result?.distance ?? null,
        stnId: result?.stnId || null,
        areaCode: result?.areaCode || null,
      });
    }
    return result;
  };

  if (stnId) {
    const s = byStnId.get(String(stnId));
    return logAndReturn({
      stnId: String(stnId),
      stnName: s?.stnName || null,
      areaCode: s?.areaCode || null,
      areaName: s?.areaName || null,
      method: "stnId_param",
      distance: null,
      confidence: "high",
    });
  }

  if (areaCode) {
    const entry = byAreaCode.get(String(areaCode));
    const repId = entry?.repStnId || entry?.stnIds?.[0] || null;
    const s = repId ? byStnId.get(String(repId)) : null;
    return logAndReturn({
      stnId: repId,
      stnName: s?.stnName || null,
      areaCode: String(areaCode),
      areaName: entry?.areaName || s?.areaName || null,
      method: "areaCode_param",
      distance: null,
      confidence: "high",
    });
  }

  if (adminKey && overrides?.[adminKey]) {
    const o = overrides[adminKey];
    const s = o?.stnId ? byStnId.get(String(o.stnId)) : null;
    return logAndReturn({
      stnId: o?.stnId || null,
      stnName: s?.stnName || null,
      areaCode: o?.areaCode || s?.areaCode || null,
      areaName: s?.areaName || null,
      method: "override",
      distance: null,
      confidence: "high",
    });
  }

  const candidates = stations
    .map((s) => ({ s, d: distance(nx, ny, s) }))
    .filter((x) => x.d != null)
    .sort((a, b) => a.d - b.d)
    .slice(0, 5);

  if (!candidates.length) {
    return logAndReturn({
      stnId: null,
      stnName: null,
      areaCode: null,
      areaName: null,
      method: "none",
      distance: null,
      confidence: "none",
    });
  }

  let best = candidates[0];
  let bestScore = scoreByAdmin(best.s?.areaName || "", adminKey || "");
  for (const c of candidates) {
    const s = c.s;
    const score = scoreByAdmin(s?.areaName || "", adminKey || "");
    if (score > bestScore || (score === bestScore && c.d < best.d)) {
      best = c;
      bestScore = score;
    }
  }

  const confidence = bestScore >= 20 ? "high" : bestScore >= 10 ? "medium" : "low";
  return logAndReturn({
    stnId: String(best.s?.stnId || ""),
    stnName: best.s?.stnName || null,
    areaCode: best.s?.areaCode || null,
    areaName: best.s?.areaName || null,
    method: "nearest",
    distance: Math.round(best.d * 100) / 100,
    confidence,
  });
}
