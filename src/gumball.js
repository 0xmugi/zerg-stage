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
 * all retry cycles exhausted.
 *
 * Empirical observation (probed 14-May-2026): Zerg's /gumball/play uses a
 * **token-bucket** rate limit, not a hard cooldown:
 *   - Each account has ~4 tokens up-front; each successful spin consumes 1.
 *   - When bucket empties, retry_after temporarily jumps to ~6h (full refill
 *     time) but actually refills 1 token every ~5 min.
 *   - 429 attempts do NOT escalate the cooldown — keep retrying.
 *   - ~13-55% of retries succeed during heavy spam (depends on bucket state).
 *
 * The runner uses a **multi-cycle retry strategy** (per user request):
 *   1. Burst phase: rapid 2-4s retries. Smart-wait honored for medium
 *      retry_after (30s - maxShortWaitSec) within a per-cycle budget.
 *      Burst ends after maxConsecutiveFails (default 30) failures in a row.
 *   2. Cycle pause: sleep cyclePauseMs (default 5 min) to let the token
 *      bucket drip-refill a few more tokens.
 *   3. Repeat for maxCycles total (default 5 = ~27 min worst case).
 *   4. Bail only after all cycles exhausted — long retry_after is NOT a
 *      bail signal anymore (we still get ~13% slip-through during refill).
 *
 * @param {object} opts
 * @param {ZergClient} opts.client
 * @param {AbortSignal} [opts.signal]
 * @param {(event:object)=>void} [opts.onProgress]
 * @param {{min:number,max:number}} [opts.spinDelayMs] — sleep between burst retries (ms)
 * @param {number} [opts.maxConsecutiveFails] — end burst after this many 429s in a row
 * @param {number} [opts.maxShortWaitSec] — retry_after below this → smart-wait (default 480 = 8 min)
 * @param {number} [opts.maxTotalWaitMs] — cumulative smart-wait budget per cycle (default 15 min)
 * @param {number} [opts.maxCycles] — max burst+pause cycles before bailing (default 5)
 * @param {number} [opts.cyclePauseMs] — pause duration between cycles (default 5 min)
 *
 * Events:
 *   { type: 'status',       status }                            // initial status
 *   { type: 'spin-start',   index, total }                      // about to spin
 *   { type: 'spin-ok',      index, total, prize, attemptNo }    // success
 *   { type: 'spin-fail',    index, total, error, consecutiveFails, cycle } // 429/error
 *   { type: 'sleep',        ms, reason }                        // inter-attempt sleep
 *   { type: 'wait-cooldown', ms, retryAfterSec }                // honoring server retry_after
 *   { type: 'cycle-pause',  cycle, totalCycles, ms }            // pause between cycles
 *   { type: 'done',         summary }                           // exhausted/bail
 *
 * Returned summary:
 *   { spins, xpEarned, byRarity, plays, attempts, lastError,
 *     cycles, bailedOnMaxCycles, totalWaitMs }
 */
export async function runDailyForAccount({
  client,
  signal,
  onProgress,
  spinDelayMs = { min: 2000, max: 4000 },
  maxConsecutiveFails = 30,
  maxShortWaitSec = 480,
  maxTotalWaitMs = 15 * 60 * 1000,
  maxCycles = 5,
  cyclePauseMs = 5 * 60 * 1000,
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
    cycles: 0,
    bailedOnMaxCycles: false,
    totalWaitMs: 0,
  };

  // Abort-aware sleeper. Resolves early if signal is aborted.
  const interruptibleSleep = (ms) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const t = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });

  // Parse "Retry after Ns" from a spin error message. Returns seconds or null.
  const parseRetryAfter = (errMsg) => {
    const m = /Retry after (\d+)s/i.exec(String(errMsg ?? ''));
    return m ? Number(m[1]) : null;
  };

  const randomBurstDelay = () =>
    spinDelayMs.min +
    Math.floor(Math.random() * Math.max(1, spinDelayMs.max - spinDelayMs.min + 1));

  // Outer cycle loop: burst → pause → burst → pause → ...
  let cycle = 0;
  outer: while (summary.spins < total && cycle < maxCycles) {
    if (signal?.aborted) break;
    cycle++;
    summary.cycles = cycle;

    // Pause between cycles (skip before cycle 1)
    if (cycle > 1) {
      emit({ type: 'cycle-pause', cycle, totalCycles: maxCycles, ms: cyclePauseMs });
      await interruptibleSleep(cyclePauseMs);
      summary.totalWaitMs += cyclePauseMs;
      if (signal?.aborted) break;
    }

    // Burst phase: rapid retry with optional smart-wait
    let consecutiveFails = 0;
    let cycleWaitMs = 0; // smart-wait budget for THIS cycle

    while (summary.spins < total && consecutiveFails < maxConsecutiveFails) {
      if (signal?.aborted) break outer;
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
          cycle,
        });

        // Smart-wait for medium retry_after (within per-cycle budget)
        const retryAfterSec = parseRetryAfter(errMsg);
        const wouldExceedBudget =
          retryAfterSec != null &&
          cycleWaitMs + (retryAfterSec + 2) * 1000 > maxTotalWaitMs;

        if (
          retryAfterSec != null &&
          retryAfterSec >= 30 &&
          retryAfterSec <= maxShortWaitSec &&
          !wouldExceedBudget &&
          !signal?.aborted
        ) {
          const waitMs = (retryAfterSec + 2) * 1000;
          emit({ type: 'wait-cooldown', ms: waitMs, retryAfterSec });
          await interruptibleSleep(waitMs);
          cycleWaitMs += waitMs;
          summary.totalWaitMs += waitMs;
          consecutiveFails = 0; // controlled pause — reset burst counter
          continue;
        }

        // Burst retry — regardless of retry_after length (we still get slip-
        // throughs during refill). Stop burst only after maxConsecutiveFails.
        if (consecutiveFails < maxConsecutiveFails && !signal?.aborted) {
          const delayMs = randomBurstDelay();
          emit({ type: 'sleep', ms: delayMs, reason: 'burst-retry' });
          await interruptibleSleep(delayMs);
        }
        continue;
      }
      // Success path
      consecutiveFails = 0;
      summary.spins++;
      summary.xpEarned += prize.xpAmount ?? 0;
      summary.byRarity[prize.rarity] = (summary.byRarity[prize.rarity] ?? 0) + 1;
      summary.plays.push(prize);
      emit({ type: 'spin-ok', index: summary.spins, total, prize, attemptNo: summary.attempts });

      // Anti-bot delay between successful spins (skip on last)
      if (summary.spins < total && !signal?.aborted) {
        const delayMs = randomBurstDelay();
        emit({ type: 'sleep', ms: delayMs, reason: 'after-success' });
        await interruptibleSleep(delayMs);
      }
    }
    // Burst ended. If quota reached, exit. Otherwise loop will pause and
    // start a new cycle (if cycles remain).
    if (summary.spins >= total) break;
  }

  if (cycle >= maxCycles && summary.spins < total) {
    summary.bailedOnMaxCycles = true;
  }

  emit({ type: 'done', summary });
  return summary;
}
