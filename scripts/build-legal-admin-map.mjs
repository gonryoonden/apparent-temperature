// scripts/build-legal-admin-map.mjs
import fs from "fs";
import path from "path";
import fg from "fast-glob";

function latestXlsx(patterns) {
  const pats = Array.isArray(patterns) ? patterns : [patterns];
  const search = [
    ...pats,
    ...pats.map(p => `./${p}`),
    ...pats.map(p => `data/${p}`),
    ...pats.map(p => `./data/${p}`),
    ...pats.map(p => `**/${p}`),
  ];
  const files = fg.sync(search, {
    onlyFiles: true,
    dot: false,
    caseSensitiveMatch: false, // .XLSX도 허용
  });
  if (!files.length) {
    const debug = {
      cwd: process.cwd(),
      cwdFiles: fs.readdirSync('.').filter(f => /\.xlsx?$/i.test(f)),
      dataDir: fs.existsSync('data') ? fs.readdirSync('data').filter(f => /\.xlsx?$/i.test(f)) : [],
      tried: search,
    };
    throw new Error(`No files matched any pattern.\n` + JSON.stringify(debug, null, 2));
  }
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0];
}

// ESM 전용 빌드 + FS 주입
import * as XLSX from "xlsx/xlsx.mjs";
XLSX.set_fs(fs);

// 헤더 키 정규화 유틸
const norm = (s="") => String(s).replace(/\s+/g,"").replace(/[~`!@#$%^&*()\-\[\]{}:;"',.<>/?\\|+=]/g,"").toLowerCase();
const wantIn = (k, wants) => wants.some(w => k.includes(w));
const pick = (row, ...cands) => {
  const keys = Object.keys(row);
  for (const cand of cands) {
    const want = norm(cand);
    const hit = keys.find(k => norm(k) === want);
    if (hit) return row[hit];
  }
  for (const k of keys) if (wantIn(norm(k), cands.map(norm))) return row[k];
  return undefined;
};

// 코드/상태 정규화
const digitsOnly = (v) => String(v ?? "").replace(/\D+/g, "");
const toCode = (v, width) => {
  const d = digitsOnly(v);
  if (!d) return "";
  return d.padStart(width, "0").slice(-width);
};
const isFilled = (v) => String(v ?? "").trim() !== "" && String(v).toLowerCase() !== "nan";

// 헤더 자동탐지 + 행 파싱
function loadXlsxRows(filepath) {
   const wb = XLSX.readFile(filepath, { codepage: 65001 });
   const ws = wb.Sheets[wb.SheetNames[0]];
   const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
  const idx = rows.findIndex(r =>
    Array.isArray(r) && r.some(c =>
      /법정동|행정기관|행정동|시도|시군구|코드|말소일자|읍면동명|동리명/.test(String(c))
    )
  );
  const header = rows[idx] || rows[0] || [];
  const body = rows.slice((idx >= 0 ? idx + 1 : 1));
  return body.map(r => Object.fromEntries(header.map((h,i) => [h ?? `col${i}`, r[i] ?? ""])));
}

// KIKmix 단독으로 산출물 생성 (말소일자 있으면 폐지로 간주)
function buildFromMixOnly(rowsM) {
  const legalToAdmin = new Map();
  const cityDongIndex = new Map();
  for (const r of rowsM) {
    if (isFilled(pick(r, "말소일자", "폐지일자"))) continue; // 폐지 라인 제외
    const sido = pick(r, "시도명","시도","광역시도명");
    const sigungu = pick(r, "시군구명","시군구","구군명");
    const legalName = pick(r, "동리명","법정동명","법정리명") || pick(r, "읍면동명"); // 법정동명 대체
    const adminName = pick(r, "읍면동명","행정동명","행정기관명","행정기관동명");
    const bCode = toCode(pick(r, "법정동코드","BJDONG_CD","법정동코드(10자리)"), 10);
    const hCode = toCode(pick(r, "행정동코드","HADM_CD","행정기관코드","행정기관코드(9자리)"), 9);
    if (!sido || !legalName || !bCode || !hCode) continue;

    const legalKey = `${sido} ${sigungu ?? ""} ${legalName}`.replace(/\s+/g," ").trim();
    const adminKey = `${sido} ${sigungu ?? ""} ${adminName}`.replace(/\s+/g," ").trim();
    if (!legalToAdmin.has(legalKey)) legalToAdmin.set(legalKey, new Set());
    legalToAdmin.get(legalKey).add(adminKey);

    const cityKey = `${sido} ${sigungu ?? ""}`.replace(/\s+/g," ").trim();
    if (!cityDongIndex.has(cityKey)) cityDongIndex.set(cityKey, new Set());
    cityDongIndex.get(cityKey).add(legalName);
  }
  return {
    outLegal: Object.fromEntries([...legalToAdmin.entries()].map(([k,v]) => [k, [...v]])),
    outIndex: Object.fromEntries([...cityDongIndex.entries()].map(([k,v]) => [k, [...v]])),
  };
}


async function main() {
  // 1) XLSX만 읽기
  const argMix = process.argv.find(a => a.startsWith("--mix="));
  const fileM = argMix ? argMix.split("=")[1] : latestXlsx(["KIKmix*.xlsx", "KIKmix*.xls*"]);
  console.log("MIX file:", fileM);

  const rowsM = loadXlsxRows(fileM);
  console.log(`rows: M=${rowsM.length}`);

  // 5) 저장 + sanity check
  if (!fs.existsSync("lib")) fs.mkdirSync("lib");
  const { outLegal, outIndex } = buildFromMixOnly(rowsM);

  // 최소 개수 보증(비정상 입력 방지)
  if (Object.keys(outLegal).length < 1000) {
    throw new Error(`Too few legal keys: ${Object.keys(outLegal).length}. Check XLSX headers/files.`);
  }

  fs.writeFileSync(path.join("lib","legal_to_admin.json"), JSON.stringify(outLegal, null, 2), "utf-8");
  fs.writeFileSync(path.join("lib","legal_index_city_dong.json"), JSON.stringify(outIndex, null, 2), "utf-8");
  console.log(`✓ legal_to_admin.json: ${Object.keys(outLegal).length} keys`);
  console.log(`✓ legal_index_city_dong.json: ${Object.keys(outIndex).length} keys`);
}

main().catch(e => { console.error(e); process.exit(1); });
