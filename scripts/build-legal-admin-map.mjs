// scripts/build-legal-admin-map.mjs
import fs from "fs";
import path from "path";
import fg from "fast-glob";
import * as XLSX from "xlsx";

const DATA_DIR = "data";
const OUT_DIR  = "lib";

// ── 유틸: 헤더 정규화(공백/특수문자 제거, 영문/숫자/한글만)
const norm = (s="") => String(s).replace(/\s+/g,"").replace(/[~`!@#$%^&*()\-\[\]{}:;"',.<>/?\\|+=]/g,"").toLowerCase();
// 여러 후보 중 실제 헤더명 찾기
const pick = (row, ...cands) => {
  const keys = Object.keys(row);
  for (const cand of cands) {
    const want = norm(cand);
    const hit = keys.find(k => norm(k) === want);
    if (hit) return row[hit];
  }
  // 느슨한 포함 매칭(최후)
  for (const k of keys) if (wantIn(norm(k), cands.map(norm))) return row[k];
  return undefined;
};
const wantIn = (k, wants) => wants.some(w => k.includes(w));

// ── XLSX 로딩(첫 시트만 사용)
function loadXlsxRows(filepath) {
  const wb = XLSX.readFile(filepath, { codepage: 65001 });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { raw: false, defval: "" });
}

// ── 최신 파일 자동 선택(패턴)
function latest(pattern) {
  const list = fg.sync(pattern, { cwd: DATA_DIR, absolute: true }).sort();
  if (!list.length) throw new Error(`파일 없음: ${pattern}`);
  return list[list.length - 1];
}

async function main() {
  const fileB = latest("KIKcd_B*.xlsx");   // 법정동
  const fileH = latest("KIKcd_H*.xlsx");   // 행정동
  const fileM = latest("KIKmix*.xlsx");    // 매핑

  const rowsB = loadXlsxRows(fileB);
  const rowsH = loadXlsxRows(fileH);
  const rowsM = loadXlsxRows(fileM);

  // 1) 코드 → 엔티티 사전 구축
  const bjdByCode = new Map(); // 법정동코드 -> {sido,sigungu,legalName,abolished}
  for (const r of rowsB) {
    const sido = pick(r, "시도명", "시도", "광역시도명");
    const sigungu = pick(r, "시군구명", "시군구", "구군명");
    const name = pick(r, "법정동명", "법정동명칭");
    const code = pick(r, "법정동코드", "BJDONG_CD", "법정동코드값");
    const abolished = String(pick(r, "폐지여부", "존재여부")).includes("폐지");
    if (!code || !sido || !name) continue;
    bjdByCode.set(code, { sido, sigungu, name, abolished });
  }

  const hadmByCode = new Map(); // 행정기관코드 -> {sido,sigungu,adminName,abolished}
  for (const r of rowsH) {
    const sido = pick(r, "시도명", "시도", "광역시도명");
    const sigungu = pick(r, "시군구명", "시군구", "구군명");
    const name = pick(r, "행정동명", "행정기관명", "행정기관동명");
    const code = pick(r, "행정기관코드", "HADM_CD", "행정동코드");
    const abolished = String(pick(r, "폐지여부", "존재여부")).includes("폐지");
    if (!code || !sido || !name) continue;
    hadmByCode.set(code, { sido, sigungu, name, abolished });
  }

  // 2) 법정동 → 행정동 네트워크 구성(KIKmix)
  const legalToAdmin = new Map(); // "시도 시군구 법정동" -> Set("시도 시군구 행정동")
  for (const r of rowsM) {
    const bCode = pick(r, "법정동코드", "BJDONG_CD");
    const hCode = pick(r, "행정기관코드", "HADM_CD");
    if (!bCode || !hCode) continue;

    const b = bjdByCode.get(bCode);
    const h = hadmByCode.get(hCode);
    if (!b || !h) continue;
    if (b.abolished) continue; // 폐지 법정동은 제외(필요시 제거)

    const legalKey = `${b.sido} ${b.sigungu ?? ""} ${b.name}`.replace(/\s+/g," ").trim();
    const adminKey = `${h.sido} ${h.sigungu ?? ""} ${h.name}`.replace(/\s+/g," ").trim();

    if (!legalToAdmin.has(legalKey)) legalToAdmin.set(legalKey, new Set());
    legalToAdmin.get(legalKey).add(adminKey);
  }

  // 3) “도시 + 동어간” 인덱스(구가 빠진 입력 보정)
  const cityDongIndex = new Map(); // `${sido}|${stem}` -> Set(legalKey)
  const stem = (dongName) => String(dongName).replace(/제?\d+동$/,"").replace(/동$/,""); // "개금제1동"→"개금"
  for (const [legalKey] of legalToAdmin) {
    const [sido, sigungu, legalDong] = legalKey.split(/\s+/);
    if (!sido || !legalDong) continue;
    const key = `${sido}|${stem(legalDong)}`;
    if (!cityDongIndex.has(key)) cityDongIndex.set(key, new Set());
    cityDongIndex.get(key).add(legalKey);
  }

  // 4) 저장
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);
  const legal_to_admin = Object.fromEntries(
    [...legalToAdmin.entries()].map(([k,v]) => [k, [...v]])
  );
  const city_dong_index = Object.fromEntries(
    [...cityDongIndex.entries()].map(([k,v]) => [k, [...v]])
  );
  fs.writeFileSync(path.join(OUT_DIR, "legal_to_admin.json"), JSON.stringify(legal_to_admin, null, 2), "utf-8");
  fs.writeFileSync(path.join(OUT_DIR, "legal_index_city_dong.json"), JSON.stringify(city_dong_index, null, 2), "utf-8");
  console.log("✓ Wrote:",
    path.join(OUT_DIR,"legal_to_admin.json"),
    path.join(OUT_DIR,"legal_index_city_dong.json"),
    `(${Object.keys(legal_to_admin).length} legal keys)`
  );
}

main().catch(e => { console.error(e); process.exit(1); });
