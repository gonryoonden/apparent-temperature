import { callVilageWithFallback } from "../lib/kmaForecast.js";
import { findNxNy, perceivedTempKMA, levelByPT } from "../lib/ptCore.js";



export default async function handler(req, res) {
  try {
    const region = (req.query.region || "").trim();
    if (!region) return res.status(400).json({ ok:false, error:"region 필요" });

    // 1) region→(nx,ny) (기존 findNxNy 재사용)
    const { coords } = findNxNy(region);
    if (!coords) return res.status(404).json({ ok:false, error:`지역 매칭 실패: ${region}` });
    const { nx, ny } = coords;

    const { base_date, base_time, items } = await callVilageWithFallback({ nx, ny, tries: 2 });

    const want = new Map(); // key=fcstDate+fcstTime → {TMP, REH, WSD}
    for (const it of items) {
      const key = `${it.fcstDate}${it.fcstTime}`;
      if (!want.has(key)) want.set(key, {});
      if (["TMP","REH","WSD","PTY","SKY"].includes(it.category)) {
        want.get(key)[it.category] = Number(it.fcstValue);
      }
    }
    // 4) 시간대별 PT 계산
    // 정렬 + 결측 허용(PT는 TMP/REH 둘 다 있을 때만 계산)
    const rows = [];
    for (const [key, v] of [...want.entries()].sort((a,b)=>a[0].localeCompare(b[0]))) {
      const Ta=v.TMP, RH=v.REH, WSD=v.WSD, PTY=v.PTY, SKY=v.SKY;
      let pt = null, level = null;
      if (Ta!=null && RH!=null) {
        pt = perceivedTempKMA(Ta, RH);
        level = levelByPT(pt);
      }
      rows.push({ dt:key, tmp:Ta ?? null, reh:RH ?? null, wsd:WSD ?? null, pty:PTY ?? null, sky:SKY ?? null, pt, level });
    }

    // 요약/플래그 도출
    const valid = rows.filter(r => typeof r.pt === "number");
    const maxPT = valid.reduce((a,b)=> (a?.pt ?? -1) >= b.pt ? a : b, null);
    const minPT = valid.reduce((a,b)=> (a?.pt ??  1e9) <= b.pt ? a : b, null);
    // 최악 구간: level이 '주의/경고/위험'인 연속 구간 중 가장 긴 것
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

    // 간단 경보 플래그
    const flags = [];
    if (maxPT && maxPT.pt >= 38) flags.push("고온경보 후보(경고 이상 시간대 존재)");
    if (rows.some(r => (r.pty ?? 0) > 0)) flags.push("강수 가능성");
    if (rows.some(r => (r.wsd ?? 0) >= 10)) flags.push("강풍 주의(10 m/s↑)");
    if (!flags.length) flags.push("특이사항 없음");

    return res.json({
      ok:true,
      region,
      grid:{ nx, ny },
      base:{ base_date, base_time },
      hours: rows,
      summary: {
        maxPT: maxPT ? { dt:maxPT.dt, value:maxPT.pt, level:maxPT.level } : null,
        minPT: minPT ? { dt:minPT.dt, value:minPT.pt, level:minPT.level } : null,
        worstWindow: best ? { from:best.from, to:best.to, hours:best.count } : null
      },
      flags
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
}
