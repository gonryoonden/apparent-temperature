// lib/http.js
export async function fetchWithRetry(url, opts = {}) {
  const {
    timeoutMs = 3500,
    retries = 1,
    retryDelayBaseMs = 300,
    retryOn = [408, 429, 500, 502, 503, 504],
    signal: externalSignal
  } = opts;

  const circuits = fetchWithRetry._circuits || (fetchWithRetry._circuits = new Map());
  const OPEN_MS = 60_000;
  const FAIL_THRESHOLD = 3;
  const hostOf = (u) => { try { return new URL(u).host; } catch { return 'default'; } };
  const isRetryable = (err, res) =>
    (err && (err.name === 'AbortError' || String(err).includes('fetch failed')))
    || (res && retryOn.includes(res.status));

  const attempt = async (n) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new Error('Timeout')), timeoutMs);
    const host = hostOf(url);
    const c = circuits.get(host);
    if (c?.state === 'open' && Date.now() - c.openedAt < OPEN_MS) {
      clearTimeout(t);
      throw new Error(`CircuitOpen:${host}`);
    }
    let res;
    try {
      res = await fetch(url, { ...opts, signal: externalSignal ?? ac.signal });
      if (!res.ok && retryOn.includes(res.status) && n < retries) {
        await new Promise(r => setTimeout(r, jitter(retryDelayBaseMs, n)));
        return attempt(n+1);
      }
      circuits.set(host, { state: 'closed', fail: 0, openedAt: 0 });
      return res;
    } catch (e) {
      const c0 = circuits.get(host) || { state:'closed', fail:0, openedAt:0 };
      if (isRetryable(e)) {
        const fail = c0.fail + 1;
        if (fail >= FAIL_THRESHOLD) circuits.set(host, { state:'open', fail, openedAt: Date.now() });
        else circuits.set(host, { ...c0, fail });
      }
      if (n < retries) {
        await new Promise(r => setTimeout(r, jitter(retryDelayBaseMs, n)));
        return attempt(n+1);
      }
      throw e;
    } finally {
      clearTimeout(t);
    }
  };
  return attempt(0);
}
const jitter = (base, n) => base * Math.pow(2, n) + Math.random()*100;