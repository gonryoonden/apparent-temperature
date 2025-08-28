// lib/http.js
export async function fetchWithRetry(url, opts = {}) {
  const {
    timeoutMs = 3500,
    retries = 1,
    retryDelayBaseMs = 300,
    retryOn = [408, 429, 500, 502, 503, 504],
    signal: externalSignal
  } = opts;

  const attempt = async (n) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new Error('Timeout')), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: externalSignal ?? ac.signal });
      if (!res.ok && retryOn.includes(res.status) && n < retries) {
        await new Promise(r => setTimeout(r, jitter(retryDelayBaseMs, n)));
        return attempt(n+1);
      }
      return res;
    } catch (e) {
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