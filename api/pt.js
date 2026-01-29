/**
 * /api/pt.js
 * 체감온도(여름, ) + 초단기실황(getUltraSrtNcst) 기반 실시간 안전경보 API
 *
 * 포함 기능
 * 1) 데이터 소스 전환: getVilageFcst(3시간) → getUltraSrtNcst(1시간, 실황)
 * 2) REFRESH_INTERVAL 상수화(가이드 기준 1시간 주기)
 * 3) 법정 조치문 자동 안내(action) 포함 (31℃ 폭염작업 기준 강조)
 * 4) 조회 기록 로깅(비동기 JSON Lines) - 서버리스 쓰기 보장 경로(/tmp) 우선
 * 5) 10분 in-memory 캐시 (서버리스 다중 인스턴스 한계 주석)
 * 6) KMA OpenAPI header.resultCode 검증(00 정상 외 에러 throw)
 * 7) 지역명 매칭: 완전→부분→단어조합→접미(endsWith) 4단계 (약칭 '역삼동' 복원)
 * 8) 쿼리 파라미터 검증(배열/NaN 방지)
 * 9) 하위호환 스키마 옵션: ?compat=rows → legacy 구조 병행 반환
 * 10) 계산식 메타 표식(metrics.ptFormula/ptEpsilon), debug 모드(?debug=true)
 *
 * 필요 환경변수:
 * - KMA_SERVICE_KEY : 공공데이터포털 기상청 단기예보/초단기 API 서비스키
 * 선택 환경변수:
 * - LOG_DIR         : 로그 디렉터리(기본 /tmp/logs)
 */

import { fetchWithRetry } from "../lib/http.js";
import { cacheGet, cacheSet } from "../lib/cache.js";
import { ttlToNext10m } from "../lib/kma-ttl.js";
import { resolveRegion } from "../lib/region-resolver.js";
import { fetchSenTaWithFallback, buildSenTaSeries, pickNearestFuture, toKstIsoFromMs, isSummerSeason } from "../lib/livingIndex.js";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { readFileSync } from "fs";
import { normalizeServiceKey } from "../lib/kmaKey.js";
const nxnyDB = JSON.parse(
  readFileSync(new URL("../lib/nxny_map.json", import.meta.url), "utf-8")
);
let livingAreaMap = { byAdminKey: {}, byNxNy: {} };
try {
  livingAreaMap = JSON.parse(
    readFileSync(new URL("../lib/living_area_map.json", import.meta.url), "utf-8")
  );
} catch { /* optional */ }

// ───────────────────────────────────────────────────────────────────────────────
// 상수 및 운영 파라미터
// ───────────────────────────────────────────────────────────────────────────────

// 초단기실황(실황) 엔드포인트: 정시 생성, 매시 10분 이후 제공
const PROTO = (process.env.KMA_SCHEME || "http").trim();
const KMA_ULTRA_NCST_URL = `${PROTO}://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst`;

// 가이드 기준 1시간 주기(실황). 메타정보로 응답에 노출만 함.
export const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

// 로그 저장 경로: 서버리스 쓰기 보장 디렉터리 우선(/tmp), 없으면 cwd/logs
const LOG_DIR = process.env.LOG_DIR || "/tmp/logs";
const LOG_FILE = path.join(LOG_DIR, "pt_log.jsonl");
const PT_DEF_LIVING = "SEN_TA";
const PT_DEF_WIND = "WCET_2001";
const PT_DEF_AIR = "AIR_TEMP_ONLY";
const PT_SOURCE_LIVING = "LIVING_IDX";
const PT_SOURCE_WIND = "WIND_CHILL";
const PT_SOURCE_FALLBACK = "FALLBACK";
const LIVING_REQUEST_CODE = "A41";

// 계산식 메타(하위호환 검증 및 가시화)

// ───────────────────────────────────────────────────────────────────────────────
/** 시간 유틸 (KST, base_date/base_time 계산: 분<10 이면 직전시) */
// ───────────────────────────────────────────────────────────────────────────────
const toKST = (d = new Date()) => new Date(d.getTime() + 9 * 60 * 60 * 1000);
const pad2 = (n) => String(n).padStart(2, "0");
const yyyymmdd = (d) =>
  `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;

function getUltraBaseDateTime(nowUTC = new Date()) {
  const kst = toKST(nowUTC);
  if (kst.getUTCMinutes() < 10) kst.setUTCHours(kst.getUTCHours() - 1);
  kst.setUTCMinutes(0, 0, 0);
  return { base_date: yyyymmdd(kst), base_time: `${pad2(kst.getUTCHours())}00` };
}

function toKstIsoFromBase(base_date, base_time) {
  if (!base_date || !base_time) return null;
  const yyyy = base_date.slice(0, 4);
  const mm = base_date.slice(4, 6);
  const dd = base_date.slice(6, 8);
  const hh = base_time.slice(0, 2);
  const mi = base_time.slice(2, 4);
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}+09:00`;
}

// ───────────────────────────────────────────────────────────────────────────────
/** 지역명 매칭(findNxNy): 완전→부분→단어조합→접미(endsWith) 4단계 + 숫자 없는 동 정규화 */
// ───────────────────────────────────────────────────────────────────────────────
const normalize = (s) => s.replace(/\s+/g, "").toLowerCase();

// 숫자 없는 동/가/리 이름을 정규화 (예: 역삼동 → 역삼1동/역삼2동 후보)
function normalizeAdminDivision(input) {
  // 끝이 '동', '가', '리'로 끝나고 숫자가 없는 경우
  if (/[동가리]$/.test(input) && !/\d/.test(input)) {
    // 숫자를 추가한 버전들을 생성 (1동~9동 등)
    const base = input.substring(0, input.length - 1);
    const suffix = input[input.length - 1];
    const candidates = [];
    for (let i = 1; i <= 9; i++) {
      candidates.push(base + i + suffix);
    }
    return candidates;
  }
  return [input];
}

// 근접 후보 찾기 (편집거리 기반)
function findClosestMatches(input, keys, limit = 3) {
  const q = normalize(input);
  const scored = keys.map(k => {
    const nk = normalize(k);
    let score = 0;
    
    // 부분 매치 점수
    if (nk.includes(q)) score += 10;
    if (nk.endsWith(q)) score += 5;
    
    // 공통 토큰 점수
    const inputTokens = input.split(/[\s·]/g).filter(Boolean);
    const keyTokens = k.split(/[\s·]/g).filter(Boolean);
    const commonTokens = inputTokens.filter(t => 
      keyTokens.some(kt => normalize(kt).includes(normalize(t)))
    );
    score += commonTokens.length * 3;
    
    // 길이 차이 페널티
    score -= Math.abs(nk.length - q.length) * 0.5;
    
    return { key: k, score };
  });
  
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).filter(s => s.score > 0).map(s => s.key);
}

function findNxNy(input) {
  if (!input || typeof input !== "string") return { coords: null, suggestions: [] };
  const q = normalize(input);
  const keys = Object.keys(nxnyDB);
  const keysByLenDesc = keys.slice().sort((a, b) => b.length - a.length);

  // 1) 완전일치
  for (const k of keys) if (normalize(k) === q) return { coords: nxnyDB[k], suggestions: [] };

  // 2) 숫자 없는 동 정규화 시도 (역삼동 → 역삼1동, 역삼2동 등)
  const normalizedCandidates = normalizeAdminDivision(input);
  for (const candidate of normalizedCandidates) {
    const nCandidate = normalize(candidate);
    for (const k of keys) {
      if (normalize(k) === nCandidate || normalize(k).endsWith(nCandidate)) {
        return { coords: nxnyDB[k], suggestions: [] };
      }
    }
  }

  // 3) 부분일치 (가장 긴 키 우선)
  for (const k of keysByLenDesc) if (normalize(k).includes(q)) return { coords: nxnyDB[k], suggestions: [] };

  // 4) 단어조합(모든 토큰 포함)
  const tokens = input.split(/\s+/).filter(Boolean).map(normalize);
  for (const k of keysByLenDesc) {
    const nk = normalize(k);
    if (tokens.every((t) => nk.includes(t))) return { coords: nxnyDB[k], suggestions: [] };
  }

  // 5) 접미(약칭) 매칭 복원: "역삼동" → "서울특별시 강남구 역삼동"
  const tailHits = keysByLenDesc.filter((k) => normalize(k).endsWith(q));
  if (tailHits.length) {
    // 후보가 다수면 더 일반적인(짧은) 명칭 우선
    tailHits.sort((a, b) => a.length - b.length);
    return { coords: nxnyDB[tailHits[0]], suggestions: [] };
  }

  // 매칭 실패 시 근접 후보 제안
  const suggestions = findClosestMatches(input, keys, 5);
  return { coords: null, suggestions };
}

// ───────────────────────────────────────────────────────────────────────────────
/** 체감온도 계산(, 여름) + 등급/조치 */
// ───────────────────────────────────────────────────────────────────────────────

function windChillC(Ta, vMs) {
  if (!Number.isFinite(Ta)) return null;
  const v = Number(vMs);
  if (Number.isFinite(v) && Ta <= 10 && v >= 1.3) {
    const vKmh = v * 3.6;
    const pow = Math.pow(vKmh, 0.16);
    const wct = 13.12 + 0.6215 * Ta - 11.37 * pow + 0.3965 * Ta * pow;
    return Math.round(wct * 10) / 10;
  }
  return Ta;
}


const LEGAL_MIN_PT = 31; // 폭염작업 법적 기준(체감온도 31℃ 이상)

function actionByLevel(level, pt) {
  const msg = {
    정상:
      "정상: 물·그늘·휴식 준비상태 유지, 열질환자 교육/증상 모니터링을 지속하세요.",
    관심:
      "관심(≥32℃): 작업 전 점검 강화, 1시간당 10분 이상 휴식 권고, 수분·염분 보충을 강화하세요.",
    주의:
      "주의(≥35℃): 2시간마다 20분 이상 휴식, 중노동 축소·교대작업, 취약 근로자 보호조치를 시행하세요.",
    경고:
      "경고(≥38℃): 1시간 기준 15~20분 이상 휴식, 작업강도 대폭 축소·순환작업, 응급대응 준비를 유지하세요.",
    위험:
      "위험(≥40℃): 즉시 작업중지 및 대피, 응급조치 체계를 가동하고 재개 여부를 관리자 회의로 결정하세요.",
  };
  const base = msg[level] || msg.정상;
  return pt >= LEGAL_MIN_PT
    ? `${base} (법정기준 도달: 체감온도 ${LEGAL_MIN_PT}℃ 이상 → 보호조치 의무 이행 필요)`
    : base;
}

// ───────────────────────────────────────────────────────────────────────────────
/** 기상청 초단기실황 호출(T1H/REH/WSD) + resultCode 검증 */
// ───────────────────────────────────────────────────────────────────────────────
async function fetchUltraNcst({ nx, ny }) {
  const { base_date, base_time } = getUltraBaseDateTime();
  const rawKey = normalizeServiceKey(process.env.KMA_SERVICE_KEY || "");
  const q = new URLSearchParams({
    dataType: "JSON", numOfRows: "100", pageNo: "1",
    base_date, base_time, nx: String(nx), ny: String(ny),
  });
  const url = `${KMA_ULTRA_NCST_URL}?serviceKey=${rawKey}&${q.toString()}`;
  const res = await fetchWithRetry(url, { timeoutMs: 3500, retries: 1 });
  const text = await res.text();
  let json; try { json = JSON.parse(text); }
  catch { throw new Error(`KMA JSON parse fail: ${text.slice(0,200)}`); }
  const code = String(json?.response?.header?.resultCode ?? "");
  const msg  = json?.response?.header?.resultMsg;
  if (code !== "00" && code !== "0") {
    const e = new Error(`KMA API Error: ${code} - ${msg}`); e.name="KmaApiError"; e.code=code; throw e;
  }
  const items = json?.response?.body?.items?.item || [];
  const pick = (cat) => {
    const it = items.find(x => x.category === cat);
    return it ? kmaNumberOrNull(it.obsrValue) : null;
  };
  return {
    base_date, base_time,
    temperature: pick("T1H"),
    humidity:    pick("REH"),
    windSpeed:   pick("WSD"),
    _raw: json
  };
}

// ───────────────────────────────────────────────────────────────────────────────
/** 로깅(JSONL): 비동기/구조화. 서버리스는 /tmp 사용 권장 */
// ───────────────────────────────────────────────────────────────────────────────
async function writeLogLine(obj) {
  if (!fs.existsSync(LOG_DIR)) await fsp.mkdir(LOG_DIR, { recursive: true });
  const line = JSON.stringify(obj) + "\n";
  await fsp.appendFile(LOG_FILE, line, "utf-8");
  // eslint-disable-next-line no-console
  console.log("[PT_LOG]", line.trim());
}

// ───────────────────────────────────────────────────────────────────────────────
/** 쿼리 파라미터 안전 파싱 */
// ───────────────────────────────────────────────────────────────────────────────
function getScalar(q) {
  if (Array.isArray(q)) return null; // 배열 입력 거부
  if (q === undefined || q === null) return null;
  return String(q);
}
// 개선: 실제 boolean( true / false )도 허용
function parseBool(s) {
  if (typeof s === "boolean") return s;
  return typeof s === "string" && s.toLowerCase() === "true";
}
function parseNumberOrNull(s) {
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const MISSING_THRESHOLD = 900; // KMA guide: values >=900 or <=-900 are missing.
function kmaNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n >= MISSING_THRESHOLD || n <= -MISSING_THRESHOLD) return null;
  return n;
}

function format(data, regionRaw, nx, ny, debug, compat, phrase, threshold, cacheMeta) {
  const { temperature, humidity, windSpeed } = data;
  const now = new Date();
  const isSummer = isSummerSeason(now);

  let apparent = null;
  let level = null;
  let action = null;
  let ptSource = isSummer ? PT_SOURCE_FALLBACK : PT_SOURCE_WIND;
  let ptDefinition = isSummer ? PT_DEF_AIR : PT_DEF_WIND;
  let ptAtKst = null;

  if (!isSummer) {
    apparent = windChillC(temperature, windSpeed);
  }

  const ptLabel = ptSource === PT_SOURCE_FALLBACK && apparent == null
    ? "체감온도 데이터 없음(기온 참고)"
    : null;
  const ptFormula = ptDefinition;
  const ptEpsilon = null;

  const legalThresholdMet =
    ptSource === PT_SOURCE_LIVING && apparent != null ? apparent >= LEGAL_MIN_PT : null;
  const thresholdExceeded =
    threshold != null && apparent != null ? apparent >= threshold : null;

  const nowISO = new Date().toISOString();
  const nextRefreshMs = ttlToNext10m();
  const ttlSec = Math.max(60, Math.floor(nextRefreshMs / 1000));
  const cacheInfo = {
    hit: cacheMeta?.hit ?? true,
    ageMs: cacheMeta?.ageMs ?? 0,
    ttl: cacheMeta?.ttl ?? ttlSec,
    nextRefreshMs: cacheMeta?.nextRefreshMs ?? nextRefreshMs,
  };
  const observedAtKst = toKstIsoFromBase(data.base_date, data.base_time);
  ptAtKst = observedAtKst;
  const hazards = {
    windRisk: typeof windSpeed === "number" ? windSpeed >= 10 : null,
    snowRisk: null,
    slipFreezeRisk: null,
  };
  const payload = {
    ok: true,
    ...(data.stale && { stale: true, note: data.note }),
    region: regionRaw,
    grid: { nx, ny },
    observed: debug
      ? { ...data, raw: data._raw }
      : {
          base_date: data.base_date, base_time: data.base_time,
          temperature: data.temperature, humidity: data.humidity, windSpeed: data.windSpeed
        },
    observedAtKst,
    metrics: {
      apparentTemperature: apparent,
      level,
      ptFormula,
      ptEpsilon,
      ptSource,
      ptDefinition,
      ptAtKst,
      ...(ptLabel ? { ptLabel } : {}),
    },
    actions: {
      legalMinPT: LEGAL_MIN_PT,
      legalThresholdMet,
      suggestedAction: action,
      customThreshold: threshold,
      customThresholdExceeded: thresholdExceeded,
    },
    hazards,
    cache: cacheInfo,
    system: {
      refreshIntervalMs: 3600000,
      cache: {
        ...cacheInfo,
        nextRefreshMs: nextRefreshMs,
        note: "?전?바?부 10분 ?바?부?? 반?환 TTL(동?자). 서?버리?스 ?행?지?선 ?인스?턴?스버? 캐시?가 ?번?지 ?않?을 ?수 ?있?습?니?다."
      },
      logFile: LOG_FILE,
      ts: nowISO,
    },
  };

  if (compat === "rows") {
    payload.legacy = {
      place: regionRaw,
      date: data.base_date,
      nx, ny,
      base_date: data.base_date,
      base_time: data.base_time,
      rows: apparent != null ? [{
        hour: data.base_time,
        Ta: temperature, RH: humidity, PT: apparent, level, action,
      }] : [],
    };
  }

  if (debug) {
    payload.debug = {
      kmaMeta: { base_date: data.base_date, base_time: data.base_time, nx, ny },
    };
  }

  if (phrase) {
    if (apparent != null) {
      const levelPart = level ? `(${level})` : "";
      const actionPart = action ? ` ${action}` : "";
      payload.phrase = `현재 ${regionRaw}의 기온 ${temperature}?, 습도 ${humidity}%, 체감 ${apparent}?${levelPart}.${actionPart}`.trim();
    } else {
      const label = ptLabel ? ` ${ptLabel}` : "";
      payload.phrase = `현재 ${regionRaw}의 실황 자료가 부족해 체감온도를 산출하지 못했습니다.${label}`.trim();
    }
  }
  return payload;
}


// ───────────────────────────────────────────────────────────────────────────────
/** API 핸들러 */
// ───────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  let latestKey, regionRaw, nx, ny, areaNo, debug, compat, phrase, threshold;
  try {
    regionRaw = (getScalar(req.query.region) || "").trim();
    if (!regionRaw.length) {
      return res.status(200).json({ ok: false, error: "region 쿼리가 비어 있습니다." });
    }
    threshold = parseNumberOrNull(getScalar(req.query.threshold));
    phrase = parseBool(getScalar(req.query.phrase) || "false");
    compat = (getScalar(req.query.compat) || "").toLowerCase(); // "rows" 지원
    debug = parseBool(getScalar(req.query.debug) || "false");

    // ➊ 리졸버 우선 (법정→행정→nx,ny)
    const r = resolveRegion(regionRaw);
    if (r.ok) {
      nx = r.nxny.nx;
      ny = r.nxny.ny;
      areaNo = r.areaNo || null;
    } else {
      const resolverSuggestions = r.suggestions || [];
      if (r.reason === "NO_DONG" && resolverSuggestions.length > 0) {
        const response = {
            ok: false,
            error: `하위 행정구역을 지정해 주세요: "${regionRaw}"`,
            suggestions: resolverSuggestions
        };
        response.message = `다음 후보 중에서 선택해 주세요: ${resolverSuggestions.join(', ')}`;
        return res.status(200).json(response);
      }
      // ➋ 기존 휴리스틱 폴백
      const matchResult = findNxNy(regionRaw);
      if (!matchResult.coords) {
        // Use suggestions from the resolver if available, otherwise from findNxNy
        const suggestions = resolverSuggestions.length ? resolverSuggestions : (matchResult.suggestions || []);
        const response = {
            ok: false,
            error: `지역 매칭 실패: "${regionRaw}"`,
            suggestions: suggestions
        };
        if (suggestions.length > 0) {
            response.message = `다음 지역명으로 다시 시도해보세요: ${suggestions.join(', ')}`;
        }
        return res.status(200).json(response);
      }
      ({ nx, ny } = matchResult.coords);
      areaNo = livingAreaMap?.byNxNy?.[`${nx},${ny}`] || null;
    }
    // 캐시 키 전략: nx,ny + 발표정시
    const { base_date, base_time } = getUltraBaseDateTime();
    const cacheKey = `${nx},${ny},ultra,${base_date}${base_time}`;
    latestKey = `${nx},${ny},ultra,latest`;
    const nextRefreshMs = ttlToNext10m();
    const ttlSec = Math.max(60, Math.floor(nextRefreshMs/1000));
 
    let data; let cacheMeta;

      // 1) 캐시 조회
      const cached = await cacheGet(cacheKey);
      if (cached) {
        data = cached;
        cacheMeta = { hit: true, ageMs: 0, ttl: ttlSec, nextRefreshMs };
      } else {
        // 2) 원본 호출 → 캐시 저장(+ latest)
        const fresh = await fetchUltraNcst({ nx, ny });
        await cacheSet(cacheKey, fresh, ttlSec);
        await cacheSet(latestKey, fresh, 15*60); // 15분 폴백
        data = fresh;
        cacheMeta = { hit: false, ageMs: 0, ttl: ttlSec, nextRefreshMs };
      }

    const { temperature, humidity, windSpeed } = data;
    const now = new Date();
    const observedAtKst = toKstIsoFromBase(data.base_date, data.base_time);
    const isSummer = isSummerSeason(now);

    let apparent = null;
    let level = null;
    let action = null;
    let ptSource = isSummer ? PT_SOURCE_FALLBACK : PT_SOURCE_WIND;
    let ptDefinition = isSummer ? PT_DEF_AIR : PT_DEF_WIND;
    let ptAtKst = observedAtKst;

    if (isSummer) {
      if (areaNo) {
        try {
          const living = await fetchSenTaWithFallback({
            areaNo,
            requestCode: LIVING_REQUEST_CODE,
            now,
          });
          if (living?.ok && living.items?.length) {
            const series = buildSenTaSeries(living.items[0], living.baseTime);
            // Use nearest future forecast value from now
            const picked = pickNearestFuture(series, now);
            if (picked && Number.isFinite(picked.value)) {
              apparent = picked.value;
              ptSource = PT_SOURCE_LIVING;
              ptDefinition = PT_DEF_LIVING;
              ptAtKst = toKstIsoFromMs(picked.dtMs);
            }
          }
        } catch (e) {
          // Summer: do not compute when living index fails
        }
      }
    } else {
      apparent = windChillC(temperature, windSpeed);
      ptSource = PT_SOURCE_WIND;
      ptDefinition = PT_DEF_WIND;
    }

    const ptLabel = ptSource === PT_SOURCE_FALLBACK && apparent == null
    ? "체감온도 데이터 없음(기온 참고)"
      : null;
    const ptFormula = ptDefinition;
    const ptEpsilon = null;

    const legalThresholdMet =
      ptSource === PT_SOURCE_LIVING && apparent != null ? apparent >= LEGAL_MIN_PT : null;
    const thresholdExceeded =
      threshold != null && apparent != null ? apparent >= threshold : null;

    const nowISO = new Date().toISOString();
    const hazards = {
      windRisk: typeof windSpeed === "number" ? windSpeed >= 10 : null,
      snowRisk: null,
      slipFreezeRisk: null,
    };
    const payload = {
      ok: true,
      ...(data.stale && { stale: true, note: data.note }),
      region: regionRaw,
      grid: { nx, ny },
      observed: debug
        ? { ...data, raw: data._raw }
        : {
            base_date: data.base_date, base_time: data.base_time,
            temperature: data.temperature, humidity: data.humidity, windSpeed: data.windSpeed
          },
      observedAtKst,
      metrics: {
        apparentTemperature: apparent,
        level,
        ptFormula,
        ptEpsilon,
        ptSource,
        ptDefinition,
        ptAtKst,
        ...(ptLabel ? { ptLabel } : {}),
      },
      actions: {
        legalMinPT: LEGAL_MIN_PT,
        legalThresholdMet,
        suggestedAction: action,
        customThreshold: threshold,
        customThresholdExceeded: thresholdExceeded,
      },
      hazards,
      cache: cacheMeta,
      system: {
        refreshIntervalMs: 3600000,
        cache: {
          ...cacheMeta,
          nextRefreshMs: nextRefreshMs,
          note: "다음 10분 경계까지의 예상 TTL(동적). 서버리스 환경에선 인스턴스별 캐시가 공유되지 않을 수 있습니다."
        },
        logFile: LOG_FILE,
        ts: nowISO,
      },
    };

    if (compat === "rows") {
      payload.legacy = {
        place: regionRaw,
        date: data.base_date,
        nx, ny,
        base_date: data.base_date,
        base_time: data.base_time,
        rows: apparent != null ? [{
          hour: data.base_time,
          Ta: temperature, RH: humidity, PT: apparent, level, action,
        }] : [],
      };
    }

    if (debug) {
      payload.debug = {
        kmaMeta: { base_date: data.base_date, base_time: data.base_time, nx, ny },
      };
    }

    await writeLogLine({
      ts: nowISO, region: regionRaw, nx, ny,
      temperature, humidity, windSpeed,
      apparentTemperature: apparent, level, action,
    });

    if (phrase) {
      if (apparent != null) {
        const levelPart = level ? `(${level})` : "";
        const actionPart = action ? ` ${action}` : "";
        const text = `현재 ${regionRaw}의 기온 ${temperature}?, 습도 ${humidity}%, 체감 ${apparent}?${levelPart}.${actionPart}`.trim();
        return res.status(200).json({ ...payload, phrase: text });
      }
      const label = ptLabel ? ` ${ptLabel}` : "";
      const text = `현재 ${regionRaw}의 실황 자료가 부족해 체감온도를 산출하지 못했습니다.${label}`.trim();
      return res.status(200).json({ ...payload, phrase: text });
    }

    return res.status(200).json(payload);

  } catch (err) {
    console.error(err);
    // 실패 시 latest 폴백
    const last = await cacheGet(latestKey);
    if (last) {
      return res.status(200).json({
        ok: true,
        stale: true,
        note: 'fallback_cache',
        ...format(last, regionRaw, nx, ny, debug, compat, phrase, threshold, { hit: true, ageMs: 0 })
      });
     }
    
    return res.status(200).json({
      ok: false,
      reason: 'upstream_error',
      message: String(err?.message || err),
    });
  }
}