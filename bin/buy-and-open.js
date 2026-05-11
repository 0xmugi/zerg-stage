import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Connection,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { ZergClient, loadKeypair, uuidv4 } from '../src/client.js';
import {
  PROGRAM_ID,
  buildPurchaseIx,
  readUserTotalPurchased,
  derivePurchasePdas,
} from '../src/onchain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RPC_URL =
  process.env.SOLANA_RPC_URL ??
  'https://devnet.helius-rpc.com/?api-key=ac9ac40f-94ab-4212-a306-5238dd4eb864';

const MAX_PER_OPEN = 25; // backend limit: count <= 25 per multispin

function usage() {
  console.error('Usage: node buy-and-open.js <TOKEN_ID> [options]');
  console.error('');
  console.error('Options:');
  console.error('  --send                Actually submit tx + open (default: dry-run)');
  console.error('  --no-open             Skip opening boxes (buy only)');
  console.error('');
  console.error('  --loops N             Fixed iterations (e.g. --loops 10)');
  console.error('  --loops-min N         Min iterations (random range)  default: 10');
  console.error('  --loops-max N         Max iterations (random range)  default: 20');
  console.error('');
  console.error('  --qty N               Fixed quantity per tx');
  console.error('  --qty-min N           Min qty per tx (random range)  default: 20');
  console.error('  --qty-max N           Max qty per tx (random range)  default: 25');
  console.error('');
  console.error('  --delay-min MS        Min delay between tx (ms)      default: 3000');
  console.error('  --delay-max MS        Max delay between tx (ms)      default: 10000');
  console.error('  --post-buy-delay MS   Wait after buy before open     default: 3000');
  console.error('');
  console.error('Examples:');
  console.error('  node buy-and-open.js 01KQVJ2CBTZ2E351HRAPGXRNY6                      # dry-run');
  console.error('  node buy-and-open.js 01KQVJ2CBTZ2E351HRAPGXRNY6 --send               # default 10-20 loops x 20-25 boxes');
  console.error('  node buy-and-open.js 01KQVJ2CBTZ2E351HRAPGXRNY6 --send --loops 5 --qty-min 22 --qty-max 25');
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  if (!args.length) usage();
  const o = {
    tokenId: null,
    send: false,
    open: true,
    loopsMin: 10,
    loopsMax: 20,
    qtyMin: 20,
    qtyMax: 25,
    delayMin: 3000,
    delayMax: 10000,
    postBuyDelay: 3000,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];
    if (a === '--send') o.send = true;
    else if (a === '--dry-run') o.send = false;
    else if (a === '--no-open') o.open = false;
    else if (a === '--loops') o.loopsMin = o.loopsMax = parseInt(next(), 10);
    else if (a === '--loops-min') o.loopsMin = parseInt(next(), 10);
    else if (a === '--loops-max') o.loopsMax = parseInt(next(), 10);
    else if (a === '--qty' || a === '-n') o.qtyMin = o.qtyMax = parseInt(next(), 10);
    else if (a === '--qty-min') o.qtyMin = parseInt(next(), 10);
    else if (a === '--qty-max') o.qtyMax = parseInt(next(), 10);
    else if (a === '--delay-min') o.delayMin = parseInt(next(), 10);
    else if (a === '--delay-max') o.delayMax = parseInt(next(), 10);
    else if (a === '--post-buy-delay') o.postBuyDelay = parseInt(next(), 10);
    else if (!a.startsWith('-') && !o.tokenId) o.tokenId = a;
    else usage();
  }
  if (!o.tokenId) usage();
  if (o.loopsMin < 1 || o.loopsMax < o.loopsMin) {
    console.error('invalid loops range');
    process.exit(1);
  }
  if (o.qtyMin < 1 || o.qtyMax > MAX_PER_OPEN || o.qtyMax < o.qtyMin) {
    console.error(`qty range must be 1..${MAX_PER_OPEN}`);
    process.exit(1);
  }
  if (o.delayMin < 0 || o.delayMax < o.delayMin) {
    console.error('invalid delay range');
    process.exit(1);
  }
  return o;
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

async function doBuyOne({ conn, kp, client, tok, quantity, send }) {
  const onChainId = BigInt(tok.onChainId);
  const campaignIndex = BigInt(tok.campaign?.campaignIndex ?? 0);
  const signer = kp.publicKey;

  // 1. Read fresh nonce from chain
  const { userTboPurchases } = derivePurchasePdas({
    onChainId,
    campaignIndex,
    signer,
    nonce: 0n,
  });
  const nonce = await readUserTotalPurchased(conn, userTboPurchases);

  // 2. Build ix
  const { ix } = buildPurchaseIx({
    onChainId,
    campaignIndex,
    quantity: BigInt(quantity),
    nonce,
    signer,
  });

  // 3. Build tx
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
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

async function doOpen({ client, tokenId, count }) {
  // Backend cap per call
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

async function main() {
  const opts = parseArgs();
  const kp = loadKeypair(path.join(__dirname, '..', 'data', 'pk.txt'));
  const client = new ZergClient(kp);

  const loops = randInt(opts.loopsMin, opts.loopsMax);

  console.log('=== Buy & Open Loop ===');
  console.log(`Wallet       : ${client.walletAddress()}`);
  console.log(`Token ID     : ${opts.tokenId}`);
  console.log(`Mode         : ${opts.send ? 'SEND' : 'DRY-RUN'}`);
  console.log(`Open boxes   : ${opts.open ? 'yes' : 'no'}`);
  console.log(`Loops        : ${loops} (range ${opts.loopsMin}..${opts.loopsMax})`);
  console.log(`Qty per tx   : ${opts.qtyMin}..${opts.qtyMax}`);
  console.log(`Delay        : ${fmtMs(opts.delayMin)}..${fmtMs(opts.delayMax)} between tx`);
  console.log(`Post-buy wait: ${fmtMs(opts.postBuyDelay)} before open`);
  console.log(`RPC          : ${RPC_URL}`);

  console.log('\n[setup] Login');
  await client.login();

  console.log('[setup] Fetch token details');
  const det = await client.get(`/api/v1/tokens/${opts.tokenId}`);
  if (!det.ok || !det.data?.success) {
    console.error('Failed to fetch token details:', det.data);
    process.exit(2);
  }
  const tok = det.data.data;
  const campaign = tok.campaign;
  console.log(`   Token      : ${tok.token.name} (${tok.token.ticker})`);
  console.log(`   OnChainId  : ${tok.onChainId}`);
  console.log(`   Campaign   : ${campaign?.id} status=${campaign?.status} index=${campaign?.campaignIndex}`);
  console.log(`   Box price  : ${campaign?.boxValueSOL} SOL (~$${campaign?.boxValueUSD})`);

  if (campaign?.status !== 'BOX_OFFERING') {
    console.warn(`   WARNING: campaign status is "${campaign?.status}".`);
  }

  const conn = new Connection(RPC_URL, 'confirmed');

  let totalBought = 0;
  let totalOpened = 0;
  let totalTxOk = 0;
  let totalTxFail = 0;
  const boxValueSOL = parseFloat(campaign?.boxValueSOL ?? '0');
  const startTs = Date.now();

  for (let i = 1; i <= loops; i++) {
    const qty = randInt(opts.qtyMin, opts.qtyMax);
    const header = `\n[${i}/${loops}] buy qty=${qty}`;
    console.log(header);
    try {
      const buyRes = await doBuyOne({
        conn,
        kp,
        client,
        tok,
        quantity: qty,
        send: opts.send,
      });
      if (!buyRes.ok) {
        totalTxFail++;
        console.log(`   ❌ buy failed: ${JSON.stringify(buyRes.err)}`);
        if (buyRes.logs) {
          for (const l of buyRes.logs.slice(0, 6)) console.log('     ' + l);
        }
      } else {
        totalTxOk++;
        totalBought += qty;
        if (buyRes.simulated) {
          console.log(`   ✓ simulated OK (nonce was ${buyRes.nonce})`);
        } else {
          console.log(`   ✓ confirmed  nonce=${buyRes.nonce}  sig=${buyRes.sig}`);
        }
      }

      // Open boxes (only when actually sent, not simulated)
      if (opts.open && buyRes.ok && !buyRes.simulated) {
        if (opts.postBuyDelay > 0) {
          console.log(`   (waiting ${fmtMs(opts.postBuyDelay)} before open…)`);
          await sleep(opts.postBuyDelay);
        }
        // Chunk into MAX_PER_OPEN calls
        let remaining = qty;
        while (remaining > 0) {
          const c = Math.min(remaining, MAX_PER_OPEN);
          const openRes = await doOpen({ client, tokenId: opts.tokenId, count: c });
          if (openRes.ok) {
            totalOpened += c;
            const summary =
              openRes.data?.data && Array.isArray(openRes.data.data)
                ? `items=${openRes.data.data.length}`
                : openRes.data?.success
                  ? 'success'
                  : JSON.stringify(openRes.data).slice(0, 80);
            console.log(`   ✓ opened ${c} boxes  ${summary}`);
          } else {
            console.log(
              `   ❌ open failed: status=${openRes.status}  body=${JSON.stringify(openRes.data).slice(0, 200)}`,
            );
            break;
          }
          remaining -= c;
          if (remaining > 0) await sleep(randInt(500, 1500));
        }
      } else if (opts.open && buyRes.ok && buyRes.simulated) {
        console.log('   (dry-run: skip open)');
      }
    } catch (e) {
      totalTxFail++;
      console.log(`   ❌ iteration error: ${e.message}`);
    }

    // Inter-iteration delay (skip on last)
    if (i < loops) {
      const delay = randInt(opts.delayMin, opts.delayMax);
      console.log(`   sleep ${fmtMs(delay)} before next iter`);
      await sleep(delay);
    }
  }

  const elapsed = Date.now() - startTs;
  console.log('\n=== Summary ===');
  console.log(`Iterations     : ${loops}`);
  console.log(`Tx OK          : ${totalTxOk}`);
  console.log(`Tx FAIL        : ${totalTxFail}`);
  console.log(`Total bought   : ${totalBought} boxes`);
  console.log(`Total opened   : ${totalOpened} boxes`);
  console.log(`Estimated cost : ${(totalBought * boxValueSOL).toFixed(6)} SOL`);
  console.log(`Elapsed        : ${(elapsed / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error('\nFATAL:', err?.message ?? err);
  process.exit(99);
});
