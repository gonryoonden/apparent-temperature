// api/pt-forecast.js
import { callVilageWithFallback } from "../lib/kmaForecast.js";
import { perceivedTempKMA, levelByPT } from "../lib/ptCore.js";
import { cacheGet, cacheSet } from "../lib/cache.js";
import { ttlToNext30m, ttlToNextVilageIssue } from "../lib/kma-ttl.js";
import { resolveRegion } from "../lib/region-resolver.js";
// KST 시간 유틸 + 단기예보(8회) 베이스타임 산출
const toKST = (d = new Date()) => new Date(d.getTime() + 9 * 60 * 60 * 1000);
const pad2 = n => String(n).padStart(2, '0');
const yyyymmdd = d => `${d.getUTCFullYear()}${pad2(d.getUTCMonth()+1)}${pad2(d.getUTCDate())}`;
const yyyymmddhhmm = d => `${yyyymmdd(d)}${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;
const DT_RE = /^\d{12}$/;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function toKstIsoFromDt(dt) {
  if (!dt || dt.length < 12) return null;
  const yyyy = dt.slice(0, 4);
  const mm = dt.slice(4, 6);
  const dd = dt.slice(6, 8);
  const hh = dt.slice(8, 10);
  const mi = dt.slice(10, 12);
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}+09:00`;
}

function dtToMsKst(dt) {
  if (!DT_RE.test(dt || "")) return null;
  const yyyy = Number(dt.slice(0, 4));
  const mm = Number(dt.slice(4, 6));
  const dd = Number(dt.slice(6, 8));
  const hh = Number(dt.slice(8, 10));
  const mi = Number(dt.slice(10, 12));
  return Date.UTC(yyyy, mm - 1, dd, hh - 9, mi);
}

function msToDtKst(ms) {
  const kst = new Date(ms + KST_OFFSET_MS);
  return `${yyyymmdd(kst)}${pad2(kst.getUTCHours())}${pad2(kst.getUTCMinutes())}`;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function numberOrStringOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : String(value);
}

function clampRangeFilter(filter, maxHours = 120) {
  const fromMs = dtToMsKst(filter.from);
  const toMs = dtToMsKst(filter.to);
  if (fromMs == null || toMs == null) return filter;
  const maxMs = maxHours * 60 * 60 * 1000;
  if (toMs - fromMs > maxMs) {
    return { from: filter.from, to: msToDtKst(fromMs + maxMs) };
  }
  return filter;
}

function buildRangeFilter({ range, from, to }) {
  const hasFromTo = DT_RE.test(from || "") && DT_RE.test(to || "");
  if (hasFromTo) {
    const ordered = from <= to ? { from, to } : { from: to, to: from };
    return clampRangeFilter(ordered);
  }

  const nowKst = toKST(new Date());
  const r = String(range || "").toLowerCase();
  if (r === "tomorrow") {
    const day = new Date(nowKst.getTime());
    day.setUTCHours(0, 0, 0, 0);
    day.setUTCDate(day.getUTCDate() + 1);
    const ymd = yyyymmdd(day);
    return { from: `${ymd}0000`, to: `${ymd}2359` };
  }

  const hourMatch = r.match(/^(\d+)h$/);
  if (hourMatch) {
    const hours = Number(hourMatch[1]);
    const allowed = new Set([6, 24, 48, 72, 120]);
    if (allowed.has(hours)) {
      const start = nowKst;
      const end = new Date(nowKst.getTime() + hours * 60 * 60 * 1000);
      return { from: yyyymmddhhmm(start), to: yyyymmddhhmm(end) };
    }
  }

  const today = new Date(nowKst.getTime());
  today.setUTCHours(0, 0, 0, 0);
  const ymd = yyyymmdd(today);
  return { from: `${ymd}0000`, to: `${ymd}2359` };
}

function getScalar(q) {
  if (Array.isArray(q)) return null;
  if (q === undefined || q === null) return null;
  return String(q);
}

/**
 * getVilageBaseDateTime
 * - 발표시각: 02/05/08/11/14/17/20/23시
 * - 현재 시각(KST) 기준, 해당/이전 발표시각 중 가장 최근 것으로 선택
 * - 동일 시각에서는 분이 10분 이상일 때만 그 시각을 채택(여유 버퍼)
 */
function getVilageBaseDateTime(nowUTC = new Date()) {
  const kst = toKST(nowUTC);
  const slots = [2,5,8,11,14,17,20,23];
  const h = kst.getUTCHours();
  const m = kst.getUTCMinutes();
  let baseH = [...slots].reverse().find(H => H < h || (H === h && m >= 10));
  if (baseH == null) {
    // 첫 발표(02시) 이전: 전날 23시로
    baseH = 23;
    kst.setUTCDate(kst.getUTCDate() - 1);
  }
  return { base_date: yyyymmdd(kst), base_time: `${pad2(baseH)}00` };
}

// 평균 n시간 체감온도 최악 구간(rolling avg) 찾기
function worstWindowAvgPT(hours, win = 3) {
  let best = null, sum = 0, count = 0;
  for (let i = 0; i < hours.length; i++) {
    const v = typeof hours[i].PT === "number" ? hours[i].PT : null;
    if (v == null) { sum = 0; count = 0; continue; }
    sum += v; count += 1;

    if (count > win) {
      const old = typeof hours[i - win].PT === "number" ? hours[i - win].PT : null;
      if (old != null) sum -= old; else { sum = v; count = 1; }
      count = win;
    }
    if (count === win) {
      const avg = +(sum / win).toFixed(1);
      if (!best || avg > best.avg) {
        best = { start: hours[i - win + 1].dt, end: hours[i].dt, avg };
      }
    }
  }
  return best;
}


function computeHazards(rows) {
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);

  const wsdValues = rows.map(r => r.WSD).filter(isNum);
  const windRisk = wsdValues.length ? wsdValues.some(v => v >= 10) : null;

  const ptyValues = rows.map(r => r.PTY).filter(isNum);
  const snoValues = rows.map(r => r.SNO).filter(isNum);
  const snoStrings = rows.map(r => r.SNO).filter(v => typeof v === "string" && v.trim());
  let snowRisk = null;
  if (ptyValues.some(v => v === 2 || v === 3) || snoValues.some(v => v > 0)) {
    snowRisk = true;
  } else if (ptyValues.length || snoValues.length) {
    snowRisk = false;
  } else if (snoStrings.length) {
    snowRisk = null;
  }

  const pcpValues = rows.map(r => r.PCP).filter(isNum);
  const pcpStrings = rows.map(r => r.PCP).filter(v => typeof v === "string" && v.trim());
  const hasPt = rows.some(r => isNum(r.PT));
  const hasNumericWetInputs = ptyValues.length || pcpValues.length || snoValues.length;
  let slipFreezeRisk = null;
  if (hasPt && hasNumericWetInputs) {
    slipFreezeRisk = rows.some(r =>
      isNum(r.PT) && r.PT <= 0 && (
        (isNum(r.PTY) && r.PTY > 0) ||
        (isNum(r.PCP) && r.PCP > 0) ||
        (isNum(r.SNO) && r.SNO > 0)
      )
    );
  } else if (hasPt && (pcpStrings.length || snoStrings.length)) {
    slipFreezeRisk = null;
  }

  return { windRisk, snowRisk, slipFreezeRisk };
}

function shapeForecast(fc, { nx, ny, region }, rangeFilter, options = {}) {
  const { includeLegacy = false } = options;
  const { base_date, base_time, items } = fc;

  // ⑤ 시간대별 값 모으기
  const want = new Map(); // key=fcstDate+fcstTime → {TMP, REH, WSD, PTY, SKY, POP, PCP, SNO}
  const dailyMap = new Map(); // key=fcstDate → {date, TMN, TMX}
  for (const it of items) {
    const key = `${it.fcstDate}${it.fcstTime}`;
    if (!want.has(key)) want.set(key, {});
    if (["TMP","REH","WSD","PTY","SKY","POP","PCP","SNO"].includes(it.category)) {
      want.get(key)[it.category] = it.fcstValue;
    }
    if (it.category === "TMN" || it.category === "TMX") {
      if (!dailyMap.has(it.fcstDate)) dailyMap.set(it.fcstDate, { date: it.fcstDate, TMN: null, TMX: null });
      const v = numberOrNull(it.fcstValue);
      if (it.category === "TMN") dailyMap.get(it.fcstDate).TMN = v;
      if (it.category === "TMX") dailyMap.get(it.fcstDate).TMX = v;
    }
  }

  // ⑥ 체감온도/레벨 계산
  const rowsAll = [];
  for (const [key, v] of [...want.entries()].sort((a,b)=>a[0].localeCompare(b[0]))) {
    const TMP = numberOrNull(v.TMP);
    const REH = numberOrNull(v.REH);
    const WSD = numberOrNull(v.WSD);
    const POP = numberOrNull(v.POP);
    const PCP = numberOrStringOrNull(v.PCP);
    const SNO = numberOrStringOrNull(v.SNO);
    const PTY = numberOrNull(v.PTY);
    const SKY = numberOrNull(v.SKY);
    let pt = null, level = null;
    if (TMP != null && REH != null) { pt = perceivedTempKMA(TMP, REH); level = levelByPT(pt); }
    const dtKst = toKstIsoFromDt(key);
    rowsAll.push({
      dt: key,
      dtKst,
      TMP: TMP ?? null,
      REH: REH ?? null,
      WSD: WSD ?? null,
      POP: POP ?? null,
      PCP: PCP ?? null,
      SNO: SNO ?? null,
      PTY: PTY ?? null,
      SKY: SKY ?? null,
      PT: pt ?? null,
      level
    });
  }

  const rows = rangeFilter
    ? rowsAll.filter(r => r.dt >= rangeFilter.from && r.dt <= rangeFilter.to)
    : rowsAll;

  // ⑦ 요약
  const valid = rows.filter(r => typeof r.PT === "number");
  const maxPT = valid.reduce((a,b)=> (a?.PT ?? -1) >= b.PT ? a : b, null);
  const minPT = valid.reduce((a,b)=> (a?.PT ??  1e9) <= b.PT ? a : b, null);
  const badLevels = new Set(["주의","경고","위험"]);
  let best = null, cur = null;
  for (const r of valid) {
    if (badLevels.has(r.level)) {
      if (!cur) cur = { from:r.dt, to:r.dt, count:1 };
      else      { cur.to = r.dt; cur.count++; }
    } else if (cur) {
      if (!best || cur.count > best.count) best = cur;
      cur = null;
    }
  }
  if (cur && (!best || cur.count > best.count)) best = cur;

  const flags = [];
  if (maxPT && maxPT.PT >= 38) flags.push("고온경보 후보(경고 이상 시간대 존재)");
  if (rows.some(r => (r.PTY ?? 0) > 0)) flags.push("강수 가능성");
  if (rows.some(r => (r.WSD ?? 0) >= 10)) flags.push("강풍 주의(10 m/s↑)");
  if (!flags.length) flags.push("특이사항 없음");

  const hazards = computeHazards(rows);
  const dailyAll = [...dailyMap.values()].sort((a,b)=>a.date.localeCompare(b.date));
  const dateSet = new Set(rows.map(r => r.dt.slice(0,8)));
  const daily = dailyAll.filter(d => dateSet.has(d.date));

  const legacy = includeLegacy ? {
    hours: rows.map(r => ({
      dt: r.dt,
      dtKst: r.dtKst ?? null,
      tmp: r.TMP ?? null,
      reh: r.REH ?? null,
      wsd: r.WSD ?? null,
      pop: r.POP ?? null,
      pcp: r.PCP ?? null,
      sno: r.SNO ?? null,
      pty: r.PTY ?? null,
      sky: r.SKY ?? null,
      pt: r.PT ?? null,
      level: r.level
    }))
  } : null;

  return {
    region,
    grid:{ nx, ny },
    base:{ base_date, base_time },
    hours: rows,
    summary: {
      maxPT: maxPT ? { dt:maxPT.dt, value:maxPT.PT, level:maxPT.level } : null,
      minPT: minPT ? { dt:minPT.dt, value:minPT.PT, level:minPT.level } : null,
      worstWindow: best ? { from:best.from, to:best.to, hours:best.count } : null,
      worstAvg3h: (worstWindowAvgPT(rows, 3) || null)
    },
    daily,
    hazards,
    ...(includeLegacy ? { legacy } : {}),
    flags
  };
}

export default async function handler(req, res) {
  try {
    // 입력 파라미터 통합: region 우선, 없으면 q
    const region = (req.query.region || req.body?.region || req.query.q || "").trim();
    if (!region) return res.status(200).json({ ok:false, error:"region(또는 q) 필요" });
    const range = (getScalar(req.query.range) || "").trim();
    const from = (getScalar(req.query.from) || "").trim();
    const to = (getScalar(req.query.to) || "").trim();
    const rangeFilter = buildRangeFilter({ range, from, to });
    const compat = (getScalar(req.query.compat) || "").toLowerCase();
    const includeLegacy = compat === "legacy" || compat === "rows";

    // ① 선검사(정규화 → 법정→행정 → nx/ny)
    const r = resolveRegion(region);
    console.log("[pt-forecast] region=", region, "resolve=", {
      ok: r.ok, match: r.match, adminKey: r.adminKey, nxny: r.nxny
    });

    // ② 실패시: 외부 API 호출하지 않고 제안만 반환
    if (!r.ok) {
      return res.status(200).json({
        ok: false,
        reason: r.reason,          // 'NOT_FOUND' 등
        suggestions: r.suggestions // 후보 리스트
      });
    }

    // ③ 성공시: nx, ny 확보
    const { nx, ny } = r.nxny;
    const resolvedRegion = r.adminKey || region;

    // 캐시 키 (발표시각 기준)
    const { base_date, base_time } = getVilageBaseDateTime(); // 기존 함수 명에 맞게 사용
    const cacheKey = `${nx},${ny},vilage,${base_date}${base_time}`;
    const latestKey = `${nx},${ny},vilage,latest`;
    const nextRefreshMs = ttlToNextVilageIssue();
    const ttlSec = Math.max(60, Math.floor(nextRefreshMs/1000));
 
    try {
      const cached = await cacheGet(cacheKey);
      if (cached) {
        return res.status(200).json({
          ok: true,
          cache: { hit: true, ageMs: 0, ttl: ttlSec, nextRefreshMs },
          ...shapeForecast(cached, { nx, ny, region: resolvedRegion }, rangeFilter, { includeLegacy })
        });
      }
      const fc = await callVilageWithFallback({ base_date, base_time, nx, ny }); // 기존 호출
      await cacheSet(cacheKey, fc, ttlSec);
      await cacheSet(latestKey, fc, 60*60); // 1시간 폴백
      return res.status(200).json({
        ok: true,
        cache: { hit: false, ageMs: 0, ttl: ttlSec, nextRefreshMs },
        ...shapeForecast(fc, { nx, ny, region: resolvedRegion }, rangeFilter, { includeLegacy })
      });
    } catch (e) {
      const last = await cacheGet(latestKey);
      if (last) {
        return res.status(200).json({
          ok: true,
          stale: true,
          note: "fallback_cache",
          cache: { hit: true, ageMs: 0, ttl: ttlSec, nextRefreshMs },
          ...shapeForecast(last, { nx, ny, region: resolvedRegion }, rangeFilter, { includeLegacy })
        });
      }
      return res.status(200).json({ ok:false, reason:'upstream_error' });
    }
  } catch (err) {
    return res.status(200).json({ ok:false, reason:'internal_error', message: String(err?.message || err) });
  }
}  
