// Quick dump of offerings endpoint to figure out the token listing shape.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountManager } from './src/account-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const am = new AccountManager(
  path.join(__dirname, 'data', 'accounts.json'),
  path.join(__dirname, 'data', 'pk.txt'),
);
am.init();
const { client } = am.accounts.get('mugi');
await client.login();
console.log('logged in as', client.walletAddress());

const paths = [
  '/api/v1/tokens/offerings?filter=TRENDING&page=1&limit=50',
  '/api/v1/tokens/offerings?filter=NEW&page=1&limit=50',
  '/api/v1/tokens/offerings?page=1&limit=50',
  '/api/v1/tokens/offerings',
  '/api/v1/tokens/list',
];
for (const p of paths) {
  const res = await client.get(p);
  const head = JSON.stringify(res.data).slice(0, 600);
  console.log(`\n=== ${p} ===`);
  console.log(`  status=${res.status} ok=${res.ok}`);
  console.log(`  data=${head}`);
}
