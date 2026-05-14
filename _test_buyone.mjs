// End-to-end simulate test: calls the actual `buyOne` function (same path
// used by autotask) with `send: false` so no SOL is spent. Confirms the
// 7-account layout + auto-retry logic both work correctly.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection } from '@solana/web3.js';
import { AccountManager } from './src/account-manager.js';
import { buyOne } from './src/actions.js';
import { config as CONFIG } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TBO_ID = process.argv[2] || '01KRBTW3VX4TKEDTZWRB66T67V'; // ZORRO

const am = new AccountManager(
  path.join(__dirname, 'data', 'accounts.json'),
  path.join(__dirname, 'data', 'pk.txt'),
);
am.init();
const { kp, client } = am.accounts.get('mugi');
await client.login();

const rpcUrl = (Array.isArray(CONFIG.rpcUrls) && CONFIG.rpcUrls[0]) || CONFIG.rpcUrl?.split(',')[0]?.trim();
const conn = new Connection(rpcUrl, 'confirmed');

const det = await client.get(`/api/v1/tokens/${TBO_ID}`);
const tok = det?.data?.data;
if (!tok) { console.error('Token detail fetch failed:', det.data); process.exit(1); }
console.log(`Token: ${tok.tboId || TBO_ID} onChainId=${tok.onChainId} campaignIdx=${tok.campaign?.campaignIndex ?? 0}`);

// Simulate 3 consecutive buyOne calls — same pattern as autotask buy loop.
for (let i = 1; i <= 3; i++) {
  console.log(`\n--- buyOne call #${i} (send=false) ---`);
  const res = await buyOne({ conn, kp, tok, quantity: 25, send: false });
  console.log(`  ok=${res.ok} nonce=${res.nonce} attempts=${res.attempts}`);
  if (!res.ok) {
    console.log(`  err=${JSON.stringify(res.err).slice(0, 200)}`);
    console.log(`  logs[last 4]:`, (res.logs || []).slice(-4));
    process.exit(1);
  }
}

console.log('\n✅ All 3 simulations passed. buyOne is healthy.');
