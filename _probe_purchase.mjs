// Probe different account configurations for `purchase_tbos` against devnet
// to find which combination passes preflight simulation.
//
// Strategy: login mugi → fetch token `01KRCH26…` → for each candidate
// (token_program variant + key order), build an ix, simulate it, and
// print result. Stop on first success; print ix accounts + logs.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { AccountManager } from './src/account-manager.js';
import { DISC_PURCHASE_TBOS, PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ATA_PROGRAM_ID, derivePurchasePdas, readUserTotalPurchased, u64LE } from './src/onchain.js';
import { config as CONFIG } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Known active token from /offerings?filter=TRENDING (checked via _dump_tokens).
// User can override via CLI arg: `node _probe_purchase.mjs <tboId_or_prefix>`.
const TOKEN_PREFIX = process.argv[2] || '01KRBTW3VX4TKEDTZWRB66T67V'; // ZORRO

// Known token program IDs on Solana.
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

async function loadToken(client, prefix) {
  // Token listings use `tboId` (ULID) as the primary key. Find by prefix, then
  // fetch /api/v1/tokens/{tboId} to get full details with onChainId + campaign.
  const filters = ['TRENDING', 'NEW', 'ENDING_SOON'];
  const pfxL = prefix.toLowerCase();
  let tboId;
  for (const f of filters) {
    try {
      const res = await client.get(`/api/v1/tokens/offerings?filter=${f}&page=1&limit=100`);
      if (!res.ok || !res.data?.success) continue;
      const items = res.data.data?.items ?? [];
      console.log(`  filter=${f}: ${items.length} items`);
      const hit = items.find((t) => (t.tboId || '').toLowerCase().startsWith(pfxL));
      if (hit) { tboId = hit.tboId; console.log(`  → hit tboId=${hit.tboId} name=${hit.tokenName}`); break; }
    } catch (e) { console.log(`  filter=${f} error: ${e.message}`); }
  }
  if (!tboId) {
    // Try direct: maybe prefix IS the full tboId.
    tboId = prefix;
  }
  const det = await client.get(`/api/v1/tokens/${tboId}`);
  if (!det.ok || !det.data?.success) {
    throw new Error(`/tokens/${tboId} failed: status=${det.status} data=${JSON.stringify(det.data).slice(0, 200)}`);
  }
  return det.data.data;
}

async function probe(conn, kp, tok, variant) {
  const onChainId = BigInt(tok.onChainId);
  const campaignIndex = BigInt(tok.campaign?.campaignIndex ?? 0);
  const signer = kp.publicKey;

  const { userTboPurchases, userTboSinglePurchase, globalConfig, tboConfig, campaignTboConfig } = derivePurchasePdas({ onChainId, campaignIndex, signer, nonce: 0n });
  const nonce = await readUserTotalPurchased(conn, userTboPurchases);
  const { userTboSinglePurchase: pdaAtNonce } = derivePurchasePdas({ onChainId, campaignIndex, signer, nonce });

  // Probe free nonce (skip already-used PDAs).
  let freeNonce = nonce;
  for (let i = 0; i < 40; i++) {
    const { userTboSinglePurchase } = derivePurchasePdas({ onChainId, campaignIndex, signer, nonce: freeNonce });
    const info = await conn.getAccountInfo(userTboSinglePurchase, 'confirmed');
    if (!info) break;
    freeNonce = freeNonce + 1n;
  }
  console.log(`  start_nonce=${nonce} free_nonce=${freeNonce}`);

  const { userTboSinglePurchase: pdaToInit } = derivePurchasePdas({ onChainId, campaignIndex, signer, nonce: freeNonce });
  const data = Buffer.concat([DISC_PURCHASE_TBOS, u64LE(onChainId), u64LE(campaignIndex), u64LE(25n), u64LE(freeNonce)]);

  const base = [
    { pubkey: globalConfig, isSigner: false, isWritable: true },
    { pubkey: tboConfig, isSigner: false, isWritable: true },
    { pubkey: campaignTboConfig, isSigner: false, isWritable: true },
    { pubkey: userTboPurchases, isSigner: false, isWritable: true },
    { pubkey: pdaToInit, isSigner: false, isWritable: true },
    { pubkey: signer, isSigner: true, isWritable: true },
  ];

  const keys = [...base, ...variant.tail];

  const ix = new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({ payerKey: signer, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([kp]);

  const sim = await conn.simulateTransaction(tx, { commitment: 'confirmed' });
  if (!sim.value.err) {
    console.log(`  ✅ OK — ${variant.name}`);
    return true;
  }
  const errJson = JSON.stringify(sim.value.err);
  const lastLogs = (sim.value.logs || []).slice(-6);
  console.log(`  ❌ ${variant.name}: err=${errJson}`);
  for (const l of lastLogs) console.log(`     ${l}`);
  return false;
}

async function main() {
  const am = new AccountManager(
    path.join(__dirname, 'data', 'accounts.json'),
    path.join(__dirname, 'data', 'pk.txt'),
  );
  am.init();
  const entry = am.accounts.get('mugi');
  if (!entry) throw new Error(`mugi not found. Available: ${am.names().join(', ')}`);
  const { kp, client } = entry;
  await client.login();
  console.log(`Logged in: ${client.walletAddress()}`);

  const rpcUrl = (Array.isArray(CONFIG.rpcUrls) && CONFIG.rpcUrls[0]) || CONFIG.rpcUrl?.split(',')[0]?.trim();
  if (!rpcUrl) throw new Error('No RPC URL found in config');
  const conn = new Connection(rpcUrl, 'confirmed');
  console.log(`RPC: ${rpcUrl.replace(/api-key=[^&]+/, 'api-key=***')}`);
  const tok = await loadToken(client, TOKEN_PREFIX);
  console.log(`Token: ${tok.id} onChainId=${tok.onChainId} campaignIdx=${tok.campaign?.campaignIndex ?? '(none)'}\n`);

  const variants = [
    {
      name: 'Token-2022 + sys + ATA + rent (current)',
      tail: [
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: ATA_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
    },
    {
      name: 'SPL Token + sys + ATA + rent',
      tail: [
        { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: ATA_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
    },
    {
      name: 'Only SystemProgram (old behavior, 7 keys)',
      tail: [{ pubkey: SystemProgram.programId, isSigner: false, isWritable: false }],
    },
    {
      name: 'SPL Token only (no sys, no ATA, no rent)',
      tail: [{ pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false }],
    },
    {
      name: 'Token-2022 only (no sys, no ATA, no rent)',
      tail: [{ pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }],
    },
  ];

  for (const v of variants) {
    console.log(`\n— Variant: ${v.name}`);
    try {
      const ok = await probe(conn, kp, tok, v);
      if (ok) {
        console.log('\n🏆 FOUND WORKING CONFIG');
        process.exit(0);
      }
    } catch (e) {
      console.log(`  ⚠ probe exception: ${e.message}`);
    }
  }
  console.log('\nAll variants failed. Check logs above to find closest match.');
}

main().catch((e) => { console.error(e); process.exit(1); });
