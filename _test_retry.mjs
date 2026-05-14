// Test: just keep retrying spin on a locked account, see if any get through.
// Hypothesis: server is strict, all retries 429 with decreasing retry_after.
// Counter-hypothesis: maybe some retries slip through due to flaky enforcement.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { AccountManager } from './src/account-manager.js';
import { uuidv4 } from './src/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNT = process.argv[2] || 'mugi';
const N_TRIES = parseInt(process.argv[3] || '30', 10);
const GAP_SEC = parseInt(process.argv[4] || '3', 10);

const am = new AccountManager(
  path.join(__dirname, 'data', 'accounts.json'),
  path.join(__dirname, 'data', 'pk.txt'),
);
am.init();

const { client } = am.accounts.get(ACCOUNT);
client.cookies.clear();
client._loginCooldownUntil = 0;
client._loginInFlight = null;
await client.login();

const pre = await client.get('/api/v1/gumball/status');
const preD = pre.data?.data;
console.log(`[init] ${ACCOUNT}: playsRemaining=${preD?.playsRemaining}/${preD?.dailyLimit} isActive=${preD?.isActive}`);
console.log(`[init] retrying ${N_TRIES}x with ${GAP_SEC}s gap = ${(N_TRIES * GAP_SEC / 60).toFixed(1)}min total...\n`);

let successes = 0;
let failures = 0;
const retryAfters = [];

for (let i = 1; i <= N_TRIES; i++) {
  const t0 = Date.now();
  const res = await client.request('POST', '/api/v1/gumball/play', '', {
    'x-idempotency-key': uuidv4(),
    'content-length': '0',
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(2);
  const ts = new Date().toISOString();
  if (res.ok) {
    successes++;
    console.log(`[${ts}] try ${i.toString().padStart(2)}: ✅ ${JSON.stringify(res.data?.data)}`);
  } else {
    failures++;
    const msg = res.data?.error?.message || JSON.stringify(res.data);
    const m = String(msg).match(/(\d+)\s*s\b/);
    const ra = m ? Number(m[1]) : null;
    if (ra != null) retryAfters.push(ra);
    console.log(`[${ts}] try ${i.toString().padStart(2)}: ❌ ${res.status} retry_after=${ra}s (${dt}s)`);
  }
  if (i < N_TRIES) await sleep(GAP_SEC * 1000);
}

const post = await client.get('/api/v1/gumball/status');
const postD = post.data?.data;

console.log(`\n=== SUMMARY ===`);
console.log(`Successes: ${successes}/${N_TRIES}`);
console.log(`Failures:  ${failures}/${N_TRIES}`);
if (retryAfters.length) {
  const first = retryAfters[0];
  const last = retryAfters[retryAfters.length - 1];
  const elapsedSec = (N_TRIES - 1) * GAP_SEC;
  console.log(`retry_after first=${first}s, last=${last}s, decrease=${first - last}s (expected ~${elapsedSec}s if cooldown is fixed-time)`);
}
console.log(`playsRemaining: ${preD?.playsRemaining} → ${postD?.playsRemaining}`);
