import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL || '';
const isTLS = redisUrl.startsWith('rediss://');

let client = redisUrl
  ? new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      ...(isTLS ? { tls: {} } : {})
    })
  : null;

let useRedis = false;
if (client) {
  client.on('ready', () => { useRedis = true; console.log('[cache] Redis connected'); });
  client.on('error', (e) => {
    console.warn('[cache] Redis error → fallback to memory:', e?.code || e?.message || e);
    useRedis = false;
    try { client.disconnect(); } catch {}
    client = null;
  });
}

const memory = new Map();

export async function cacheGet(key) {
  if (useRedis && client) {
    try {
      if (client.status === 'wait' || client.status === 'end') await client.connect();
      const s = await client.get(key);
      try { return s ? JSON.parse(s) : null; } catch { return null; }
    } catch { /* fall back to memory */ }
  }
  const hit = memory.get(key);
  if (!hit) return null;
  if (Date.now() <= hit.expireAt) return hit.value;
  memory.delete(key);
  return null;
}

export async function cacheSet(key, value, ttlSec) {
  if (useRedis && client) {
    try {
      if (client.status === 'wait' || client.status === 'end') await client.connect();
      await client.set(key, JSON.stringify(value), 'EX', Math.max(1, Math.floor(ttlSec)));
      return;
    } catch { /* fall back to memory */ }
  }
  memory.set(key, { value, expireAt: Date.now() + ttlSec * 1000 });
}

export function closeCache() {
  if (useRedis && client && client.status === 'ready') client.quit().catch(()=>{});
}