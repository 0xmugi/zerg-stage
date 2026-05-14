// Probe Zerg's gumball cooldown by spinning at incremental intervals.
//
// Strategy: pick the most "virgin" account, then attempt /play at
// T+0, T+5min, T+10min, T+15min. Each subsequent attempt reveals:
//   - If 429: retry-after tells us remaining cooldown, so total cooldown
//     can be backed out (cooldown = elapsed + retry_after_remaining).
//   - If success: cooldown was ≤ elapsed.
//
// Burns up to 2 spins from daily quota of 10. Acceptable.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { AccountManager } from './src/account-manager.js';
import { uuidv4 } from './src/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNT = process.argv[2] || 'namcaca';
const INTERVALS_MIN = [0, 5, 10, 15]; // T+0, T+5, T+10, T+15 (minutes)

const am = new AccountManager(
  path.join(__dirname, 'data', 'accounts.json'),
  path.join(__dirname, 'data', 'pk.txt'),
);
am.init();
const entry = am.accounts.get(ACCOUNT);
if (!entry) throw new Error(`Account ${ACCOUNT} not found.`);
const { client } = entry;
await client.login();
console.log(`[${new Date().toISOString()}] login OK · wallet=${client.walletAddress()}`);

// Show current status BEFORE any spins.
const pre = await client.get('/api/v1/gumball/status');
const preD = pre?.data?.data;
console.log(`[${new Date().toISOString()}] PRE-status: playsRemaining=${preD?.playsRemaining}/${preD?.dailyLimit} isActive=${preD?.isActive} resetsAt=${preD?.resetsAt}`);
if (!preD?.isActive || preD?.playsRemaining < 1) {
  console.log('Account not eligible — bail.');
  process.exit(0);
}

function parseRetryAfter(body) {
  // "Rate limit exceeded. Retry after 2900s." → 2900
  const msg = body?.error?.message || body?.message || JSON.stringify(body);
  const m = String(msg).match(/(\d+)\s*s\b/i);
  return m ? Number(m[1]) : null;
}

async function spin(label) {
  const t0 = Date.now();
  const res = await client.request('POST', '/api/v1/gumball/play', '', {
    'x-idempotency-key': uuidv4(),
    'content-length': '0',
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`\n[${new Date().toISOString()}] ${label} → status=${res.status} ok=${res.ok} (${elapsed}s)`);
  if (res.ok) {
    console.log(`  ✅ success: ${JSON.stringify(res.data?.data)}`);
  } else {
    const ra = parseRetryAfter(res.data);
    console.log(`  ❌ ${JSON.stringify(res.data).slice(0, 200)}`);
    if (ra != null) console.log(`  retry_after=${ra}s (~${(ra/60).toFixed(1)} min)`);
  }
  return res;
}

const t0Wall = Date.now();
let lastSpinAt = null;

for (let i = 0; i < INTERVALS_MIN.length; i++) {
  const targetMs = t0Wall + INTERVALS_MIN[i] * 60_000;
  const waitMs = Math.max(0, targetMs - Date.now());
  if (waitMs > 0) {
    console.log(`\n[${new Date().toISOString()}] sleeping ${(waitMs / 60000).toFixed(2)} min until T+${INTERVALS_MIN[i]}min…`);
    await sleep(waitMs);
  }
  const label = `T+${INTERVALS_MIN[i]}min spin`;
  const res = await spin(label);
  if (res.ok) {
    lastSpinAt = Date.now();
    console.log(`  → spin successful at T+${INTERVALS_MIN[i]}min. Cooldown was ≤ ${INTERVALS_MIN[i]} min.`);
  } else {
    const ra = parseRetryAfter(res.data);
    if (ra != null && lastSpinAt != null) {
      const elapsedSinceLast = (Date.now() - lastSpinAt) / 1000;
      const totalCooldown = elapsedSinceLast + ra;
      console.log(`  → cooldown ≈ elapsed_since_last(${elapsedSinceLast.toFixed(0)}s) + retry_after(${ra}s) = ${totalCooldown.toFixed(0)}s (~${(totalCooldown/60).toFixed(1)} min)`);
    } else if (ra != null) {
      console.log(`  → retry_after only (no successful baseline): ${ra}s`);
    }
  }
}

// Final status
const post = await client.get('/api/v1/gumball/status');
const postD = post?.data?.data;
console.log(`\n[${new Date().toISOString()}] POST-status: playsRemaining=${postD?.playsRemaining}/${postD?.dailyLimit}`);
console.log('\n=== TEST COMPLETE ===');
