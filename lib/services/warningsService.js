import { fetchWithRetry } from "../http.js";
import { normalizeServiceKey } from "../kmaKey.js";
import { cacheGet, cacheSet } from "../cache.js";
import { ttlToNext10m } from "../kma-ttl.js";
import { normalizeWarnings, summarizeWarnings } from "./warningsNormalize.js";

const PROTO = (process.env.KMA_SCHEME || "http").trim();
const BASE_URL = `${PROTO}://apis.data.go.kr/1360000/WthrWrnInfoService`;

function toArray(items) {
  if (!items) return [];
  return Array.isArray(items) ? items : [items];
}

async function callWthr(endpoint, params = {}) {
  const svcKey = normalizeServiceKey(process.env.KMA_SERVICE_KEY || "");
  const q = new URLSearchParams({
    dataType: "JSON",
    numOfRows: String(params.numOfRows ?? 50),
    pageNo: String(params.pageNo ?? 1),
  });
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (["numOfRows", "pageNo"].includes(k)) continue;
    q.set(k, String(v));
  }
  const url = `${BASE_URL}/${endpoint}?serviceKey=${svcKey}&${q.toString()}`;
  const res = await fetchWithRetry(url, { timeoutMs: 3500, retries: 1 });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`WthrWrn JSON parse fail: ${text.slice(0, 200)}`);
  }
  const code = String(json?.response?.header?.resultCode ?? "");
  const msg = String(json?.response?.header?.resultMsg ?? "");
  if (code !== "00" && code !== "0" && code !== "03") {
    const e = new Error(`WthrWrn API Error: ${code} - ${msg}`);
    e.name = "KmaApiError";
    e.code = code;
    throw e;
  }
  const items = json?.response?.body?.items?.item || [];
  return { raw: json, items: toArray(items), code, msg, noData: code === "03" };
}

export async function fetchWthrWrnList({
  stnId,
  areaCode,
  fromTmFc,
  toTmFc,
  warningType,
  numOfRows,
  pageNo,
}) {
  return callWthr("getWthrWrnList", {
    stnId,
    areaCode,
    fromTmFc,
    toTmFc,
    warningType,
    numOfRows,
    pageNo,
  });
}

export async function fetchWthrWrnMsg({ stnId, tmSeq, tmFc, numOfRows, pageNo }) {
  return callWthr("getWthrWrnMsg", {
    stnId,
    tmSeq,
    tmFc,
    numOfRows,
    pageNo,
  });
}

export async function getWarningsNormalized({
  stnId,
  areaCode,
  from,
  to,
  warningType,
  detail = false,
}) {
  const cacheKey = `warnings:${stnId || ""}:${from || ""}:${to || ""}:${warningType || ""}:${detail ? "1" : "0"}`;
  const nextRefreshMs = ttlToNext10m();
  const ttlSec = Math.max(60, Math.floor(nextRefreshMs / 1000));

  const cached = await cacheGet(cacheKey);
  if (cached) {
    return { ...cached, cache: { hit: true, ageMs: 0, ttl: ttlSec, nextRefreshMs } };
  }

  const list = await fetchWthrWrnList({
    stnId,
    areaCode,
    fromTmFc: from,
    toTmFc: to,
    warningType,
    numOfRows: 100,
    pageNo: 1,
  });

  const detailMap = new Map();
  if (detail) {
    const tasks = list.items
      .filter((it) => it?.tmSeq && it?.tmFc)
      .map(async (it) => {
        try {
          const msg = await fetchWthrWrnMsg({
            stnId: it.stnId || stnId,
            tmSeq: it.tmSeq,
            tmFc: it.tmFc,
          });
          const key = `${it.tmSeq}|${it.tmFc}`;
          detailMap.set(key, msg.items[0] || null);
        } catch {
          /* ignore per-item */
        }
      });
    await Promise.all(tasks);
  }

  const items = normalizeWarnings(list.items, detailMap);
  const summary = summarizeWarnings(items);
  const payload = { items, summary };
  await cacheSet(cacheKey, payload, ttlSec);
  return { ...payload, cache: { hit: false, ageMs: 0, ttl: ttlSec, nextRefreshMs } };
}
