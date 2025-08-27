// lib/ptCore.js
import { readFileSync } from "fs";

// ── 안전하게 aliases.json 로드(없으면 빈 객체)
let aliases = { alias: {}, redirect: {} };
try {
  aliases = JSON.parse(readFileSync(new URL("./aliases.json", import.meta.url), "utf-8"));
} catch { /* optional */ }

// 행정동 → (nx,ny) DB
const nxnyDB = JSON.parse(
  readFileSync(new URL("./nxny_map.json", import.meta.url), "utf-8")
);

// ── 정규화 유틸 (공백 제거 + '제1동'의 '제' 무시)
const norm = (s) =>
  s.replace(/\s+/g, "")
   .replace(/제(?=\d+동)/g, "")
   .toLowerCase();

// 근접 제안용 간단 스코어러
function findClosestMatches(input, keys, limit = 5) {
  const q = norm(input);
  const its = input.split(/\s+/).filter(Boolean);
  const scored = keys.map((k) => {
    const nk = norm(k);
    let score = 0;
    if (nk.includes(q)) score += 10;
    if (nk.endsWith(q)) score += 5;
    const kts = k.split(/\s+/).filter(Boolean);
    const common = its.filter((t) => kts.some((kt) => norm(kt).includes(norm(t))));
    score += common.length * 3;
    score -= Math.abs(nk.length - q.length) * 0.5;
    return { key: k, score };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .filter((s) => s.score > 0)
    .map((s) => s.key);
}

// 별칭/리다이렉트 전처리
function applyAliases(raw) {
  let s = String(raw || "").trim();
  if (!s) return s;
  if (aliases.redirect[s]) return aliases.redirect[s];
  for (const [k, v] of Object.entries(aliases.alias || {})) {
    const re = new RegExp(`^${k}(?=\\s|$)`);
    if (re.test(s)) s = s.replace(re, v);
  }
  return s.replace(/\s+/g, " ");
}

// 무번호 동 → 후보 확장
function expandDongCandidates(base) {
  const out = [];
  for (let i = 1; i <= 20; i++) {
    out.push(`${base}${i}동`, `${base}제${i}동`);
  }
  return out;
}

// ── 지역명 → 좌표
export function findNxNy(input) {
  if (!input || typeof input !== "string") return { coords: null, suggestions: [] };

  // 0) 전처리(별칭/공백)
  const pre = applyAliases(input);

  const keys = Object.keys(nxnyDB);
  const keysByLenDesc = keys.slice().sort((a, b) => b.length - a.length);
  const q = norm(pre);

  // 1) 완전 일치(정규화 기준)
  for (const k of keys) if (norm(k) === q) return { coords: nxnyDB[k], suggestions: [] };

  // 2) 무번호 동 보정(강화): "부산 개금동" 같이 '시+동'만 있을 때도 동-숫자 확장.
  //    1) '도시(광역시/도)' 토큰을 추출해 도시 범위 안에서만 탐색 (오탐↓)
  //    2) 끝말이 '개금(제)?숫자동'으로 끝나는 모든 키 후보 수집 → 최빈 좌표 선택
  const m = pre.match(/([가-힣0-9]+)동$/); // 마지막 토큰이 '...동'
  if (m) {
    const dongStem = m[1].replace(/제?\d+$/, ""); // '개금동','개금1동','개금제1동' → '개금'
    // 도시(광역시/도) 추출(있으면 제한, 없으면 전체 탐색)
    const cityMatch = pre.match(/^([^\s]+(?:특별시|광역시|특별자치시|자치시|도))/);
    const city = cityMatch ? cityMatch[1] : null;
    const pool = city ? keys.filter(k => k.startsWith(city)) : keys;

    const hits = [];
    for (let i = 1; i <= 20; i++) {
      const end1 = `${dongStem}${i}동`;
      const end2 = `${dongStem}제${i}동`;
      for (const k of pool) {
        if (k.endsWith(end1) || k.endsWith(end2)) hits.push(k);
      }
    }
    if (hits.length) {
      const coordStrs = hits.map(k => `${nxnyDB[k].nx},${nxnyDB[k].ny}`);
      const freq = coordStrs.reduce((a,c)=>(a[c]=(a[c]||0)+1,a),{});
      const best = Object.entries(freq).sort((a,b)=>b[1]-a[1])[0][0];
      const [nx, ny] = best.split(",").map(Number);
      // 상위 5개 구체 동명 추천(사용자 확인용)
      const suggestions = [...new Set(hits)].slice(0,5);
      return { coords: { nx, ny }, suggestions };
    }
  }

  // 3) 부분 포함(길이 긴 키 우선)
  for (const k of keysByLenDesc) if (norm(k).includes(q)) return { coords: nxnyDB[k], suggestions: [] };

  // 4) 토큰 모두 포함
  const tokens = pre.split(/\s+/).filter(Boolean).map(norm);
  for (const k of keysByLenDesc) if (tokens.every((t) => norm(k).includes(t))) return { coords: nxnyDB[k], suggestions: [] };

  // 5) 접미 일치
  const tail = keysByLenDesc.filter((k) => norm(k).endsWith(q));
  if (tail.length) return { coords: nxnyDB[tail.sort((a, b) => a.length - b.length)[0]], suggestions: [] };

  // 6) 후보 제안(근접)
  return { coords: null, suggestions: findClosestMatches(pre, keys, 5) };
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
