import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Connection,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { ZergClient, loadKeypair } from '../src/client.js';
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

function usage() {
  console.error('Usage: node buy-box.js <TOKEN_ID> [--send] [--quantity N]');
  console.error('');
  console.error('  <TOKEN_ID>    ULID from URL /tbo/details/<TOKEN_ID>');
  console.error('  --send        Actually submit the transaction (default: dry-run)');
  console.error('  --quantity N  How many boxes to buy (default 1, max 25)');
  console.error('');
  console.error('Examples:');
  console.error('  node buy-box.js 01KQVHE4PMAW0A7KAM59430YPQ                 # dry-run, 1 box');
  console.error('  node buy-box.js 01KQVHE4PMAW0A7KAM59430YPQ --send -n 3     # buy 3 boxes');
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  if (!args.length) usage();
  const opts = { send: false, quantity: 1, tokenId: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--send') opts.send = true;
    else if (a === '--dry-run') opts.send = false;
    else if (a === '--quantity' || a === '-n') {
      opts.quantity = parseInt(args[++i], 10) || 1;
    } else if (!a.startsWith('-') && !opts.tokenId) {
      opts.tokenId = a;
    } else usage();
  }
  if (!opts.tokenId) usage();
  if (opts.quantity < 1) {
    console.error('quantity must be >= 1');
    process.exit(1);
  }
  return opts;
}

async function main() {
  const { tokenId, send, quantity } = parseArgs();
  const kp = loadKeypair(path.join(__dirname, '..', 'data', 'pk.txt'));
  const client = new ZergClient(kp);

  console.log(`Wallet   : ${client.walletAddress()}`);
  console.log(`Token ID : ${tokenId}`);
  console.log(`Quantity : ${quantity}`);
  console.log(`Mode     : ${send ? 'SEND' : 'DRY-RUN'}`);
  console.log(`RPC      : ${RPC_URL}`);
  console.log(`Program  : ${PROGRAM_ID.toBase58()}`);

  console.log('\n[1] Login');
  const loginData = await client.login();
  console.log('   OK:', loginData);

  console.log('\n[2] Fetch token/campaign details');
  const det = await client.get(`/api/v1/tokens/${tokenId}`);
  if (!det.ok || !det.data?.success) {
    console.error('   Failed to fetch token details:', det.data);
    process.exit(2);
  }
  const tok = det.data.data;
  const campaign = tok.campaign;
  if (!tok.onChainId) {
    console.error('   Missing onChainId in response');
    process.exit(2);
  }
  console.log(`   Token         : ${tok.token.name} (${tok.token.ticker})`);
  console.log(`   OnChainId     : ${tok.onChainId}`);
  console.log(`   Campaign      : ${campaign?.id} (index=${campaign?.campaignIndex}, status=${campaign?.status})`);
  console.log(`   Box price     : ${campaign?.boxValueSOL} SOL  (~$${campaign?.boxValueUSD})`);
  console.log(`   Step          : ${tok.step}`);

  if (campaign?.status !== 'BOX_OFFERING') {
    console.warn(`   WARNING: campaign status is "${campaign?.status}" (expected BOX_OFFERING).`);
  }

  console.log('\n[3] Derive PDAs + read nonce');
  const conn = new Connection(RPC_URL, 'confirmed');
  const onChainId = BigInt(tok.onChainId);
  const campaignIndex = BigInt(campaign?.campaignIndex ?? 0);
  const signer = kp.publicKey;

  const { userTboPurchases } = derivePurchasePdas({
    onChainId,
    campaignIndex,
    signer,
    nonce: 0n,
  });
  const nonce = await readUserTotalPurchased(conn, userTboPurchases);
  console.log(`   nonce (totalPurchased): ${nonce}`);

  const { ix, pdas, data } = buildPurchaseIx({
    onChainId,
    campaignIndex,
    quantity: BigInt(quantity),
    nonce,
    signer,
  });

  for (const [k, v] of Object.entries(pdas)) {
    console.log(`   ${k.padEnd(24)} : ${v.toBase58()}`);
  }

  console.log('\n[4] Build transaction');
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: signer,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([kp]);

  console.log(`   blockhash          : ${blockhash}`);
  console.log(`   instruction data   : ${data.length}B (${data.toString('hex')})`);
  console.log(`   estimated cost     : ${quantity * parseFloat(campaign?.boxValueSOL ?? '0')} SOL`);

  if (!send) {
    console.log('\n[DRY-RUN] Skipping send. Re-run with --send to actually submit.');
    console.log('\n[Simulate]');
    try {
      const sim = await conn.simulateTransaction(tx, { commitment: 'confirmed' });
      if (sim.value.err) {
        console.log(`   simulation error: ${JSON.stringify(sim.value.err)}`);
        if (sim.value.logs) {
          for (const l of sim.value.logs) console.log('     ' + l);
        }
      } else {
        console.log('   simulation OK');
        if (sim.value.logs) {
          for (const l of sim.value.logs.slice(0, 8)) console.log('     ' + l);
        }
      }
    } catch (e) {
      console.log('   simulate exception:', e.message);
    }
    return;
  }

  console.log('\n[5] Send transaction');
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 10,
    preflightCommitment: 'confirmed',
  });
  console.log(`   Signature: ${sig}`);
  console.log(`   Solscan  : https://solscan.io/tx/${sig}?cluster=devnet`);

  console.log('\n[6] Confirming...');
  const conf = await conn.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  if (conf.value.err) {
    console.error('   Tx error:', conf.value.err);
    process.exit(5);
  }
  console.log('   Confirmed!');
}

main().catch((err) => {
  console.error('\nError:', err?.message ?? err);
  if (err?.logs) {
    console.error('Logs:');
    for (const l of err.logs) console.error('  ', l);
  }
  process.exit(99);
});
