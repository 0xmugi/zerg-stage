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
 * The runner uses a **hybrid retry strategy**:
 *   - Burst mode (small retry_after or none): rapid 2-4s retries, ride
 *     the bucket while it has tokens. Bail after N consecutive fails.
 *   - Smart-wait (retry_after 30s-MAX_SHORT_WAIT_SEC): server tells us
 *     exactly when next token drips — honor it. Wait, retry once, repeat.
 *   - Bail (retry_after > MAX_SHORT_WAIT_SEC OR cumulative wait too long):
 *     bucket fully drained, let caller schedule a follow-up run.
 *
 * @param {object} opts
 * @param {ZergClient} opts.client
 * @param {AbortSignal} [opts.signal]
 * @param {(event:object)=>void} [opts.onProgress]
 * @param {{min:number,max:number}} [opts.spinDelayMs] — sleep between burst retries (ms)
 * @param {number} [opts.maxConsecutiveFails] — bail after this many burst 429s in a row
 * @param {number} [opts.maxShortWaitSec] — retry_after below this → wait it out (default 480 = 8 min)
 * @param {number} [opts.maxTotalWaitMs] — cumulative wait budget per account (default 15 min)
 *
 * Events:
 *   { type: 'status',       status }                            // initial status
 *   { type: 'spin-start',   index, total }                      // about to spin
 *   { type: 'spin-ok',      index, total, prize, attemptNo }    // success
 *   { type: 'spin-fail',    index, total, error, consecutiveFails } // 429/error
 *   { type: 'sleep',        ms, reason }                        // inter-attempt sleep
 *   { type: 'wait-cooldown', ms, retryAfterSec }                // honoring server retry_after
 *   { type: 'done',         summary }                           // exhausted/bail
 *
 * Returned summary:
 *   { spins, xpEarned, byRarity, plays, attempts, lastError,
 *     bailedOnConsecutiveFails, bailedOnLongCooldown, totalWaitMs }
 */
export async function runDailyForAccount({
  client,
  signal,
  onProgress,
  spinDelayMs = { min: 2000, max: 4000 },
  maxConsecutiveFails = 30,
  maxShortWaitSec = 480,
  maxTotalWaitMs = 15 * 60 * 1000,
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
    bailedOnLongCooldown: false,
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

  let consecutiveFails = 0;
  let bailedOnLongCooldown = false;

  while (
    summary.spins < total &&
    consecutiveFails < maxConsecutiveFails &&
    !bailedOnLongCooldown
  ) {
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

      // Hybrid recovery strategy:
      //   1. Long retry_after (> maxShortWaitSec) → bail; bucket fully drained.
      //   2. Short retry_after (30s - maxShortWaitSec) AND budget left → honor
      //      the server's hint: sleep retry_after + 2s safety pad, retry once.
      //      Reset consecutiveFails because the wait is a "controlled" pause.
      //   3. Otherwise (small/no retry_after) → burst mode: 2-4s gap, retry.
      const retryAfterSec = parseRetryAfter(errMsg);
      const wouldExceedBudget =
        retryAfterSec != null &&
        summary.totalWaitMs + (retryAfterSec + 2) * 1000 > maxTotalWaitMs;

      if (retryAfterSec != null && retryAfterSec > maxShortWaitSec) {
        // Case 1: long cooldown → bail.
        bailedOnLongCooldown = true;
        break;
      } else if (
        retryAfterSec != null &&
        retryAfterSec >= 30 &&
        !wouldExceedBudget &&
        !signal?.aborted
      ) {
        // Case 2: smart-wait.
        const waitMs = (retryAfterSec + 2) * 1000;
        emit({ type: 'wait-cooldown', ms: waitMs, retryAfterSec });
        await interruptibleSleep(waitMs);
        summary.totalWaitMs += waitMs;
        consecutiveFails = 0; // controlled pause — don't count toward bail
        continue;
      } else if (wouldExceedBudget) {
        // Would blow the per-account wait budget — bail like long cooldown.
        bailedOnLongCooldown = true;
        break;
      }

      // Case 3: burst-mode retry.
      if (consecutiveFails < maxConsecutiveFails && !signal?.aborted) {
        const delayMs =
          spinDelayMs.min +
          Math.floor(Math.random() * Math.max(1, spinDelayMs.max - spinDelayMs.min + 1));
        emit({ type: 'sleep', ms: delayMs, reason: 'burst-retry' });
        await interruptibleSleep(delayMs);
      }
      continue;
    }
    consecutiveFails = 0;
    summary.spins++;
    summary.xpEarned += prize.xpAmount ?? 0;
    summary.byRarity[prize.rarity] = (summary.byRarity[prize.rarity] ?? 0) + 1;
    summary.plays.push(prize);
    emit({ type: 'spin-ok', index: summary.spins, total, prize, attemptNo: summary.attempts });

    // Anti-bot delay between successful spins (skip on last)
    if (summary.spins < total && !signal?.aborted) {
      const delayMs =
        spinDelayMs.min +
        Math.floor(Math.random() * Math.max(1, spinDelayMs.max - spinDelayMs.min + 1));
      emit({ type: 'sleep', ms: delayMs, reason: 'after-success' });
      await interruptibleSleep(delayMs);
    }
  }

  if (consecutiveFails >= maxConsecutiveFails) {
    summary.bailedOnConsecutiveFails = true;
  }
  if (bailedOnLongCooldown) {
    summary.bailedOnLongCooldown = true;
  }

  emit({ type: 'done', summary });
  return summary;
}
