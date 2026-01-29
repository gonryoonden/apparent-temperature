// lib/ptCore.js
import { readFileSync } from "fs";

const nxnyDB = JSON.parse(readFileSync(new URL("./nxny_map.json", import.meta.url), "utf-8"));
let legalToAdmin = {};
let cityDongIndex = {};
try {
  legalToAdmin = JSON.parse(readFileSync(new URL("./legal_to_admin.json", import.meta.url), "utf-8"));
  cityDongIndex = JSON.parse(readFileSync(new URL("./legal_index_city_dong.json", import.meta.url), "utf-8"));
} catch { /* 초기엔 파일이 없을 수 있음(첫 빌드 전) */ }

// ── 안전하게 aliases.json 로드(없으면 빈 객체)
let aliases = { alias: {}, redirect: {} };
try {
  aliases = JSON.parse(readFileSync(new URL("./aliases.json", import.meta.url), "utf-8"));
} catch { /* optional */ }


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
  for (const k of keys) {
    if (norm(k) === q) return { coords: nxnyDB[k], suggestions: [] };
  }

  // 1-b) 법정동 입력일 가능성: legal_to_admin에서 우선 조회
  const legalDirect = legalToAdmin[pre];
  if (legalDirect && legalDirect.length) {
    const admins = legalDirect.filter(k => nxnyDB[k]);
    if (admins.length) {
      const coords = admins.map(k => `${nxnyDB[k].nx},${nxnyDB[k].ny}`);
      const freq = coords.reduce((a,c)=>(a[c]=(a[c]||0)+1,a),{});
      const best = Object.entries(freq).sort((a,b)=>b[1]-a[1])[0][0];
      const [nx, ny] = best.split(",").map(Number);
      return { coords: { nx, ny }, suggestions: admins.slice(0,5) };
    }
  }

  // 1-c) “도시 + 동어간”(구 생략) → legal 인덱스로 후보 모으기
  const cityMatch1 = pre.match(/^([^\s]+(?:특별시|광역시|특별자치시|특별자치도|도))\s+(.+)$/);
  if (cityMatch1) {
    const city1 = cityMatch1[1];                   // 예: 부산광역시
    const dongTok = (pre.match(/([가-힣0-9]+)동$/) || [])[1]; // 끝이 ~동
    if (dongTok) {
      const stem = dongTok.replace(/제?\d+동$/,"").replace(/동$/,"");
      const idxKey = `${city1}|${stem}`;
      const legals = cityDongIndex[idxKey] || [];
      if (legals.length) {
        // legal 후보 → admin 후보 → 좌표 최빈값
        const admins = Array.from(new Set(legals.flatMap(k => legalToAdmin[k] || []))).filter(k => nxnyDB[k]);
        if (admins.length) {
          const coords = admins.map(k => `${nxnyDB[k].nx},${nxnyDB[k].ny}`);
          const freq = coords.reduce((a,c)=>(a[c]=(a[c]||0)+1,a),{});
          const best = Object.entries(freq).sort((a,b)=>b[1]-a[1])[0][0];
          const [nx, ny] = best.split(",").map(Number);
          return { coords: { nx, ny }, suggestions: admins.slice(0,5) };
        }
      }
    }
  }

  // 2) 무번호 동 보정(강화): '시+동'만 있어도 동-숫자 확장 후 탐색
  const m = pre.match(/([가-힣0-9]+)동$/); // 마지막 토큰이 '...동'
  if (m) {
    const dongStem = m[1].replace(/제?\d+$/, ""); // '개금동','개금1동','개금제1동' → '개금'
    // 도시(광역시/도) 추출(있으면 제한, 없으면 전체 탐색)
    const cityMatch2 = pre.match(/^([^\s]+(?:특별시|광역시|특별자치시|자치시|도))/);
    const city2 = cityMatch2 ? cityMatch2[1] : null;
    const pool = city2 ? keys.filter(k => k.startsWith(city2)) : keys;

    // 2-a) 동-숫자/제숫자 확장으로 끝말 매칭
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
      const suggestions = [...new Set(hits)].slice(0,5);
      return { coords: { nx, ny }, suggestions };
    }

    // 2-b) 숫자 확장 히트가 없으면, 도시 범위에서 '동 어간 포함'으로 후보 수집
    const stemNorm = norm(dongStem);
    const containHits = pool.filter(k => norm(k).includes(stemNorm));
    if (containHits.length) {
      const coordStrs = containHits.map(k => `${nxnyDB[k].nx},${nxnyDB[k].ny}`);
      const freq = coordStrs.reduce((a,c)=>(a[c]=(a[c]||0)+1,a),{});
      const best = Object.entries(freq).sort((a,b)=>b[1]-a[1])[0][0];
      const [nx, ny] = best.split(",").map(Number);
      const suggestions = [...new Set(containHits)].slice(0,5);
      return { coords: { nx, ny }, suggestions };
    }
  }

  // 3) 부분 포함(길이 긴 키 우선)
  for (const k of keysByLenDesc) {
    if (norm(k).includes(q)) return { coords: nxnyDB[k], suggestions: [] };
  }

  // 4) 토큰 모두 포함
  const tokens = pre.split(/\s+/).filter(Boolean).map(norm);
  for (const k of keysByLenDesc) {
    if (tokens.every((t) => norm(k).includes(t))) return { coords: nxnyDB[k], suggestions: [] };
  }

  // 5) 접미 일치
  const tail = keysByLenDesc.filter((k) => norm(k).endsWith(q));
  if (tail.length) {
    return { coords: nxnyDB[tail.sort((a, b) => a.length - b.length)[0]], suggestions: [] };
  }

  // 6) 후보 제안(근접)
  return { coords: null, suggestions: findClosestMatches(pre, keys, 5) };
}

// ── 체감온도(여름, ) + 등급

