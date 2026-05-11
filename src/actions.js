import {
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  buildPurchaseIx,
  readUserTotalPurchased,
  derivePurchasePdas,
  buildClaimIx,
  buildCreateAtaIdempotentIx,
} from './onchain.js';
import { uuidv4 } from './client.js';

// Backend limit: max boxes per multispin call
export const MAX_PER_OPEN = 25;

// Detect "PDA already in use" preflight failures from SendTransactionError.
// Pattern observed in logs:
//   "Allocate: account Address { … } already in use"
//   "Program 11111111111111111111111111111111 failed: custom program error: 0x0"
//
// This means the `user_tbo_single_purchase` PDA we derived (seeded with
// `nonce`) already exists on-chain. Most likely cause: `total_purchased`
// from `user_tbo_purchases` is NOT a 1:1 match for the next available
// nonce slot — could be off-by-one, stale RPC read, or a leftover PDA
// from a partially-failed earlier attempt. Bumping nonce until we find
// a free slot is the safe fix.
function isPdaCollisionError(err) {
  if (!err) return false;
  // err can be an Error object (from sendRawTransaction throw), an
  // object (TransactionError), or a string. Stringify and search.
  const txt =
    err instanceof Error
      ? `${err.message}\n${err.logs?.join('\n') ?? ''}`
      : typeof err === 'string'
        ? err
        : JSON.stringify(err);
  return /already in use|custom program error:\s*0x0/i.test(txt);
}

// How many times to bump nonce (probing for a free slot) before giving up.
// 32 is generous — should cover any plausible off-by-one or stale state.
const MAX_NONCE_RETRIES = 32;

// Build + sign + send (or simulate) a purchase_tbos tx.
// Auto-retries with `nonce++` on PDA collision (system program error 0x0
// "already in use") so the caller doesn't have to handle nonce desync.
export async function buyOne({ conn, kp, tok, quantity, send }) {
  const onChainId = BigInt(tok.onChainId);
  const campaignIndex = BigInt(tok.campaign?.campaignIndex ?? 0);
  const signer = kp.publicKey;

  const { userTboPurchases } = derivePurchasePdas({
    onChainId,
    campaignIndex,
    signer,
    nonce: 0n,
  });
  const startNonce = await readUserTotalPurchased(conn, userTboPurchases);

  let nonce = startNonce;
  let lastErr;
  let lastLogs;
  for (let attempt = 0; attempt < MAX_NONCE_RETRIES; attempt++) {
    const { ix } = buildPurchaseIx({
      onChainId,
      campaignIndex,
      quantity: BigInt(quantity),
      nonce,
      signer,
    });

    // Re-read blockhash on every attempt — stale blockhash on retry would
    // cause its own failure mode unrelated to nonce.
    const { blockhash, lastValidBlockHeight } =
      await conn.getLatestBlockhash('confirmed');
    const msg = new TransactionMessage({
      payerKey: signer,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([kp]);

    if (!send) {
      const sim = await conn.simulateTransaction(tx, {
        commitment: 'confirmed',
      });
      if (!sim.value.err) {
        return {
          ok: true,
          simulated: true,
          nonce,
          attempts: attempt + 1,
          logs: sim.value.logs,
        };
      }
      lastErr = sim.value.err;
      lastLogs = sim.value.logs;
      if (!isPdaCollisionError(sim.value.err) && !isPdaCollisionError(sim.value.logs?.join('\n'))) {
        // Not a collision — return immediately, caller can decide what to do.
        return {
          ok: false,
          simulated: true,
          nonce,
          err: sim.value.err,
          logs: sim.value.logs,
          attempts: attempt + 1,
        };
      }
      // Collision: bump nonce and retry.
      nonce = nonce + 1n;
      continue;
    }

    try {
      const sig = await conn.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 10,
        preflightCommitment: 'confirmed',
      });
      const conf = await conn.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        'confirmed',
      );
      if (!conf.value.err) {
        return {
          ok: true,
          simulated: false,
          sig,
          nonce,
          attempts: attempt + 1,
        };
      }
      // Tx landed but failed on-chain. If collision, retry; otherwise return.
      lastErr = conf.value.err;
      if (!isPdaCollisionError(conf.value.err)) {
        return {
          ok: false,
          simulated: false,
          sig,
          nonce,
          err: conf.value.err,
          attempts: attempt + 1,
        };
      }
      nonce = nonce + 1n;
    } catch (e) {
      // sendRawTransaction throws SendTransactionError on preflight failure.
      // Its message embeds the program logs. Use that to detect collision.
      lastErr = e;
      lastLogs = e?.logs;
      if (!isPdaCollisionError(e)) {
        // Non-collision failure: surface immediately.
        return {
          ok: false,
          simulated: false,
          nonce,
          err: e?.message ?? String(e),
          logs: e?.logs,
          attempts: attempt + 1,
        };
      }
      nonce = nonce + 1n;
    }
  }

  // Exhausted retries — all consecutive nonces are colliding. This is
  // unusual; surfaces as a normal failure so the runner can streak-abort.
  return {
    ok: false,
    simulated: !send,
    nonce,
    err: `PDA collision: tried ${MAX_NONCE_RETRIES} nonces from ${startNonce} to ${nonce}, all "already in use". Last err: ${
      lastErr instanceof Error ? lastErr.message : JSON.stringify(lastErr)
    }`,
    logs: lastLogs,
    attempts: MAX_NONCE_RETRIES,
  };
}

// Build + sign + send a claim_tokens tx for the given on-chain TBO id.
// `amountRaw` is the raw token amount (with decimals) — pass
// `claimableTokensRaw` from /api/v1/inventory/tokens directly.
//
// Tx contains 2 instructions:
//   1. CreateIdempotent ATA — ensures user has a token account for the mint
//   2. claim_tokens — Anchor ix that mints (or transfers) the reward to user ATA
export async function claimTokens({ conn, kp, onChainId, amountRaw, send }) {
  const signer = kp.publicKey;
  const oid = BigInt(onChainId);
  const amount = BigInt(amountRaw);

  const claim = buildClaimIx({ onChainId: oid, amount, signer });
  // Pre-create user's ATA for the tbo_token mint (idempotent / safe to repeat).
  const ataIx = buildCreateAtaIdempotentIx({
    payer: signer,
    owner: signer,
    mint: claim.pdas.tboTokenMint,
  });

  const { blockhash, lastValidBlockHeight } =
    await conn.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: signer,
    recentBlockhash: blockhash,
    instructions: [ataIx, claim.ix],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([kp]);

  if (!send) {
    const sim = await conn.simulateTransaction(tx, {
      commitment: 'confirmed',
    });
    return {
      ok: !sim.value.err,
      simulated: true,
      err: sim.value.err,
      logs: sim.value.logs,
    };
  }

  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 10,
    preflightCommitment: 'confirmed',
  });
  const conf = await conn.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  return {
    ok: !conf.value.err,
    simulated: false,
    sig,
    err: conf.value.err,
  };
}

// POST /api/v1/tbos/{tokenId}/multispin with {count}
// Backend automatically caps to MAX_PER_OPEN.
export async function openBoxes({ client, tokenId, count }) {
  if (count > MAX_PER_OPEN) count = MAX_PER_OPEN;
  const res = await client.post(
    `/api/v1/tbos/${tokenId}/multispin`,
    { count },
    { 'x-idempotency-key': uuidv4() },
  );
  return {
    ok: res.ok,
    status: res.status,
    data: res.data,
  };
}
