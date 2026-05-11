// Shared job runner used by both CLI (bot.js) and Telegram bot.
// Emits structured events via onProgress so each frontend can render
// however it likes (console logs vs. live message edits).
//
// Cancel via AbortSignal.

import { setTimeout as sleepP } from 'node:timers/promises';
import { buyOne, openBoxes, MAX_PER_OPEN } from './actions.js';

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Sequential plan: finish all loops of one token before moving to next.
// Token order is shuffled each run so it's not always A→B.
export function makePlan(tokenIds, loopsPerToken) {
  const order = [...tokenIds].sort(() => Math.random() - 0.5);
  const plan = [];
  for (let t = 0; t < order.length; t++) {
    for (let i = 0; i < loopsPerToken; i++) {
      const isLastOfToken = i === loopsPerToken - 1;
      const isLastEver = isLastOfToken && t === order.length - 1;
      plan.push({
        tokenId: order[t],
        delayKind: isLastEver ? null : isLastOfToken ? 'inter-token' : 'normal',
      });
    }
  }
  return { plan, order };
}

// Abort-aware sleep. Throws AbortError if signal aborted.
async function sleep(ms, signal) {
  await sleepP(ms, undefined, { signal });
}

/**
 * Run a buy/open job.
 *
 * @param {object} opts
 * @param {Connection} opts.conn          - Solana connection
 * @param {Keypair}    opts.kp            - Wallet keypair
 * @param {ZergClient} opts.client        - Logged-in API client
 * @param {Array<{tokenId, data}>} opts.tokens - Resolved tokens
 * @param {{min,max}} opts.qty            - Random qty range (capped at MAX_PER_OPEN)
 * @param {number}    opts.loopsPerToken  - How many iters per token
 * @param {boolean}   opts.openOnly       - Skip buy step
 * @param {boolean}   opts.autoOpen       - Auto-open after buy (ignored when openOnly=true)
 * @param {boolean}   [opts.bulkOpenAfter] - If true, defer all opens until after every buy
 *                                           iteration finishes; then open per-token in
 *                                           chunks. Forces autoOpen=false during the loop.
 *                                           Useful for "buy a stockpile, then open all".
 * @param {object}    opts.delays         - Delay config from config.js
 * @param {Function}  opts.onProgress     - (event) => void
 * @param {AbortSignal} [opts.signal]     - Optional abort signal
 *
 * Events emitted via onProgress:
 *   { type: 'job-start', plan, order, totalIters, qty, openOnly, autoOpen, bulkOpenAfter }
 *   { type: 'iter-start', i, total, tokenId, name, ticker, qty }
 *   { type: 'buy-ok',     i, sig, nonce }
 *   { type: 'buy-fail',   i, err, logs }
 *   { type: 'open-ok',    i, count, tokenId?, ticker?, phase? }
 *   { type: 'open-fail',  i, status, body, tokenId?, ticker?, phase? }
 *   { type: 'iter-end',   i, totals }
 *   { type: 'sleep',      i, kind, durationMs, nextTicker?, coffeeExtraMs? }
 *   { type: 'phase-change', phase: 'buying' | 'opening' }   // bulk mode only
 *   { type: 'bulk-open-start', tokenId, ticker, total }     // bulk mode only
 *   { type: 'aborted',    summary }
 *   { type: 'done',       summary }
 */
export async function runJob({
  conn,
  kp,
  client,
  tokens,
  qty,
  loopsPerToken,
  openOnly,
  autoOpen,
  bulkOpenAfter = false,
  delays,
  onProgress,
  signal,
  plan: providedPlan,
  order: providedOrder,
}) {
  const emit = (event) => {
    try {
      onProgress?.(event);
    } catch {}
  };

  // Cap qty
  const qtyMin = Math.max(1, qty.min);
  const qtyMax = Math.min(MAX_PER_OPEN, qty.max);

  const tokenMap = new Map(tokens.map((t) => [t.tokenId, t]));
  let plan, order;
  if (providedPlan) {
    plan = providedPlan;
    order = providedOrder ?? [];
  } else {
    ({ plan, order } = makePlan(
      tokens.map((t) => t.tokenId),
      loopsPerToken,
    ));
  }

  // In bulk-open mode, force autoOpen=false so the per-iter open block is skipped.
  // The post-loop bulk-open phase is the single source of "open" calls.
  const effectiveAutoOpen = bulkOpenAfter ? false : autoOpen;

  emit({
    type: 'job-start',
    plan,
    order,
    totalIters: plan.length,
    qty: { min: qtyMin, max: qtyMax },
    openOnly,
    autoOpen: effectiveAutoOpen,
    bulkOpenAfter,
  });

  if (bulkOpenAfter) {
    emit({ type: 'phase-change', phase: 'buying' });
  }

  const startTs = Date.now();
  const startBalance = await conn
    .getBalance(kp.publicKey, 'confirmed')
    .catch(() => null);

  let totalBought = 0;
  let totalOpened = 0;
  let txOk = 0;
  let txFail = 0;
  let consecutiveFails = 0; // counts buy-fail + iter-error in a row, resets on buy-ok
  const MAX_CONSECUTIVE_FAILS = 10; // abort job after this many in a row
  const perToken = new Map(); // tokenId -> { bought, opened }

  const buildSummary = () => ({
    totalIters: plan.length,
    completedIters: 0, // overwritten below
    txOk,
    txFail,
    totalBought,
    totalOpened,
    perToken: Array.from(perToken.entries()).map(([id, s]) => ({
      tokenId: id,
      ticker: tokenMap.get(id).data.token.ticker,
      name: tokenMap.get(id).data.token.name,
      bought: s.bought,
      opened: s.opened,
    })),
    elapsedMs: Date.now() - startTs,
    startBalanceLamports: startBalance,
  });

  try {
    for (let i = 0; i < plan.length; i++) {
      if (signal?.aborted) {
        const summary = buildSummary();
        summary.completedIters = i;
        emit({ type: 'aborted', summary });
        return summary;
      }

      const step = plan[i];
      const id = step.tokenId;
      const wrap = tokenMap.get(id);
      const tok = wrap.data;
      const q = randInt(qtyMin, qtyMax);
      const stats = perToken.get(id) ?? { bought: 0, opened: 0 };

      emit({
        type: 'iter-start',
        i,
        total: plan.length,
        tokenId: id,
        name: tok.token.name,
        ticker: tok.token.ticker,
        qty: q,
      });

      try {
        let canOpen = true;
        if (!openOnly) {
          const buyRes = await buyOne({
            conn,
            kp,
            tok,
            quantity: q,
            send: true,
          });
          canOpen = buyRes.ok;
          if (!buyRes.ok) {
            txFail++;
            consecutiveFails++;
            emit({ type: 'buy-fail', i, err: buyRes.err, logs: buyRes.logs });
          } else {
            txOk++;
            consecutiveFails = 0;
            totalBought += q;
            stats.bought += q;
            emit({ type: 'buy-ok', i, sig: buyRes.sig, nonce: String(buyRes.nonce) });
          }
        }

        const wantOpen = openOnly || (effectiveAutoOpen && canOpen);
        if (wantOpen) {
          if (!openOnly) {
            const pbd = randInt(
              delays.postBuy.min * 1000,
              delays.postBuy.max * 1000,
            );
            emit({ type: 'sleep', i, kind: 'post-buy', durationMs: pbd });
            await sleep(pbd, signal);
          }

          let remaining = q;
          let openedAny = false;
          while (remaining > 0) {
            if (signal?.aborted) break;
            const c = Math.min(remaining, MAX_PER_OPEN);
            const openRes = await openBoxes({ client, tokenId: id, count: c });
            if (openRes.ok) {
              totalOpened += c;
              stats.opened += c;
              openedAny = true;
              emit({ type: 'open-ok', i, count: c });
            } else {
              emit({
                type: 'open-fail',
                i,
                status: openRes.status,
                body: JSON.stringify(openRes.data).slice(0, 200),
              });
              break;
            }
            remaining -= c;
            if (remaining > 0) {
              await sleep(
                randInt(
                  delays.openChunkDelay.min,
                  delays.openChunkDelay.max,
                ),
                signal,
              );
            }
          }
          if (openOnly) {
            if (openedAny) txOk++;
            else txFail++;
          }
        }
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        txFail++;
        consecutiveFails++;
        emit({ type: 'iter-error', i, error: e?.message ?? String(e) });
      }

      perToken.set(id, stats);
      emit({
        type: 'iter-end',
        i,
        totals: { txOk, txFail, totalBought, totalOpened },
      });

      // Abort job if we hit a streak of failures — usually means the campaign
      // is sold out, nonce mismatch, or the wallet is broken. Continuing wastes
      // time AND spams the Telegram API (every fail triggers a status edit),
      // which can trigger a long Telegram rate-limit ban.
      if (consecutiveFails >= MAX_CONSECUTIVE_FAILS && !signal?.aborted) {
        const summary = buildSummary();
        summary.completedIters = i + 1;
        summary.abortReason = `${MAX_CONSECUTIVE_FAILS} consecutive failures`;
        emit({
          type: 'streak-abort',
          consecutiveFails,
          summary,
        });
        return summary;
      }

      // Inter-iter delay (with optional coffee break)
      if (step.delayKind && !signal?.aborted) {
        const isInterToken = step.delayKind === 'inter-token';
        const baseRange = isInterToken
          ? delays.interToken
          : delays.betweenTx;
        let d = randInt(baseRange.min * 1000, baseRange.max * 1000);
        const takeCoffee =
          delays.coffee.prob > 0 && Math.random() < delays.coffee.prob;
        let coffeeExtraMs = 0;
        if (takeCoffee) {
          coffeeExtraMs = randInt(
            delays.coffee.min * 1000,
            delays.coffee.max * 1000,
          );
          d += coffeeExtraMs;
        }

        const nextTicker = isInterToken
          ? tokenMap.get(plan[i + 1].tokenId).data.token.ticker
          : undefined;

        emit({
          type: 'sleep',
          i,
          kind: step.delayKind,
          durationMs: d,
          coffeeExtraMs,
          nextTicker,
        });
        await sleep(d, signal);
      }
    }

    // ── Bulk-open phase ──
    // After the buy loop completes, open every box bought so far, grouped by
    // token, in chunks of MAX_PER_OPEN with anti-bot delays in between.
    if (bulkOpenAfter && !openOnly && !signal?.aborted) {
      emit({ type: 'phase-change', phase: 'opening' });
      for (const [tokenId, stats] of perToken) {
        if (signal?.aborted) break;
        const toOpen = stats.bought - stats.opened;
        if (toOpen <= 0) continue;
        const ticker = tokenMap.get(tokenId).data.token.ticker;
        emit({ type: 'bulk-open-start', tokenId, ticker, total: toOpen });

        let remaining = toOpen;
        let consecutive429 = 0;
        while (remaining > 0) {
          if (signal?.aborted) break;
          const c = Math.min(remaining, MAX_PER_OPEN);
          try {
            const openRes = await openBoxes({ client, tokenId, count: c });
            // Server-side rate limit: back off and retry instead of giving up
            // on this token. Cap consecutive 429s to avoid forever-stuck loops.
            if (openRes.status === 429 && consecutive429 < 3) {
              consecutive429++;
              const delayMs = 5000 * consecutive429; // 5s, 10s, 15s
              emit({
                type: 'sleep',
                i: -1,
                kind: 'rate-limit',
                durationMs: delayMs,
              });
              await sleep(delayMs, signal);
              continue; // retry same chunk
            }
            consecutive429 = 0;
            if (openRes.ok) {
              totalOpened += c;
              stats.opened += c;
              emit({
                type: 'open-ok',
                i: -1,
                count: c,
                tokenId,
                ticker,
                phase: 'bulk',
              });
            } else {
              emit({
                type: 'open-fail',
                i: -1,
                tokenId,
                ticker,
                status: openRes.status,
                body: JSON.stringify(openRes.data).slice(0, 200),
                phase: 'bulk',
              });
              break; // stop opening this token, move to next
            }
          } catch (e) {
            if (e?.name === 'AbortError') throw e;
            emit({
              type: 'iter-error',
              i: -1,
              tokenId,
              ticker,
              error: e?.message ?? String(e),
              phase: 'bulk',
            });
            break;
          }
          remaining -= c;
          if (remaining > 0 && !signal?.aborted) {
            await sleep(
              randInt(delays.openChunkDelay.min, delays.openChunkDelay.max),
              signal,
            );
          }
        }
        perToken.set(tokenId, stats);
      }
    }
  } catch (e) {
    if (e?.name === 'AbortError') {
      const summary = buildSummary();
      emit({ type: 'aborted', summary });
      return summary;
    }
    throw e;
  }

  const summary = buildSummary();
  summary.completedIters = plan.length;

  // Best-effort spent calculation
  try {
    const endBalance = await conn.getBalance(kp.publicKey, 'confirmed');
    summary.endBalanceLamports = endBalance;
    if (startBalance != null) {
      summary.spentLamports = startBalance - endBalance;
    }
  } catch {}

  emit({ type: 'done', summary });
  return summary;
}
