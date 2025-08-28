export const ttlToNext10m = (nowMs = Date.now()) => 600000 - (nowMs % 600000);
export const ttlToNext30m = (nowMs = Date.now()) => 1800000 - (nowMs % 1800000);

export function ttlToNextVilageIssue(now = new Date()) {
  const slots = [2,5,8,11,14,17,20,23];
  const h = now.getHours(), m = now.getMinutes();
  let nextH = slots.find(x => x > h || (x === h && m < 1));
  const next = new Date(now);
  if (nextH == null) { next.setDate(next.getDate()+1); nextH = slots[0]; }
  next.setHours(nextH, 1, 0, 0); // +1분 버퍼
  const ms = next - now;
  return Math.max(60_000, ms);
}