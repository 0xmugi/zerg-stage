// Test hypothesis: rate limit is per-cookie (auth_token).
// Strategy: spin, logout (clear cookies), re-login, spin again.
// If each fresh login allows 1 spin, hypothesis confirmed.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { AccountManager } from './src/account-manager.js';
import { uuidv4 } from './src/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNT = process.argv[2] || 'namcaca';
const N_ROUNDS = parseInt(process.argv[3] || '3', 10);

const am = new AccountManager(
  path.join(__dirname, 'data', 'accounts.json'),
  path.join(__dirname, 'data', 'pk.txt'),
);
am.init();
const entry = am.accounts.get(ACCOUNT);
if (!entry) throw new Error(`Account ${ACCOUNT} not found.`);
const { client } = entry;

function parseRetryAfter(body) {
  const msg = body?.error?.message || JSON.stringify(body);
  const m = String(msg).match(/(\d+)\s*s\b/i);
  return m ? Number(m[1]) : null;
}

async function spinOnce(round) {
  const t0 = Date.now();
  const res = await client.request('POST', '/api/v1/gumball/play', '', {
    'x-idempotency-key': uuidv4(),
    'content-length': '0',
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(2);
  if (res.ok) {
    console.log(`  ✅ Round ${round} spin SUCCESS · prize=${JSON.stringify(res.data?.data)} (${dt}s)`);
    return { ok: true };
  } else {
    const ra = parseRetryAfter(res.data);
    console.log(`  ❌ Round ${round} spin FAIL · status=${res.status} retry_after=${ra}s (~${ra ? (ra/3600).toFixed(2) + 'h' : '?'})`);
    return { ok: false, retryAfter: ra };
  }
}

async function preStatus(round) {
  const r = await client.get('/api/v1/gumball/status');
  const d = r.data?.data;
  console.log(`  /status round ${round}: playsRemaining=${d?.playsRemaining}/${d?.dailyLimit} isActive=${d?.isActive}`);
  return d;
}

console.log(`\n=== Testing relogin-bypass hypothesis on ${ACCOUNT} (${N_ROUNDS} rounds) ===\n`);

for (let round = 1; round <= N_ROUNDS; round++) {
  console.log(`\n--- Round ${round} ---`);
  // Force fresh session: clear cookies + login state
  client.cookies.clear();
  client._loginCooldownUntil = 0;
  client._loginInFlight = null;

  const t0 = Date.now();
  await client.login();
  console.log(`  login OK (${((Date.now() - t0) / 1000).toFixed(2)}s) · wallet=${client.walletAddress()}`);
  // Show cookie identity (last 6 chars of auth_token to confirm it's NEW each round)
  const auth = client.cookies.get('auth_token') || client.cookies.get('jwt') || '';
  console.log(`  auth_token tail: ...${auth.slice(-12)}`);

  const status = await preStatus(round);
  if (!status?.isActive || status?.playsRemaining < 1) {
    console.log('  ⚠ skipping spin — playsRemaining=0 atau inactive');
    break;
  }

  await spinOnce(round);

  // Tiny gap before next round (be polite)
  if (round < N_ROUNDS) {
    console.log(`  sleeping 5s before next round…`);
    await sleep(5000);
  }
}

console.log('\n=== TEST COMPLETE ===');
