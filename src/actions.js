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

// Build + sign + send (or simulate) a purchase_tbos tx.
// Always re-reads the latest nonce from chain, so this is safe to call in a loop.
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
  const nonce = await readUserTotalPurchased(conn, userTboPurchases);

  const { ix } = buildPurchaseIx({
    onChainId,
    campaignIndex,
    quantity: BigInt(quantity),
    nonce,
    signer,
  });

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
    const sim = await conn.simulateTransaction(tx, { commitment: 'confirmed' });
    return {
      ok: !sim.value.err,
      simulated: true,
      nonce,
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
    nonce,
    err: conf.value.err,
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
