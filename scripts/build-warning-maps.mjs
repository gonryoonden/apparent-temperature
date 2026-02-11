// scripts/build-warning-maps.mjs
import fs from "fs";
import path from "path";
import fg from "fast-glob";
import { createRequire } from "module";
import * as XLSX from "xlsx/xlsx.mjs";

XLSX.set_fs(fs);

const require = createRequire(import.meta.url);
const { latlonToGrid } = require("../lib/kmaGrid.js");

function latestXlsx(patterns, { allowMissing = false } = {}) {
  const pats = Array.isArray(patterns) ? patterns : [patterns];
  const search = [];
  for (const p of pats) {
    search.push(p, `./${p}`, `가이드/${p}`, `./가이드/${p}`, `data/${p}`, `./data/${p}`, `**/${p}`);
  }
  const files = fg.sync(search, { onlyFiles: true, dot: false, caseSensitiveMatch: false });
  if (!files.length) {
    if (allowMissing) return null;
    throw new Error(`No files matched any pattern: ${JSON.stringify(search, null, 2)}`);
  }
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0];
}

const norm = (s = "") =>
  String(s)
    .toLowerCase()
    .replace(/[\s_.,\-\\/()<>[\]{}"'`~!@#$%^&*+=:;|?]/g, "");

function findHeaderRow(rows, must) {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || [];
    const hit = must.every((m) =>
      row.some((c) => norm(c).includes(norm(m)))
    );
    if (hit) return i;
  }
  return 0;
}

function loadSheetRows(filepath, sheetName) {
  const wb = XLSX.readFile(filepath, { codepage: 65001 });
  const ws = wb.Sheets[sheetName || wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
}

function getByHeader(row, header, ...cands) {
  const keys = header.map((h) => norm(h));
  for (const cand of cands) {
    const want = norm(cand);
    const idx = keys.findIndex((k) => k === want);
    if (idx >= 0) return row[idx];
  }
  for (let i = 0; i < keys.length; i++) {
    if (cands.some((c) => keys[i].includes(norm(c)))) return row[i];
  }
  return undefined;
}

const digitsOnly = (v) => String(v ?? "").replace(/\D+/g, "");
const cleanCell = (v) =>
  String(v ?? "")
    .trim()
    .replace(/[=,]+$/g, "")
    .trim();
const toNum = (v) => {
  const s = cleanCell(v);
  const m = s.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
};

function buildStations(filepath) {
  const rows = loadSheetRows(filepath);
  const headerIdx = findHeaderRow(rows, ["stn_id", "stn_ko"]);
  const header = rows[headerIdx] || [];
  const body = rows.slice(headerIdx + 1);
  const stations = [];
  for (const r of body) {
    if (!r || r.every((c) => String(c).trim() === "")) continue;
    const stnId = digitsOnly(getByHeader(r, header, "stn_id", "지점번호", "#stn_id"));
    if (!stnId) continue;
    const stnName = cleanCell(getByHeader(r, header, "stn_ko", "지점명")) || null;
    const lon = toNum(getByHeader(r, header, "lon", "경도"));
    const lat = toNum(getByHeader(r, header, "lat", "위도"));
    const areaCode = cleanCell(getByHeader(r, header, "wrn_id", "특보구역코드")) || null;
    const areaName = cleanCell(getByHeader(r, header, "wrn_ko", "특보구역명")) || null;
    const sfcStnId = digitsOnly(getByHeader(r, header, "sfc_stn_id", "특보발표대표지점번호"));
    const fctId = cleanCell(getByHeader(r, header, "fct_id", "특성코드")) || null;
    let nx = null, ny = null;
    if (lat != null && lon != null) {
      const g = latlonToGrid(lat, lon);
      nx = g?.nx ?? null;
      ny = g?.ny ?? null;
    }
    stations.push({
      stnId,
      stnName,
      lat,
      lon,
      nx,
      ny,
      areaCode,
      areaName,
      sfcStnId: sfcStnId || null,
      fctId,
    });
  }
  return stations;
}

function buildAreaCodes(filepath) {
  const wb = XLSX.readFile(filepath, { codepage: 65001 });
  const areas = [];
  for (const sheet of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, raw: false, defval: "" });
    const headerIdx = findHeaderRow(rows, ["areacode"]);
    const header = rows[headerIdx] || [];
    const body = rows.slice(headerIdx + 1);
    for (const r of body) {
      if (!r || r.every((c) => String(c).trim() === "")) continue;
      let areaCode = getByHeader(r, header, "areaCode", "특보구역코드");
      let areaName = getByHeader(r, header, "특보구역", "특보구역명", "특보구역 명");
      if (!areaCode && r.length >= 3) areaCode = r[2];
      if (!areaName && r.length >= 4) areaName = r[3];
      areaCode = cleanCell(areaCode);
      areaName = cleanCell(areaName);
      if (!areaCode) continue;
      areas.push({ areaCode, areaName: areaName || null, group: sheet });
    }
  }
  return areas;
}

async function main() {
  const stationFile = latestXlsx([
    "*특보구역코드*해당*지점*.xlsx",
    "*특보구역코드*지점*.xlsx",
  ], { allowMissing: true });
  const areaFile = latestXlsx(["*특보구역코드안내*.xlsx"], { allowMissing: true });

  if (!stationFile || !areaFile) {
    const hasStations = fs.existsSync(path.join("data", "warnings_stations.json"));
    const hasAreas = fs.existsSync(path.join("data", "warnings_area_codes.json"));
    if (hasStations && hasAreas) {
      console.log("No XLSX found; using existing data/warnings_*.json.");
      return;
    }
    throw new Error("No XLSX found and existing warnings JSON missing. Provide XLSX or commit data/warnings_*.json.");
  }

  const stations = buildStations(stationFile);
  const areas = buildAreaCodes(areaFile);

  if (!fs.existsSync("data")) fs.mkdirSync("data");
  fs.writeFileSync(
    path.join("data", "warnings_stations.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), stations }, null, 2),
    "utf-8"
  );
  fs.writeFileSync(
    path.join("data", "warnings_area_codes.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), areas }, null, 2),
    "utf-8"
  );

  console.log(`stations: ${stations.length}`);
  console.log(`areas: ${areas.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
