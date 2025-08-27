/**
 * /api/pt.js
 * 체감온도(여름, KMA2016) + 초단기실황(getUltraSrtNcst) 기반 실시간 안전경보 API
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

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { readFileSync } from "fs";
const nxnyDB = JSON.parse(
  readFileSync(new URL("../lib/nxny_map.json", import.meta.url), "utf-8")
);

// ───────────────────────────────────────────────────────────────────────────────
// 상수 및 운영 파라미터
// ───────────────────────────────────────────────────────────────────────────────

// 초단기실황(실황) 엔드포인트: 정시 생성, 매시 10분 이후 제공
const KMA_ULTRA_NCST_URL =
  "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst";

// 가이드 기준 1시간 주기(실황). 메타정보로 응답에 노출만 함.
export const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

// 동일 지역 10분 캐시 (in-memory: 서버리스 콜드스타트/다중 인스턴스에서는 한계)
function msUntilNext10Min(now = new Date()) {
  const m = now.getUTCMinutes(), s = now.getUTCSeconds(), ms = now.getUTCMilliseconds();
  const next = (Math.floor(m/10)+1)*10; // 0→10→20…
  const addMin = (next === 60) ? (60 - m) : (next - m);
  const base = addMin*60*1000 - s*1000 - ms;
  return Math.max(base - 15*1000, 60*1000); // 15초 여유, 최소 1분
}

const CACHE_MAP = new Map();

function getCache(key) {
  const hit = CACHE_MAP.get(key);
  if (!hit) return null;
  if (Date.now() <= hit.expireAt) {
    return { ...hit, cacheHit: true, cacheAgeMs: Date.now() - hit.savedAt };
  }
  CACHE_MAP.delete(key);
  return null;
}

function setCache(key, value) {
  const ttl = msUntilNext10Min();
  CACHE_MAP.set(key, {
    ...value,
    savedAt: Date.now(),
    expireAt: Date.now() + ttl,
    cacheHit: false,
  });
}

// 로그 저장 경로: 서버리스 쓰기 보장 디렉터리 우선(/tmp), 없으면 cwd/logs
const LOG_DIR = process.env.LOG_DIR || "/tmp/logs";
const LOG_FILE = path.join(LOG_DIR, "pt_log.jsonl");

// 계산식 메타(하위호환 검증 및 가시화)
const PT_FORMULA = "KMA2016"; // 체감온도 계산모델 식별자
const PT_EPSILON = 0.1;       // 허용 오차(동등성 검증 가이드)

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
/** 체감온도 계산(KMA2016, 여름) + 등급/조치 */
// ───────────────────────────────────────────────────────────────────────────────
function perceivedTempKMA(Ta, RH) {
  // Stull 근사 Tw (습구온도)
  const Tw =
    Ta * Math.atan(0.151977 * Math.sqrt(RH + 8.313659)) +
    Math.atan(Ta + RH) -
    Math.atan(RH - 1.676331) +
    0.00391838 * Math.pow(RH, 1.5) * Math.atan(0.023101 * RH) -
    4.686035;
  // KMA 2016 apparent temperature (여름)
  const PT =
    -0.2442 + 0.55399 * Tw + 0.45535 * Ta - 0.0022 * Tw * Tw + 0.00278 * Tw * Ta + 3.0;
  return Math.round(PT * 10) / 10; // 소수1자리
}

function levelByPT(pt) {
  if (pt >= 40) return "위험";
  if (pt >= 38) return "경고";
  if (pt >= 35) return "주의";
  if (pt >= 32) return "관심";
  return "정상";
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
 // (정책) Encoding 키만 사용: 공백/따옴표 제거 후 raw 그대로 사용
 const rawKey = (process.env.KMA_SERVICE_KEY || "")
   .trim()
   .replace(/^['"]|['"]$/g, "");
 // 나머지 파라미터만 인코딩 → serviceKey는 직접 붙여 이중 인코딩 방지
 const q = new URLSearchParams({
   dataType: "JSON",
   numOfRows: "100",
   pageNo: "1",
   base_date,
   base_time,
   nx: String(nx),
   ny: String(ny),
 });
 const url = `${KMA_ULTRA_NCST_URL}?serviceKey=${rawKey}&${q.toString()}`;

  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    const errorText = await res.text();
    // eslint-disable-next-line no-console
    console.error("KMA API HTTP Error Response:", errorText);
    throw new Error(`KMA HTTP ${res.status}`);
  }

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("Failed to parse KMA API response as JSON. Response text:", text);
    throw new Error(`KMA API response is not valid JSON: ${text.slice(0, 200)}`);
  }

  // OpenAPI 헤더 resultCode 확인(00 정상 외 에러 throw)
  const code = json?.response?.header?.resultCode;
  const msg = json?.response?.header?.resultMsg;
  if (code !== "00") {
    const e = new Error(`KMA API Error: ${code} - ${msg}`);
    e.name = "KmaApiError";
    e.code = code;
    e.msg = msg;
    throw e;
  }

  const items = json?.response?.body?.items?.item || [];
  const map = Object.fromEntries(items.map((it) => [it.category, it.obsrValue]));
  const t = map.T1H != null ? parseFloat(map.T1H) : null; // 기온(℃)
  const rh = map.REH != null ? parseFloat(map.REH) : null; // 습도(%)
  const wsd = map.WSD != null ? parseFloat(map.WSD) : null; // 풍속(m/s)

  return { base_date, base_time, temperature: t, humidity: rh, windSpeed: wsd, _raw: json };
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

// ───────────────────────────────────────────────────────────────────────────────
/** API 핸들러 */
// ───────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  try {
    const regionRaw = (getScalar(req.query.region) || "").trim();
if (!regionRaw.length) {
  return res.status(400).json({ ok:false, error:"region 쿼리가 비어 있습니다." });
}
    const threshold = parseNumberOrNull(getScalar(req.query.threshold));
    const phrase = parseBool(getScalar(req.query.phrase) || "false");
    const compat = (getScalar(req.query.compat) || "").toLowerCase(); // "rows" 지원
    const debug = parseBool(getScalar(req.query.debug) || "false");

    const matchResult = findNxNy(regionRaw);
    if (!matchResult.coords) {
      const response = {
        ok: false, 
        error: `지역 매칭 실패: "${regionRaw}" (공식 법정동 명칭에 가깝게 입력)`
      };
      if (matchResult.suggestions && matchResult.suggestions.length > 0) {
        response.suggestions = matchResult.suggestions;
        response.message = `다음 지역명으로 다시 시도해보세요: ${matchResult.suggestions.join(', ')}`;
      }
      return res.status(404).json(response);
    }
    const { nx, ny } = matchResult.coords;

    const cacheKey = `${nx},${ny}`;
    const cached = getCache(cacheKey);
    const data   = cached || (await fetchUltraNcst({ nx, ny }));
    if (!cached) setCache(cacheKey, data);
    // 캐시 메타(표기용)
    const cacheMeta = cached
      ? { hit: true,  ageMs: cached.cacheAgeMs }
      : { hit: false, ageMs: 0 };

    const { temperature, humidity, windSpeed } = data;

    let apparent = null;
    let level = null;
    let action = null;
    if (temperature != null && humidity != null) {
      apparent = perceivedTempKMA(temperature, humidity);
      level = levelByPT(apparent);
      action = actionByLevel(level, apparent);
    }

    const legalThresholdMet = apparent != null ? apparent >= LEGAL_MIN_PT : null;
    const thresholdExceeded =
      threshold != null && apparent != null ? apparent >= threshold : null;

    const nowISO = new Date().toISOString();
    const payload = {
      ok: true,
      region: regionRaw,
      grid: { nx, ny },
      observed: debug
        ? { ...data, raw: data._raw }
        : {
            base_date: data.base_date, base_time: data.base_time,
            temperature: data.temperature, humidity: data.humidity, windSpeed: data.windSpeed
          },
          metrics: {
        apparentTemperature: apparent,
        level,
        ptFormula: PT_FORMULA,
        ptEpsilon: PT_EPSILON,
      },
      actions: {
        legalMinPT: LEGAL_MIN_PT,
        legalThresholdMet,
        suggestedAction: action,
        customThreshold: threshold,
        customThresholdExceeded: thresholdExceeded,
      },
      system: {
        refreshIntervalMs: 3600000,
            cache: {
          ...cacheMeta,
          nextRefreshMs: msUntilNext10Min(),
          note: "다음 10분 경계까지의 예상 TTL(동적). 서버리스 환경에선 인스턴스별 캐시가 공유되지 않을 수 있습니다."
        },        
        logFile: LOG_FILE,
        ts: nowISO,
      },
    };

    // ── 하위호환 스키마(옵션): ?compat=rows → 이전 rows 구조 추가
    if (compat === "rows") {
      const legacy = {
        place: regionRaw,
        date: data.base_date,
        nx,
        ny,
        base_date: data.base_date,
        base_time: data.base_time,
        rows:
          apparent != null
            ? [
                {
                  hour: data.base_time, // HH00
                  Ta: temperature,
                  RH: humidity,
                  PT: apparent,
                  level,
                  action,
                },
              ]
            : [],
      };
      payload.legacy = legacy;
    }

    // ── 디버그 모드: KMA 호출 메타(키 미노출) 첨부
    if (debug) {
      payload.debug = {
        kmaMeta: {
          base_date: data.base_date,
          base_time: data.base_time,
          nx,
          ny,
        },
      };
    }

    // 관리 기록 로깅
    await writeLogLine({
      ts: nowISO,
      region: regionRaw,
      nx,
      ny,
      temperature,
      humidity,
      windSpeed,
      apparentTemperature: apparent,
      level,
      action,
    });

    if (phrase) {
      const text =
        apparent != null
          ? `현재 ${regionRaw}의 기온 ${temperature}℃, 습도 ${humidity}%, 체감 ${apparent}℃(${level}). ${action}`
          : `현재 ${regionRaw}의 실황 자료가 부족해 체감온도를 산출하지 못했습니다.`;
      return res.status(200).json({ ...payload, phrase: text });
    }
    return res.status(200).json(payload);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    const isKma = err?.name === "KmaApiError";
    return res.status(500).json({
      ok: false,
      error: isKma ? "KMA_API_ERROR" : "INTERNAL_ERROR",
      message: String(err?.message || err),
      source: isKma ? "KMA" : "SERVER",
      code: isKma ? err.code : undefined,
    });
  }
}
