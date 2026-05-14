// Spin cecenom + namcaca AGAIN — see if successful prior spin triggers cooldown
// for the next attempt within the same session.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { AccountManager } from './src/account-manager.js';
import { uuidv4 } from './src/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const am = new AccountManager(
  path.join(__dirname, 'data', 'accounts.json'),
  path.join(__dirname, 'data', 'pk.txt'),
);
am.init();

async function spin(client, label) {
  const t0 = Date.now();
  const res = await client.request('POST', '/api/v1/gumball/play', '', {
    'x-idempotency-key': uuidv4(),
    'content-length': '0',
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(2);
  if (res.ok) {
    console.log(`  ${label} ✅ ${JSON.stringify(res.data?.data)} (${dt}s)`);
    return { ok: true };
  } else {
    const msg = res.data?.error?.message || JSON.stringify(res.data);
    const m = String(msg).match(/(\d+)\s*s\b/);
    const ra = m ? Number(m[1]) : null;
    console.log(`  ${label} ❌ ${res.status} retry_after=${ra}s (~${ra ? (ra/3600).toFixed(2) + 'h' : '?'})`);
    return { ok: false, retryAfter: ra };
  }
}

async function status(client, label) {
  const r = await client.get('/api/v1/gumball/status');
  const d = r.data?.data;
  console.log(`  ${label}: playsRemaining=${d?.playsRemaining}/${d?.dailyLimit}`);
  return d;
}

for (const name of ['cecenom', 'namcaca']) {
  console.log(`\n========== ${name} ==========`);
  const { client } = am.accounts.get(name);
  client.cookies.clear();
  client._loginCooldownUntil = 0;
  client._loginInFlight = null;
  await client.login();

  // Status before
  await status(client, '[pre] status');

  // Spin attempt 1
  await spin(client, '[1] spin');

  // Status after first
  await status(client, '[post-1] status');

  // Wait 5 sec, spin again
  await sleep(5000);
  await spin(client, '[2] spin (5s gap)');

  // Status after
  await status(client, '[post-2] status');

  // Wait 30 sec, spin again
  await sleep(30000);
  await spin(client, '[3] spin (30s gap)');

  // Status after
  await status(client, '[post-3] status');
}
