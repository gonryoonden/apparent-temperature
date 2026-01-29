// lib/livingIndex.js
import { fetchWithRetry } from "./http.js";
import { normalizeServiceKey } from "./kmaKey.js";

const PROTO = (process.env.KMA_SCHEME || "http").trim();
const BASE_URL = `${PROTO}://apis.data.go.kr/1360000/LivingWthrIdxServiceV4`;
const SEN_TA_URL = `${BASE_URL}/getSenTaIdxV4`;

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const pad2 = (n) => String(n).padStart(2, "0");

function toKstDate(d = new Date()) {
  return new Date(d.getTime() + KST_OFFSET_MS);
}

function kstHourString(d = new Date()) {
  const kst = toKstDate(d);
  return `${kst.getUTCFullYear()}${pad2(kst.getUTCMonth() + 1)}${pad2(kst.getUTCDate())}${pad2(kst.getUTCHours())}`;
}

function kstHourToMs(dt) {
  if (!dt || dt.length < 10) return null;
  const yyyy = Number(dt.slice(0, 4));
  const mm = Number(dt.slice(4, 6));
  const dd = Number(dt.slice(6, 8));
  const hh = Number(dt.slice(8, 10));
  return Date.UTC(yyyy, mm - 1, dd, hh - 9);
}

function msToKstDt(ms) {
  const kst = new Date(ms + KST_OFFSET_MS);
  return `${kst.getUTCFullYear()}${pad2(kst.getUTCMonth() + 1)}${pad2(kst.getUTCDate())}${pad2(kst.getUTCHours())}${pad2(kst.getUTCMinutes())}`;
}

export function toKstIsoFromMs(ms) {
  const kst = new Date(ms + KST_OFFSET_MS);
  const yyyy = kst.getUTCFullYear();
  const mm = pad2(kst.getUTCMonth() + 1);
  const dd = pad2(kst.getUTCDate());
  const hh = pad2(kst.getUTCHours());
  const mi = pad2(kst.getUTCMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}+09:00`;
}

export async function fetchSenTa({ areaNo, time, requestCode = "A41", numOfRows = 10, pageNo = 1, dataType = "JSON" }) {
  const rawKey = normalizeServiceKey(process.env.KMA_SERVICE_KEY || "");
  const q = new URLSearchParams({
    serviceKey: rawKey,
    numOfRows: String(numOfRows),
    pageNo: String(pageNo),
    dataType,
    areaNo: String(areaNo),
    time: String(time),
    requestCode: String(requestCode),
  });
  const url = `${SEN_TA_URL}?${q.toString()}`;
  const res = await fetchWithRetry(url, { timeoutMs: 3500, retries: 1 });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`LivingIdx JSON parse fail: ${text.slice(0, 200)}`); }
  const code = String(json?.response?.header?.resultCode ?? "");
  const msg = String(json?.response?.header?.resultMsg ?? "");
  const items = json?.response?.body?.items?.item || [];
  return { ok: code === "00" || code === "0", code, msg, items, raw: json };
}

export async function fetchSenTaWithFallback({ areaNo, requestCode = "A41", now = new Date(), backHours = 6 }) {
  const base = kstHourString(now);
  for (let i = 0; i <= backHours; i++) {
    const t = addHours(base, -i);
    const out = await fetchSenTa({ areaNo, time: t, requestCode });
    if (out.ok) return { ...out, baseTime: t };
    if (/제공기간|5월|9월/.test(out.msg)) {
      return { ...out, baseTime: t, reason: "OUT_OF_SEASON" };
    }
    if (i === backHours) {
      return { ...out, baseTime: t, reason: "NO_DATA" };
    }
  }
  return { ok: false, code: "99", msg: "NO_DATA", items: [], raw: null, reason: "NO_DATA" };
}

export function buildSenTaSeries(item, baseTime) {
  const base = String(item?.date || item?.time || baseTime || "");
  const baseMs = kstHourToMs(base);
  if (!baseMs) return [];
  const out = [];
  for (const [k, v] of Object.entries(item || {})) {
    if (!/^h\d+$/i.test(k)) continue;
    const offset = Number(k.slice(1));
    if (!Number.isFinite(offset)) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    const dtMs = baseMs + offset * 60 * 60 * 1000;
    out.push({ dt: msToKstDt(dtMs), dtMs, value: n, offset });
  }
  out.sort((a, b) => a.dtMs - b.dtMs);
  return out;
}

export function pickNearestFuture(series, now = new Date()) {
  if (!series?.length) return null;
  const nowMs = now.getTime();
  const future = series.find(s => s.dtMs >= nowMs);
  return future || series[series.length - 1];
}

function addHours(dt, delta) {
  const ms = kstHourToMs(dt);
  if (!ms) return dt;
  return msToKstDt(ms + delta * 60 * 60 * 1000).slice(0, 10);
}

export function isSummerSeason(date = new Date()) {
  const kst = toKstDate(date);
  const m = kst.getUTCMonth() + 1;
  return m >= 5 && m <= 9;
}
