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
 * Run the full daily for one account: read status, spin until exhausted OR
 * too many consecutive failures.
 *
 * Empirical observation (probed 14-May-2026): Zerg's /gumball/play uses a
 * **token-bucket** rate limit, not a hard cooldown:
 *   - Each account has ~4 tokens up-front; each successful spin consumes 1.
 *   - When bucket empties, retry_after temporarily jumps to ~6h (full refill
 *     time) but actually refills 1 token every ~5 min.
 *   - 429 attempts do NOT escalate the cooldown — keep retrying.
 *   - ~13% of retries succeed during heavy spam (depends on bucket state).
 *
 * Therefore the runner uses a **retry loop** rather than break-on-first-429:
 *   - Sleep `spinDelayMs` between attempts (default 2-4s — short enough to
 *     burst through the initial bucket, long enough to look human-ish).
 *   - Stop only when:
 *       * `playsRemaining` (server-tracked daily quota) reaches 0, OR
 *       * `maxConsecutiveFails` 429s in a row (default 30 ≈ ~1.5 min, after
 *         which the bucket likely needs minutes to refill — bail and let
 *         caller schedule a retry pass later).
 *
 * @param {object} opts
 * @param {ZergClient} opts.client
 * @param {AbortSignal} [opts.signal]
 * @param {(event:object)=>void} [opts.onProgress]
 * @param {{min:number,max:number}} [opts.spinDelayMs] — sleep between spins (ms)
 * @param {number} [opts.maxConsecutiveFails] — bail after this many 429s in a row
 *
 * Events:
 *   { type: 'status',       status }                            // initial status
 *   { type: 'spin-start',   index, total }                      // about to spin
 *   { type: 'spin-ok',      index, total, prize, attemptNo }    // success
 *   { type: 'spin-fail',    index, total, error, consecutiveFails } // 429/error
 *   { type: 'sleep',        ms, reason }                        // inter-attempt sleep
 *   { type: 'done',         summary }                           // exhausted/bail
 *
 * Returned summary:
 *   { spins, xpEarned, byRarity, plays, attempts, lastError, bailedOnConsecutiveFails }
 */
export async function runDailyForAccount({
  client,
  signal,
  onProgress,
  spinDelayMs = { min: 2000, max: 4000 },
  maxConsecutiveFails = 30,
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
  const summary = {
    spins: 0,
    xpEarned: 0,
    byRarity: {},
    plays: [],
    attempts: 0,
    lastError: null,
    bailedOnConsecutiveFails: false,
  };

  let consecutiveFails = 0;

  while (summary.spins < total && consecutiveFails < maxConsecutiveFails) {
    if (signal?.aborted) break;
    summary.attempts++;
    emit({ type: 'spin-start', index: summary.spins + 1, total });
    let prize;
    try {
      prize = await playGumball(client);
    } catch (e) {
      const errMsg = e?.message ?? String(e);
      summary.lastError = errMsg;
      consecutiveFails++;
      emit({
        type: 'spin-fail',
        index: summary.spins + 1,
        total,
        error: errMsg,
        consecutiveFails,
      });
      // Don't break — keep retrying. Token bucket refills, some attempts
      // slip through. Only stop after maxConsecutiveFails in a row.
      if (consecutiveFails < maxConsecutiveFails && !signal?.aborted) {
        const delayMs =
          spinDelayMs.min +
          Math.floor(Math.random() * Math.max(1, spinDelayMs.max - spinDelayMs.min + 1));
        emit({ type: 'sleep', ms: delayMs, reason: 'retry-after-fail' });
        await new Promise((resolve) => {
          if (signal?.aborted) return resolve();
          const t = setTimeout(resolve, delayMs);
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              resolve();
            },
            { once: true },
          );
        });
      }
      continue;
    }
    consecutiveFails = 0;
    summary.spins++;
    summary.xpEarned += prize.xpAmount ?? 0;
    summary.byRarity[prize.rarity] = (summary.byRarity[prize.rarity] ?? 0) + 1;
    summary.plays.push(prize);
    emit({ type: 'spin-ok', index: summary.spins, total, prize, attemptNo: summary.attempts });

    // Anti-bot delay between attempts (skip on last)
    if (summary.spins < total && consecutiveFails < maxConsecutiveFails && !signal?.aborted) {
      const delayMs =
        spinDelayMs.min +
        Math.floor(Math.random() * Math.max(1, spinDelayMs.max - spinDelayMs.min + 1));
      emit({ type: 'sleep', ms: delayMs, reason: 'after-success' });
      await new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        const t = setTimeout(resolve, delayMs);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      });
    }
  }

  if (consecutiveFails >= maxConsecutiveFails) {
    summary.bailedOnConsecutiveFails = true;
  }

  emit({ type: 'done', summary });
  return summary;
}
