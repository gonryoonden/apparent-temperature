// api/pt-forecast.js
import { callVilageWithFallback } from "../lib/kmaForecast.js";
import { perceivedTempKMA, levelByPT } from "../lib/ptCore.js";
// region-resolver.js가 CommonJS(module.exports)라서 default import로 받아옵니다.

if (!resolveRegion) throw new Error("resolveRegion not found in region-resolver.js");
import { resolveRegion } from "../lib/region-resolver.js";
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

    // ④ 기상청 호출
    const { base_date, base_time, items } = await callVilageWithFallback({ nx, ny, tries: 2 });

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

    // ⑧ 응답
    return res.json({
      ok:true,
      input: region,
      adminKey: r.adminKey || r.legalKey || null,
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
    console.error(e);
    return res.status(200).json({ ok:false, reason:'internal_error' });
  }
}
