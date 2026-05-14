import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountManager } from './src/account-manager.js';
import { uuidv4 } from './src/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const am = new AccountManager(
  path.join(__dirname, 'data', 'accounts.json'),
  path.join(__dirname, 'data', 'pk.txt'),
);
am.init();

for (const name of ['mugi', 'cecenom', 'tututlemot', 'namcaca']) {
  console.log(`\n--- ${name} ---`);
  const { client } = am.accounts.get(name);
  client.cookies.clear();
  client._loginCooldownUntil = 0;
  client._loginInFlight = null;
  await client.login();
  const status = await client.get('/api/v1/gumball/status');
  const d = status.data?.data;
  console.log(`  status: playsRemaining=${d?.playsRemaining}/${d?.dailyLimit} isActive=${d?.isActive} resetsAt=${d?.resetsAt}`);

  // Try a spin (consume 1 if not rate-limited)
  const res = await client.request('POST', '/api/v1/gumball/play', '', {
    'x-idempotency-key': uuidv4(),
    'content-length': '0',
  });
  if (res.ok) {
    console.log(`  spin SUCCESS: ${JSON.stringify(res.data?.data)}`);
  } else {
    const msg = res.data?.error?.message || JSON.stringify(res.data);
    const m = String(msg).match(/(\d+)\s*s\b/);
    const ra = m ? Number(m[1]) : null;
    console.log(`  spin FAIL ${res.status}: retry_after=${ra}s (~${ra ? (ra/3600).toFixed(2) + 'h' : '?'})`);
  }
}
