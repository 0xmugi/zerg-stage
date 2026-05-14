// Probe Zerg's rate-limit behavior:
//   1. For each account, login → GET /gumball/status (passive read)
//   2. Inspect headers/body for rate-limit hints
//   3. Attempt 1 POST /gumball/play (active call)
//   4. Capture full response to identify whether the limit is
//      per-account, per-IP, or shared across endpoints.
//
// Run from VPS where bot lives so we use the SAME IP that triggers limits.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountManager } from './src/account-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes('--dry'); // skip the actual /play

const am = new AccountManager(
  path.join(__dirname, 'data', 'accounts.json'),
  path.join(__dirname, 'data', 'pk.txt'),
);
am.init();

const HEADERS_OF_INTEREST = [
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-ratelimit-bucket',
  'retry-after',
  'x-cloud-trace-context',
  'x-vercel-id',
  'cf-ray',
  'server',
  'x-zerg-account',
  'x-account-tier',
  'date',
];

function dumpHeaders(h) {
  const out = {};
  for (const k of HEADERS_OF_INTEREST) {
    const v = h.get?.(k);
    if (v) out[k] = v;
  }
  // Also dump anything starting with x-ratelimit / x-rate / retry
  if (typeof h.entries === 'function') {
    for (const [k, v] of h.entries()) {
      const lk = k.toLowerCase();
      if (lk.startsWith('x-rate') || lk.startsWith('x-zerg') || lk === 'retry-after' || lk.includes('limit')) {
        out[k] = v;
      }
    }
  }
  return out;
}

async function probeAccount(name, entry) {
  console.log(`\n========== ${name} ==========`);
  const { client } = entry;

  try {
    await client.login();
    console.log(`  login OK · wallet=${client.walletAddress()}`);
  } catch (e) {
    console.log(`  login FAILED: ${e.message}`);
    return;
  }

  // 1. Status
  const status = await client.get('/api/v1/gumball/status');
  console.log(`  /gumball/status → ${status.status} ok=${status.ok}`);
  console.log(`    headers:`, dumpHeaders(status.headers));
  if (status.ok) {
    const d = status.data?.data;
    console.log(`    playsRemaining=${d?.playsRemaining}/${d?.dailyLimit}, isActive=${d?.isActive}, resetsAt=${d?.resetsAt}`);
  } else {
    console.log(`    body=${JSON.stringify(status.data).slice(0, 250)}`);
  }

  // 2. Inventory tokens — passive read (any rate-limit on broader API?)
  const inv = await client.get('/api/v1/inventory/tokens?limit=1');
  console.log(`  /inventory/tokens → ${inv.status} ok=${inv.ok}`);
  console.log(`    headers:`, dumpHeaders(inv.headers));

  // 3. Spin (skip if --dry)
  if (DRY) {
    console.log(`  /gumball/play SKIPPED (--dry)`);
    return;
  }
  const { uuidv4 } = await import('./src/client.js');
  const play = await client.request('POST', '/api/v1/gumball/play', '', {
    'x-idempotency-key': uuidv4(),
    'content-length': '0',
  });
  console.log(`  /gumball/play → ${play.status} ok=${play.ok}`);
  console.log(`    headers:`, dumpHeaders(play.headers));
  console.log(`    body=${JSON.stringify(play.data).slice(0, 400)}`);
}

const order = ['mugi', 'cecenom', 'tututlemot', 'namcaca'];
for (const name of order) {
  const entry = am.accounts.get(name);
  if (!entry) { console.log(`  (no account: ${name})`); continue; }
  await probeAccount(name, entry);
}
