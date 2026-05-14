import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountManager } from './src/account-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ID = process.argv[2] || '01KRCH26AR5KK55VVM0T87XTH2';

const am = new AccountManager(path.join(__dirname, 'data', 'accounts.json'), path.join(__dirname, 'data', 'pk.txt'));
am.init();
const { client } = am.accounts.get('mugi');
await client.login();

const r = await client.get(`/api/v1/tokens/${ID}`);
console.log('status:', r.status, 'ok:', r.ok);
console.log('data:', JSON.stringify(r.data, null, 2));
