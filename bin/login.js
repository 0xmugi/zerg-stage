import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZergClient, loadKeypair } from '../src/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const kp = loadKeypair(path.join(__dirname, '..', 'data', 'pk.txt'));
  const client = new ZergClient(kp);
  console.log(`Wallet: ${client.walletAddress()}`);

  const data = await client.login();

  console.log('\n=== VERIFY OK ===');
  console.log(JSON.stringify(data, null, 2));

  console.log('\nCookies:');
  for (const [k, v] of client.cookies) {
    console.log(`  ${k}=${v.slice(0, 80)}${v.length > 80 ? '...' : ''}`);
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(99);
});
