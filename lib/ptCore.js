// lib/ptCore.js
import { readFileSync } from "fs";

// 행정동 → (nx,ny) DB
const nxnyDB = JSON.parse(
  readFileSync(new URL("./nxny_map.json", import.meta.url), "utf-8")
);

// ── 문자열 정규화/근접검색 유틸
const normalize = (s) => s.replace(/\s+/g, "").toLowerCase();
function normalizeAdminDivision(input) {
  if (/[동가리]$/.test(input) && !/\d/.test(input)) {
    const base = input.slice(0, -1), suffix = input.slice(-1);
    return Array.from({ length: 9 }, (_, i) => `${base}${i + 1}${suffix}`);
  }
  return [input];
}
function findClosestMatches(input, keys, limit = 5) {
  const q = normalize(input);
  const scored = keys.map(k => {
    const nk = normalize(k);
    let score = 0;
    if (nk.includes(q)) score += 10;
    if (nk.endsWith(q)) score += 5;
    const its = input.split(/\s+/).filter(Boolean);
    const kts = k.split(/\s+/).filter(Boolean);
    const common = its.filter(t => kts.some(kt => normalize(kt).includes(normalize(t))));
    score += common.length * 3;
    score -= Math.abs(nk.length - q.length) * 0.5;
    return { key: k, score };
  });
  return scored.sort((a,b)=>b.score-a.score).slice(0, limit).filter(s=>s.score>0).map(s=>s.key);
}

// ── 지역명 → 좌표
export function findNxNy(input) {
  if (!input || typeof input !== "string") return { coords: null, suggestions: [] };
  const q = normalize(input), keys = Object.keys(nxnyDB);
  const keysByLenDesc = keys.slice().sort((a,b)=>b.length-a.length);

  // 1) 완전일치
  for (const k of keys) if (normalize(k) === q) return { coords: nxnyDB[k], suggestions: [] };

  // 2) 숫자 없는 동 보정
  for (const cand of normalizeAdminDivision(input)) {
    const n = normalize(cand);
    for (const k of keys) if (normalize(k) === n || normalize(k).endsWith(n)) return { coords: nxnyDB[k], suggestions: [] };
  }

  // 3) 부분/토큰/접미 매칭
  for (const k of keysByLenDesc) if (normalize(k).includes(q)) return { coords: nxnyDB[k], suggestions: [] };
  const tokens = input.split(/\s+/).filter(Boolean).map(normalize);
  for (const k of keysByLenDesc) if (tokens.every(t=>normalize(k).includes(t))) return { coords: nxnyDB[k], suggestions: [] };
  const tail = keysByLenDesc.filter(k=>normalize(k).endsWith(q));
  if (tail.length) return { coords: nxnyDB[tail.sort((a,b)=>a.length-b.length)[0]], suggestions: [] };

  return { coords: null, suggestions: findClosestMatches(input, keys, 5) };
}

// ── 체감온도(여름, KMA2016) + 등급
export function perceivedTempKMA(Ta, RH) {
  const Tw =
    Ta * Math.atan(0.151977 * Math.sqrt(RH + 8.313659)) +
    Math.atan(Ta + RH) -
    Math.atan(RH - 1.676331) +
    0.00391838 * Math.pow(RH, 1.5) * Math.atan(0.023101 * RH) -
    4.686035;
  const PT =
    -0.2442 + 0.55399 * Tw + 0.45535 * Ta - 0.0022 * Tw * Tw + 0.00278 * Tw * Ta + 3.0;
  return Math.round(PT * 10) / 10;
}
export function levelByPT(pt) {
  if (pt >= 40) return "위험";
  if (pt >= 38) return "경고";
  if (pt >= 35) return "주의";
  if (pt >= 32) return "관심";
  return "정상";
}
