export function normalizeServiceKey(raw = "") {
  const t = String(raw).trim().replace(/^['"]|['"]$/g, ""); // 따옴표/공백 제거
  const looksEncoded = /%[0-9A-Fa-f]{2}/.test(t);            // %xx 패턴 있으면 인코딩된 키로 간주
  return looksEncoded ? t : encodeURIComponent(t);
}