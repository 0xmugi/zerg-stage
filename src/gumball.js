// Gumball machine API helpers — daily spin reward minigame.
//
// Endpoints:
//   GET  /api/v1/gumball/status → spin allowance, tiers (rarity drop table),
//                                  playsRemaining, resetsAt
//   POST /api/v1/gumball/play   → consume 1 spin, returns {rarity,tier,xpAmount}
//
// Both endpoints require `auth_token` cookie (handled by ZergClient).

import { uuidv4 } from './client.js';

/**
 * Fetch gumball status for the logged-in account.
 *
 * @param {ZergClient} client
 * @returns {Promise<{
 *   isActive: boolean,
 *   baseLimit: number,
 *   dailyLimit: number,
 *   playsToday: number,
 *   playsRemaining: number,
 *   resetsAt: string,           // ISO timestamp (UTC midnight)
 *   tiers: Array<{tier:number, rarity:string, xpAmount:number, probability:number}>,
 * }>}
 */
export async function getGumballStatus(client) {
  const res = await client.get('/api/v1/gumball/status');
  if (!res.ok) {
    throw new Error(
      `gumball/status ${res.status}: ${JSON.stringify(res.data).slice(0, 120)}`,
    );
  }
  return res.data?.data;
}

/**
 * Consume one spin. Returns the prize tier.
 *
 * @param {ZergClient} client
 * @returns {Promise<{rarity:string, tier:number, xpAmount:number}>}
 */
export async function playGumball(client) {
  // POST is empty body but server requires `content-length: 0` and an
  // idempotency key (mirrors browser flow). Pass an empty string body so
  // fetch doesn't auto-set chunked encoding.
  const res = await client.request('POST', '/api/v1/gumball/play', '', {
    'x-idempotency-key': uuidv4(),
    'content-length': '0',
  });
  if (!res.ok) {
    throw new Error(
      `gumball/play ${res.status}: ${JSON.stringify(res.data).slice(0, 120)}`,
    );
  }
  return res.data?.data;
}

/**
 * Run the full daily for one account: read status, spin until exhausted.
 * Returns a per-account summary the caller can use for progress UI.
 *
 * @param {object} opts
 * @param {ZergClient} opts.client
 * @param {AbortSignal} [opts.signal]
 * @param {(event:object)=>void} [opts.onProgress]
 * @param {{min:number,max:number}} [opts.spinDelayMs] — sleep between spins (ms)
 *
 * Events:
 *   { type: 'status',       status }                 // initial status fetch
 *   { type: 'spin-start',   index, total }           // about to spin
 *   { type: 'spin-ok',      index, total, prize }    // one spin done
 *   { type: 'spin-fail',    index, total, error }    // spin errored (treated terminal)
 *   { type: 'sleep',        ms }                     // inter-spin sleep
 *   { type: 'done',         summary }                // all spins exhausted
 *
 * Returned summary:
 *   { spins: number, xpEarned: number, byRarity: Record<string,number>, plays: Array }
 */
export async function runDailyForAccount({
  client,
  signal,
  onProgress,
  spinDelayMs = { min: 1500, max: 3500 },
}) {
  const emit = (e) => {
    try {
      onProgress?.(e);
    } catch {}
  };

  const status = await getGumballStatus(client);
  emit({ type: 'status', status });

  if (!status?.isActive) {
    const summary = { spins: 0, xpEarned: 0, byRarity: {}, plays: [], inactive: true };
    emit({ type: 'done', summary });
    return summary;
  }

  const total = status.playsRemaining;
  const summary = { spins: 0, xpEarned: 0, byRarity: {}, plays: [], lastError: null };

  for (let i = 0; i < total; i++) {
    if (signal?.aborted) break;
    emit({ type: 'spin-start', index: i + 1, total });
    let prize;
    try {
      prize = await playGumball(client);
    } catch (e) {
      const errMsg = e?.message ?? String(e);
      summary.lastError = errMsg;
      emit({ type: 'spin-fail', index: i + 1, total, error: errMsg });
      // Stop on error — usually means daily-limit reached server-side or
      // a transient issue worth manual review.
      break;
    }
    summary.spins++;
    summary.xpEarned += prize.xpAmount ?? 0;
    summary.byRarity[prize.rarity] = (summary.byRarity[prize.rarity] ?? 0) + 1;
    summary.plays.push(prize);
    emit({ type: 'spin-ok', index: i + 1, total, prize });

    // Anti-bot delay between spins (skip on last)
    if (i < total - 1 && !signal?.aborted) {
      const delayMs =
        spinDelayMs.min +
        Math.floor(Math.random() * Math.max(1, spinDelayMs.max - spinDelayMs.min + 1));
      emit({ type: 'sleep', ms: delayMs });
      await new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        const t = setTimeout(resolve, delayMs);
        signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
      });
    }
  }

  emit({ type: 'done', summary });
  return summary;
}
