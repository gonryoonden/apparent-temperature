import { fetchWithRetry } from './http.js';
import { normalizeServiceKey } from './kmaKey.js';

const PROTO = (process.env.KMA_SCHEME || "http").trim(); // corp 환경/가이드 호환
const KMA_VILAGE_URL = `${PROTO}://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst`;

const toKST = (d = new Date()) => new Date(d.getTime() + 9 * 60 * 60 * 1000);
const pad2 = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
const BASE_HOURS = [2, 5, 8, 11, 14, 17, 20, 23];
const MISSING_THRESHOLD = 900; // KMA guide: values >=900 or <=-900 are missing.

const isMissingValue = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && (n >= MISSING_THRESHOLD || n <= -MISSING_THRESHOLD);
};

const hasValidValue = (value) =>
  value !== null && value !== undefined && value !== "" && !isMissingValue(value);

export function getVilageBaseDateTimeKST(nowUTC = new Date()) {
  const k = toKST(nowUTC);
  let h = k.getUTCHours();
  // 제공은 각 정시+10분 이후 → 10분 전이면 직전시로 내림
  if (k.getUTCMinutes() < 10) h -= 1;

  let bt = [...BASE_HOURS].reverse().find((x) => x <= h);
  if (bt === undefined) {
    // 새벽 0~1시는 전일 23시를 사용
    const prev = new Date(k.getTime() - 24 * 60 * 60 * 1000);
    return { base_date: ymd(prev), base_time: "2300" };
  }
  return { base_date: ymd(k), base_time: `${pad2(bt)}00` };
}

 // 직전 발표시각 계산
 export function getPrevBaseDateTime({ base_date, base_time }) {
   const hh = parseInt(base_time.slice(0,2), 10);
   const idx = BASE_HOURS.indexOf(hh);
   if (idx > 0) {
     return { base_date, base_time: `${pad2(BASE_HOURS[idx-1])}00` };
   }
   // 02보다 이전이면 전일 23시
   const y = base_date.slice(0,4), m=base_date.slice(4,6), d=base_date.slice(6,8);
   const cur = new Date(Date.UTC(+y, +m-1, +d));
   const prev = new Date(cur.getTime() - 24*60*60*1000);
   const pd = ymd(prev);
   return { base_date: pd, base_time: "2300" };
 }


export async function callVilageFcst({ base_date, base_time, nx, ny }) {
  const svcKey = normalizeServiceKey(process.env.KMA_SERVICE_KEY || "");
  const url =
    `${KMA_VILAGE_URL}?serviceKey=${svcKey}` +
    `&dataType=JSON&numOfRows=1000&pageNo=1&base_date=${base_date}&base_time=${base_time}` +
    `&nx=${nx}&ny=${ny}`;

  const res = await fetchWithRetry(url, { headers: { accept: "application/json" }, timeoutMs: 3500, retries: 1 });
  if (!res.ok) throw new Error(`KMA HTTP ${res.status}`);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`KMA JSON parse fail: ${text.slice(0,200)}`); }

  const code = json?.response?.header?.resultCode;
  const msg  = json?.response?.header?.resultMsg;
  if (code !== "00") { const e = new Error(`KMA API Error: ${code} - ${msg}`); e.name="KmaApiError"; e.code=code; throw e; }

  return json?.response?.body?.items?.item || [];
}

 // 현재 발표시각으로 받아보고, PT 산출 가능한 시점이 부족하면 직전 발표시각으로 1~2회까지 자동 재시도
 export async function callVilageWithFallback({ nx, ny, tries = 2 }) {
   let { base_date, base_time } = getVilageBaseDateTimeKST();
   for (let i = 0; i < tries; i++) {
     const items = await callVilageFcst({ base_date, base_time, nx, ny });
     // TMP/REH가 모두 있는 시점 수를 빠르게 스코어링
     const map = new Map();
     for (const it of items) {
       const key = `${it.fcstDate}${it.fcstTime}`;
       if (!map.has(key)) map.set(key, {});
       map.get(key)[it.category] = it.fcstValue;
     }
     const rows = [...map.values()].filter(v => hasValidValue(v.TMP) && hasValidValue(v.REH)).length;
     if (rows >= 12 || i === tries - 1) {
       return { base_date, base_time, items };
     }
     // 부족하면 직전 발표시각으로 이동
     ({ base_date, base_time } = getPrevBaseDateTime({ base_date, base_time }));
   }
 }
