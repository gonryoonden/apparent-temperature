const WARNING_TYPE_MAP = {
  "1": "강풍",
  "2": "호우",
  "3": "한파",
  "4": "건조",
  "5": "폭풍해일",
  "6": "풍랑",
  "7": "태풍",
  "8": "대설",
  "9": "황사",
  "12": "폭염",
};

const TYPE_KEYWORDS = Object.values(WARNING_TYPE_MAP);

const norm = (s = "") =>
  String(s)
    .toLowerCase()
    .replace(/[\s_.,\-\\/()<>[\]{}"'`~!@#$%^&*+=:;|?]/g, "");

const getField = (obj, ...cands) => {
  if (!obj) return undefined;
  const keys = Object.keys(obj);
  for (const cand of cands) {
    const want = norm(cand);
    const hit = keys.find((k) => norm(k) === want);
    if (hit) return obj[hit];
  }
  for (const k of keys) {
    const nk = norm(k);
    if (cands.some((c) => nk.includes(norm(c)))) return obj[k];
  }
  return undefined;
};

function tmFcToIso(tmFc) {
  const v = String(tmFc || "");
  if (!/^\d{10,12}$/.test(v)) return null;
  const yyyy = v.slice(0, 4);
  const mm = v.slice(4, 6);
  const dd = v.slice(6, 8);
  const hh = v.slice(8, 10);
  const mi = v.length >= 12 ? v.slice(10, 12) : "00";
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}+09:00`;
}

function parseTypes({ title, warningType }) {
  const out = new Set();
  const wt = String(warningType || "").trim();
  if (WARNING_TYPE_MAP[wt]) out.add(WARNING_TYPE_MAP[wt]);
  const t = String(title || "");
  for (const key of TYPE_KEYWORDS) {
    if (t.includes(key)) out.add(key);
  }
  return [...out];
}

function parseLevel(title = "") {
  const t = String(title);
  if (t.includes("경보")) return "경보";
  if (t.includes("주의보")) return "주의보";
  if (t.includes("예비")) return "예비";
  return null;
}

function extractDetailText(detailItem) {
  if (!detailItem) return null;
  const text =
    getField(detailItem, "text", "wrnMsg", "warnMsg", "message", "내용") ??
    getField(detailItem, "title", "제목");
  if (text == null) return null;
  return String(text).trim();
}

export function normalizeWarnings(listItems = [], detailMap = new Map()) {
  const items = Array.isArray(listItems) ? listItems : [listItems];
  return items
    .map((item) => {
      const title = getField(item, "title", "제목");
      const tmSeq = getField(item, "tmSeq", "발표번호");
      const tmFc = getField(item, "tmFc", "발표시각");
      const warningType = getField(item, "warningType", "특보종류");
      const types = parseTypes({ title, warningType });
      const level = parseLevel(title);
      const issuedAt = tmFcToIso(tmFc);
      const key = `${tmSeq || ""}|${tmFc || ""}`;
      const detailItem = detailMap.get(key);
      const text = extractDetailText(detailItem);
      return {
        title: title != null ? String(title).trim() : null,
        level,
        types,
        tmFc: tmFc != null ? String(tmFc) : null,
        tmSeq: tmSeq != null ? String(tmSeq) : null,
        issuedAt,
        ...(text ? { text } : {}),
      };
    })
    .filter((x) => x.title || x.tmFc || x.tmSeq);
}

export function summarizeWarnings(items = []) {
  const list = Array.isArray(items) ? items : [];
  const count = list.length;
  const types = new Set();
  const levelRank = { 경보: 3, 주의보: 2, 예비: 1 };
  let highestLevel = null;
  let highestRank = 0;
  for (const it of list) {
    if (Array.isArray(it.types)) it.types.forEach((t) => types.add(t));
    const rank = levelRank[it.level] || 0;
    if (rank > highestRank) {
      highestRank = rank;
      highestLevel = it.level || null;
    }
  }
  return {
    count,
    highestLevel,
    types: [...types],
  };
}

