import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Connection } from '@solana/web3.js';
import { ZergClient, loadKeypair } from '../src/client.js';
import { PROGRAM_ID } from '../src/onchain.js';
import { MAX_PER_OPEN } from '../src/actions.js';
import { runJob, makePlan } from '../src/runner.js';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// All anti-bot delays + RPC URL come from config.js.
// Edit config.js kalau mau ganti default.
const RPC_URL = process.env.SOLANA_RPC_URL ?? config.rpcUrl;

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Accepts raw ULID or any URL containing one. Returns uppercase ULID or null.
function parseTokenId(input) {
  if (!input) return null;
  const m = input.match(/[0-9A-HJKMNP-TV-Z]{26}/i);
  return m ? m[0].toUpperCase() : null;
}

// makePlan() and the buy/open loop logic now live in src/runner.js (shared
// with bin/telegram-bot.js).

// ---------- prompts ----------
// rl is created lazily inside main() AFTER async network setup, so piped-stdin
// EOF doesn't close the interface before we ask.
let rl = null;

async function ask(prompt, def) {
  const label = def !== undefined && def !== '' ? `${prompt} [${def}] ` : `${prompt} `;
  const ans = (await rl.question(label)).trim();
  return ans || (def ?? '');
}

async function askInt(prompt, def, { min = 1, max = Infinity } = {}) {
  while (true) {
    const ans = await ask(prompt, String(def));
    const n = parseInt(ans, 10);
    if (!Number.isFinite(n) || n < min || n > max) {
      console.log(`  masukin angka ${min}..${max === Infinity ? '∞' : max}`);
      continue;
    }
    return n;
  }
}

async function askRange(prompt, defMin, defMax, { min = 1, max = Infinity } = {}) {
  while (true) {
    const hasDefault = defMin !== undefined && defMax !== undefined;
    const defLabel = hasDefault
      ? defMin === defMax
        ? String(defMin)
        : `${defMin}-${defMax}`
      : undefined;
    const ans = (await ask(prompt, defLabel)).trim();
    if (!ans) {
      console.log('  ga boleh kosong, masukin angka (atau range "5-25")');
      continue;
    }
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(ans);
    if (!m) {
      console.log('  format salah, contoh: 25 atau 5-25');
      continue;
    }
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    if (a < min || b > max) {
      console.log(`  harus ${min}..${max === Infinity ? '∞' : max}`);
      continue;
    }
    if (b < a) {
      console.log('  angka kedua harus >= angka pertama');
      continue;
    }
    return { min: a, max: b };
  }
}

async function askYN(prompt, defY = true) {
  const def = defY ? 'Y/n' : 'y/N';
  const ans = (await rl.question(`${prompt} [${def}] `)).trim().toLowerCase();
  if (!ans) return defY;
  return ans.startsWith('y');
}

// ---------- main ----------
async function main() {
  console.log('=== Zerg Buy & Open Bot (interactive) ===');

  const kp = loadKeypair(path.join(__dirname, '..', 'data', 'pk.txt'));
  const client = new ZergClient(kp);
  console.log(`Wallet : ${client.walletAddress()}`);
  console.log(`RPC    : ${RPC_URL}`);
  console.log(`Program: ${PROGRAM_ID.toBase58()} (devnet/stage)`);

  const conn = new Connection(RPC_URL, 'confirmed');
  const startBalance = await conn.getBalance(kp.publicKey, 'confirmed');
  console.log(`Saldo  : ${(startBalance / 1e9).toFixed(6)} SOL`);
  if (startBalance < 5_000_000) {
    console.log('⚠️  saldo rendah, mungkin ga cukup buat banyak tx.');
  }

  console.log('\n[login]');
  try {
    await client.login();
    console.log('  ✓ authenticated');
  } catch (e) {
    console.error('  ❌ login gagal:', e.message);
    process.exit(1);
  }

  // Create readline interface NOW (after async setup) so piped stdin EOF
  // won't close it prematurely.
  rl = readline.createInterface({ input: stdin, output: stdout });

  // --- step 0: pilih mode ---
  console.log('\nMau ngapain?');
  console.log('  1) Buy + Open  (beli box terus auto-open)');
  console.log('  2) Open only   (cuma buka box yang udah punya, tanpa beli)');
  let mode = '';
  while (mode !== '1' && mode !== '2') {
    mode = (await ask('Pilih', '1')).trim();
    if (mode !== '1' && mode !== '2') console.log('  pilih 1 atau 2');
  }
  const openOnly = mode === '2';

  // --- step 1: token types ---
  const tokenLabel = openOnly ? 'box yang mau di-open' : 'box yang mau dibeli';
  const nTokens = await askInt(`\nBerapa jenis ${tokenLabel}?`, 1, { min: 1, max: 10 });

  const tokens = [];
  for (let i = 1; i <= nTokens; i++) {
    while (true) {
      const input = await ask(`  Token ID ke-${i} (ULID atau full URL)`);
      const id = parseTokenId(input);
      if (!id) {
        console.log('    ULID ga valid (26 char Crockford base32)');
        continue;
      }
      if (tokens.some((t) => t.tokenId === id)) {
        console.log('    ID itu udah dimasukin');
        continue;
      }
      process.stdout.write(`    fetching ${id}... `);
      const det = await client.get(`/api/v1/tokens/${id}`);
      if (!det.ok || !det.data?.success) {
        console.log('❌', JSON.stringify(det.data).slice(0, 140));
        continue;
      }
      const tok = det.data.data;
      const price = tok.campaign?.boxValueSOL ?? '?';
      const usd = tok.campaign?.boxValueUSD ?? '?';
      console.log(
        `✓ ${tok.token.name} (${tok.token.ticker})  ${price} SOL/box (~$${usd})  status=${tok.campaign?.status}`,
      );
      if (tok.campaign?.status !== 'BOX_OFFERING') {
        const ok = await askYN(`    ⚠️  status bukan BOX_OFFERING. Tetap pakai?`, false);
        if (!ok) continue;
      }
      tokens.push({ tokenId: id, data: tok });
      break;
    }
  }

  // --- step 2: quantities, loops ---
  // Default range diambil dari config.js (defaultQtyPerTx).
  // User bisa override di prompt, atau Enter langsung pakai default.
  const qtyPrompt = openOnly
    ? '\nBerapa box per call open? (max 25, contoh: 25 atau 10-25)'
    : '\nQty per tx? (max 25, contoh: 25 atau 10-25)';
  const qty = await askRange(
    qtyPrompt,
    config.defaultQtyPerTx.min,
    config.defaultQtyPerTx.max,
    { min: 1, max: MAX_PER_OPEN },
  );

  const loopsLabel = tokens.length > 1
    ? 'Berapa kali loop PER token?'
    : 'Berapa kali loop?';
  // Default loops dari config.js. Set null di config kalau wajib isi.
  const loopsDefault = config.defaultLoopsPerToken;
  const loopsPerToken = await askRange(
    loopsLabel,
    loopsDefault ?? undefined,
    loopsDefault ?? undefined,
    { min: 1, max: Infinity },
  );

  // --- step 3: open toggle (skip in open-only mode) ---
  const autoOpen = openOnly
    ? true
    : await askYN('\nAuto-open box setelah beli?', true);

  // --- delays from config.js ---
  const delaySec = config.delayBetweenTx;
  const postBuy = config.delayBeforeOpen;
  const interTokenSec = config.delayBetweenTokens;
  const longPauseProb = config.coffeeBreak.prob;
  const longPauseSec = {
    min: config.coffeeBreak.min,
    max: config.coffeeBreak.max,
  };
  const openChunkDelay = config.delayBetweenOpenChunks;

  // --- preview ---
  const actualLoopsPerToken = randInt(loopsPerToken.min, loopsPerToken.max);
  const { plan, order } = makePlan(
    tokens.map((t) => t.tokenId),
    actualLoopsPerToken,
  );
  const tokenMap = new Map(tokens.map((t) => [t.tokenId, t]));
  const totalIters = plan.length;

  const avgQty = (qty.min + qty.max) / 2;
  let estCost = 0;
  for (const step of plan) {
    const t = tokenMap.get(step.tokenId);
    estCost += avgQty * parseFloat(t.data.campaign?.boxValueSOL ?? '0');
  }

  const orderTickers = order
    .map((id) => tokenMap.get(id).data.token.ticker)
    .join(' → ');

  console.log('\n=== Ringkasan ===');
  console.log(`Mode         : ${openOnly ? 'OPEN ONLY (ga beli, cuma buka box yg udah punya)' : 'BUY + OPEN'}`);
  console.log(`Wallet       : ${client.walletAddress()}`);
  console.log(`Saldo saat ini: ${(startBalance / 1e9).toFixed(6)} SOL`);
  console.log(`Token types  : ${tokens.length}`);
  for (const t of tokens) {
    const count = plan.filter((s) => s.tokenId === t.tokenId).length;
    console.log(
      `  - ${t.data.token.name.padEnd(14)} (${t.data.token.ticker.padEnd(6)})  ${count}x  @ ${t.data.campaign?.boxValueSOL} SOL/box`,
    );
  }
  console.log(
    `Loops/token  : ${actualLoopsPerToken}${loopsPerToken.min !== loopsPerToken.max ? `  (random dari range ${loopsPerToken.min}..${loopsPerToken.max})` : ''}`,
  );
  console.log(`Total iters  : ${totalIters}  (${actualLoopsPerToken} × ${tokens.length} token)`);
  if (tokens.length > 1) {
    console.log(`Urutan token : ${orderTickers}`);
  }
  console.log(
    `${openOnly ? 'Box per call ' : 'Qty per tx   '}: ${qty.min === qty.max ? qty.min : `${qty.min}-${qty.max}`} (random)`,
  );
  console.log(`Delay normal : ${delaySec.min}-${delaySec.max}s (antar iter di token yg sama)`);
  if (tokens.length > 1) {
    console.log(
      `Inter-token  : ${interTokenSec.min}-${interTokenSec.max}s (break pas pindah ke token berikutnya)`,
    );
  }
  if (!openOnly && autoOpen) {
    console.log(
      `Post-buy wait: ${postBuy.min}-${postBuy.max}s sebelum open`,
    );
  }
  if (longPauseProb > 0) {
    console.log(
      `Coffee break : ${(longPauseProb * 100).toFixed(0)}% chance of extra ${longPauseSec.min}-${longPauseSec.max}s pause per iter`,
    );
  }
  if (!openOnly) {
    console.log(`Est. cost    : ~${estCost.toFixed(6)} SOL (pakai avg qty=${avgQty})`);
    console.log(`Auto-open    : ${autoOpen ? 'yes' : 'no'}`);
  } else {
    console.log(`Est. cost    : 0 SOL (open-only, ga ada onchain tx)`);
    const totalBoxes = avgQty * totalIters;
    console.log(`Total boxes  : ~${totalBoxes} boxes akan di-open (avg)`);
  }

  const go = await askYN('\nLanjutkan?', false);
  if (!go) {
    console.log('Batal.');
    rl.close();
    return;
  }

  rl.close();

  // --- execute via shared runner (reuse the plan we already showed) ---
  const summary = await runJob({
    conn,
    kp,
    client,
    tokens,
    qty,
    loopsPerToken: actualLoopsPerToken,
    plan,
    order,
    openOnly,
    autoOpen,
    delays: {
      betweenTx: delaySec,
      postBuy,
      interToken: interTokenSec,
      coffee: { prob: longPauseProb, min: longPauseSec.min, max: longPauseSec.max },
      openChunkDelay,
    },
    onProgress: (e) => {
      switch (e.type) {
        case 'iter-start':
          console.log(
            `\n[${e.i + 1}/${e.total}] ${e.name} (${e.ticker})  ${openOnly ? 'open' : 'qty'}=${e.qty}`,
          );
          break;
        case 'buy-ok':
          console.log(`  ✓ confirmed     nonce=${e.nonce}  sig=${e.sig}`);
          break;
        case 'buy-fail':
          console.log(`  ❌ buy failed: ${JSON.stringify(e.err)}`);
          if (e.logs) for (const l of e.logs.slice(0, 6)) console.log(`    ${l}`);
          break;
        case 'open-ok':
          console.log(`  ✓ opened ${e.count} boxes`);
          break;
        case 'open-fail':
          console.log(`  ❌ open failed: status=${e.status} body=${e.body}`);
          break;
        case 'iter-error':
          console.log(`  ❌ iter error: ${e.error}`);
          break;
        case 'sleep':
          if (e.kind === 'post-buy') {
            console.log(`  (wait ${fmtMs(e.durationMs)} before open)`);
          } else if (e.kind === 'inter-token') {
            const coffee = e.coffeeExtraMs > 0
              ? ` (☕ coffee +${fmtMs(e.coffeeExtraMs)})`
              : '';
            console.log(`  🔄 pindah ke ${e.nextTicker}: break ${fmtMs(e.durationMs)}${coffee}`);
          } else if (e.kind === 'normal') {
            if (e.coffeeExtraMs > 0) {
              console.log(`  ☕ coffee break: sleep ${fmtMs(e.durationMs)} (extra +${fmtMs(e.coffeeExtraMs)})`);
            } else {
              console.log(`  sleep ${fmtMs(e.durationMs)} sebelum iter berikut`);
            }
          }
          break;
      }
    },
  });

  console.log('\n=== Summary ===');
  console.log(`Iterations  : ${summary.totalIters}  (${actualLoopsPerToken}/token × ${tokens.length})`);
  console.log(`Tx OK/FAIL  : ${summary.txOk} / ${summary.txFail}`);
  console.log(`Bought total: ${summary.totalBought} boxes`);
  console.log(`Opened total: ${summary.totalOpened} boxes`);
  for (const t of summary.perToken) {
    console.log(`  - ${t.ticker.padEnd(6)}  bought=${t.bought}  opened=${t.opened}`);
  }
  console.log(`Elapsed     : ${(summary.elapsedMs / 1000).toFixed(1)}s`);
  if (summary.spentLamports != null) {
    const spent = summary.spentLamports / 1e9;
    const bal = (summary.endBalanceLamports ?? 0) / 1e9;
    console.log(`Spent       : ${spent.toFixed(6)} SOL  (saldo sekarang ${bal.toFixed(6)} SOL)`);
  }
}

main().catch((e) => {
  console.error('\nFATAL:', e?.message ?? e);
  process.exit(99);
});
