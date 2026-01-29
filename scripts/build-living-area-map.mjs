// scripts/build-living-area-map.mjs
import fs from "fs";
import path from "path";
import fg from "fast-glob";
import * as XLSX from "xlsx/xlsx.mjs";

XLSX.set_fs(fs);

const norm = (s = "") => String(s).replace(/\s+/g, "").toLowerCase();
const isFilled = (v) => String(v ?? "").trim() !== "" && String(v).toLowerCase() !== "nan";

function latestXlsx(patterns) {
  const pats = Array.isArray(patterns) ? patterns : [patterns];
  const search = [
    ...pats,
    ...pats.map(p => `./${p}`),
    ...pats.map(p => `기상생활지수/${p}`),
    ...pats.map(p => `./기상생활지수/${p}`),
    ...pats.map(p => `**/${p}`),
  ];
  const files = fg.sync(search, {
    onlyFiles: true,
    dot: false,
    caseSensitiveMatch: false,
  });
  if (!files.length) {
    const debug = {
      cwd: process.cwd(),
      tried: search,
    };
    throw new Error(`No living index XLSX found.\n` + JSON.stringify(debug, null, 2));
  }
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0];
}

function toAreaNo(v) {
  if (!isFilled(v)) return "";
  const s = String(v).trim();
  if (/^\d+(\.0+)?$/.test(s)) return s.replace(/\.0+$/, "");
  return s.replace(/\D+/g, "");
}

function loadRows(filepath) {
  const wb = XLSX.readFile(filepath, { codepage: 65001 });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
  const header = rows[0] || [];
  const body = rows.slice(1);
  return body.map(r => Object.fromEntries(header.map((h, i) => [h ?? `col${i}`, r[i] ?? ""])));
}

function findHeaderKey(keys, candidates) {
  const cands = Array.isArray(candidates) ? candidates : [candidates];
  for (const cand of cands) {
    const hit = keys.find(k => norm(k) === norm(cand));
    if (hit) return hit;
  }
  for (const k of keys) {
    if (cands.some(c => norm(k).includes(norm(c)))) return k;
  }
  return null;
}

function buildMap(rows) {
  const byAdminKey = {};
  const byNxNy = {};
  const byNxNySpec = {};
  const collisions = [];

  for (const r of rows) {
    const keys = Object.keys(r);
    const kArea = findHeaderKey(keys, "행정구역코드");
    const k1 = findHeaderKey(keys, "1단계");
    const k2 = findHeaderKey(keys, "2단계");
    const k3 = findHeaderKey(keys, "3단계");
    const kNx = findHeaderKey(keys, "격자 X");
    const kNy = findHeaderKey(keys, "격자 Y");

    const areaNo = toAreaNo(kArea ? r[kArea] : "");
    const lv1 = k1 ? String(r[k1]).trim() : "";
    const lv2 = k2 ? String(r[k2]).trim() : "";
    const lv3 = k3 ? String(r[k3]).trim() : "";
    const nx = kNx ? String(r[kNx]).trim() : "";
    const ny = kNy ? String(r[kNy]).trim() : "";
    if (!areaNo || !lv1) continue;

    const adminKey = [lv1, lv2, lv3].filter(Boolean).join(" ").trim();
    if (adminKey) {
      if (!byAdminKey[adminKey]) byAdminKey[adminKey] = areaNo;
      else if (byAdminKey[adminKey] !== areaNo) {
        collisions.push({ adminKey, areaNo: byAdminKey[adminKey], other: areaNo });
      }
    }

    if (nx && ny) {
      const gridKey = `${nx},${ny}`;
      const specificity = [lv1, lv2, lv3].filter(Boolean).length;
      if (!byNxNy[gridKey] || specificity > (byNxNySpec[gridKey] || 0)) {
        byNxNy[gridKey] = areaNo;
        byNxNySpec[gridKey] = specificity;
      }
    }
  }

  return { byAdminKey, byNxNy, collisions };
}

async function main() {
  const outPath = path.join("lib", "living_area_map.json");
  const skipOnVercel = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
  if (skipOnVercel && fs.existsSync(outPath)) {
    console.log("Using existing living_area_map.json (skip XLSX parse on Vercel).");
    return;
  }
  const arg = process.argv.find(a => a.startsWith("--xlsx="));
  let file = arg ? arg.split("=")[1] : "";
  if (!file) {
    try {
      file = latestXlsx(["*.xlsx", "*.xls*"]);
    } catch (err) {
      if (fs.existsSync(outPath)) {
        console.log("XLSX not found; using existing living_area_map.json.");
        return;
      }
      throw err;
    }
  }
  if (!file || !fs.existsSync(file)) {
    if (fs.existsSync(outPath)) {
      console.log("XLSX not found; using existing living_area_map.json.");
      return;
    }
    throw new Error(`XLSX not found: ${file || "(empty)"}`);
  }
  console.log("Living index XLSX:", file);

  const rows = loadRows(file);
  const { byAdminKey, byNxNy, collisions } = buildMap(rows);

  if (!fs.existsSync("lib")) fs.mkdirSync("lib");
  const out = {
    meta: {
      source: path.basename(file),
      generatedAt: new Date().toISOString(),
      totalRows: rows.length,
      adminKeys: Object.keys(byAdminKey).length,
      nxnyKeys: Object.keys(byNxNy).length,
      collisions: collisions.length,
    },
    byAdminKey,
    byNxNy,
  };

  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), "utf-8");
  console.log(`✓ living_area_map.json: admin=${out.meta.adminKeys}, nxny=${out.meta.nxnyKeys}, collisions=${out.meta.collisions}`);
  if (collisions.length) {
    console.log("Collisions (first 5):", collisions.slice(0, 5));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
