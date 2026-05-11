// rpc-pool.js — transparent Solana RPC failover.
//
// Wraps multiple @solana/web3.js Connection instances behind a Proxy so every
// caller (conn.getBalance, conn.sendRawTransaction, conn.getLatestBlockhash,
// dll) otomatis rotate ke RPC berikut-nya kalau primary balikin 503/502/504/
// 429/timeout/network error. Untuk non-transient error (misal: signature
// verification fail), error dilempar langsung tanpa rotate.
//
// Usage:
//   import { createRpcPool } from './rpc-pool.js';
//   const conn = createRpcPool([url1, url2, url3]);
//   const bal = await conn.getBalance(pubkey);  // auto-fallback
//
// Properti tambahan yang bisa di-inspect:
//   conn._rpcPool.urls      → array of redacted URLs
//   conn._rpcPool.current() → index + url yang lagi aktif

import { Connection } from '@solana/web3.js';

const TRANSIENT_RE =
  /\b(429|502|503|504)\b|timeout|fetch failed|network|ECONNRESET|ENOTFOUND|ETIMEDOUT|socket hang up|Service unavailable|Too many requests|stream|TLS/i;

function redact(url) {
  return url.replace(/api-key=[^&]+/i, 'api-key=***');
}

function isTransient(err) {
  const msg = err?.message ?? String(err);
  return TRANSIENT_RE.test(msg);
}

export function createRpcPool(urls, commitment = 'confirmed') {
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error('createRpcPool: urls must be non-empty array');
  }

  const pool = urls.map((url) => ({
    url,
    conn: new Connection(url, commitment),
    cooldownUntil: 0, // epoch ms; >0 means kena 429/503, skip sampai expire
  }));
  let idx = 0;

  function pickNext() {
    // Advance to next RPC that isn't in cooldown. If all in cooldown, just
    // move forward (the call itself will handle error).
    const now = Date.now();
    for (let step = 1; step <= pool.length; step++) {
      const next = (idx + step) % pool.length;
      if ((pool[next].cooldownUntil ?? 0) <= now) {
        idx = next;
        return;
      }
    }
    idx = (idx + 1) % pool.length;
  }

  const methodCache = new Map();

  const poolMeta = {
    urls: pool.map((p) => redact(p.url)),
    current: () => ({ idx, url: redact(pool[idx].url) }),
    raw: pool, // exposed for debugging/testing
  };

  // Proxy the FIRST Connection so `instanceof Connection` still works, but
  // override property access to rotate.
  return new Proxy(pool[0].conn, {
    get(_target, prop, _receiver) {
      if (prop === '_rpcPool') return poolMeta;

      // For non-method properties (e.g. `rpcEndpoint`), just return from
      // current connection.
      const sample = pool[idx].conn[prop];
      if (typeof sample !== 'function') return sample;

      if (methodCache.has(prop)) return methodCache.get(prop);

      const wrapped = async function (...args) {
        const maxAttempts = pool.length + 1; // one full rotation retry
        let lastErr;
        let attempts = 0;
        while (attempts < maxAttempts) {
          attempts++;
          const entry = pool[idx];
          try {
            const result = entry.conn[prop].apply(entry.conn, args);
            return result instanceof Promise ? await result : result;
          } catch (e) {
            lastErr = e;
            if (!isTransient(e)) throw e;
            // Mark this RPC as cooling for 15s, then rotate to next.
            entry.cooldownUntil = Date.now() + 15_000;
            const prevLabel = redact(entry.url);
            pickNext();
            console.warn(
              `[rpc-pool] ${String(prop)} failed on ${prevLabel} ` +
                `(${(e.message ?? '').slice(0, 80)}). Rotate → ${redact(pool[idx].url)}`,
            );
            // Small jittered backoff before retry
            await new Promise((r) => setTimeout(r, 300 + Math.random() * 400));
          }
        }
        throw lastErr ?? new Error(`[rpc-pool] all ${pool.length} RPCs failed`);
      };
      methodCache.set(prop, wrapped);
      return wrapped;
    },
  });
}
