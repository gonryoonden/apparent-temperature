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
    const v = typeof hours[i].pt === "number" ? hours[i].pt : null;
    if (v == null) { sum = 0; count = 0; continue; }
    sum += v; count += 1;

    if (count > win) {
      const old = typeof hours[i - win].pt === "number" ? hours[i - win].pt : null;
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


function shapeForecast(fc, adminKey, {nx, ny}) {
  const { base_date, base_time, items } = fc;

  // ⑤ 시간대별 값 모으기
  const want = new Map(); // key=fcstDate+fcstTime → {TMP, REH, WSD, PTY, SKY}
  for (const it of items) {
    const key = `${it.fcstDate}${it.fcstTime}`;
    if (!want.has(key)) want.set(key, {});
    if (["TMP","REH","WSD","PTY","SKY"].includes(it.category)) {
      want.get(key)[it.category] = Number(it.fcstValue);
    }
  }

  // ⑥ 체감온도/레벨 계산
  const rows = [];
  for (const [key, v] of [...want.entries()].sort((a,b)=>a[0].localeCompare(b[0]))) {
    const Ta=v.TMP, RH=v.REH, WSD=v.WSD, PTY=v.PTY, SKY=v.SKY;
    let pt = null, level = null;
    if (Ta!=null && RH!=null) { pt = perceivedTempKMA(Ta, RH); level = levelByPT(pt); }
    rows.push({ dt:key, tmp:Ta ?? null, reh:RH ?? null, wsd:WSD ?? null, pty:PTY ?? null, sky:SKY ?? null, pt, level });
  }

  // ⑦ 요약
  const valid = rows.filter(r => typeof r.pt === "number");
  const maxPT = valid.reduce((a,b)=> (a?.pt ?? -1) >= b.pt ? a : b, null);
  const minPT = valid.reduce((a,b)=> (a?.pt ??  1e9) <= b.pt ? a : b, null);
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
  if (maxPT && maxPT.pt >= 38) flags.push("고온경보 후보(경고 이상 시간대 존재)");
  if (rows.some(r => (r.pty ?? 0) > 0)) flags.push("강수 가능성");
  if (rows.some(r => (r.wsd ?? 0) >= 10)) flags.push("강풍 주의(10 m/s↑)");
  if (!flags.length) flags.push("특이사항 없음");

  // ⑧ 응답region-resolver.js가 CommonJS(module.exports)라서 default import로 받아옵니다.
  return {
    input: fc.input, // Assuming fc has an input property
    adminKey: adminKey,
    grid:{ nx, ny },
    base:{ base_date, base_time },
    hours: rows,
    summary: {
      maxPT: maxPT ? { dt:maxPT.dt, value:maxPT.pt, level:maxPT.level } : null,
      minPT: minPT ? { dt:minPT.dt, value:minPT.pt, level:minPT.level } : null,
      worstWindow: best ? { from:best.from, to:best.to, hours:best.count } : null,
      worstAvg3h: (worstWindowAvgPT(rows, 3) || null)    
    },
    flags
  };
}

export default async function handler(req, res) {
  try {
    // 입력 파라미터 통합: region 우선, 없으면 q
    const region = (req.query.region || req.body?.region || req.query.q || "").trim();
    if (!region) return res.status(200).json({ ok:false, error:"region(또는 q) 필요" });

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

    // 캐시 키 (발표시각 기준)
    const { base_date, base_time } = getVilageBaseDateTime(); // 기존 함수 명에 맞게 사용
    const cacheKey = `${nx},${ny},vilage,${base_date}${base_time}`;
    const latestKey = `${nx},${ny},vilage,latest`;
    const ttlSec = Math.max(60, Math.floor(ttlToNextVilageIssue()/1000));
 
    try {
      const cached = await cacheGet(cacheKey);
      if (cached) {
        return res.status(200).json({ ok:true, cache:{hit:true}, ...shapeForecast(cached, r.adminKey, {nx,ny}) });
      }
      const fc = await callVilageWithFallback({ base_date, base_time, nx, ny }); // 기존 호출
      await cacheSet(cacheKey, fc, ttlSec);
      await cacheSet(latestKey, fc, 60*60); // 1시간 폴백
      return res.status(200).json({ ok:true, cache:{hit:false, ttl:ttlSec}, ...shapeForecast(fc, r.adminKey, {nx,ny}) });
    } catch (e) {
      const last = await cacheGet(latestKey);
      if (last) {
        return res.status(200).json({ ok:true, stale:true, note:'fallback_cache', ...shapeForecast(last, r.adminKey, {nx,ny}) });
      }
      return res.status(200).json({ ok:false, reason:'upstream_error' });
    }
  } catch (err) {
    return res.status(200).json({ ok:false, reason:'internal_error', message: String(err?.message || err) });
  }
}  