// Hunt the token with prefix "01KRCH26" across multiple endpoints + pages.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountManager } from './src/account-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PREFIX = process.argv[2] || '01KRCH26';

const am = new AccountManager(
  path.join(__dirname, 'data', 'accounts.json'),
  path.join(__dirname, 'data', 'pk.txt'),
);
am.init();
const { client } = am.accounts.get('mugi');
await client.login();
console.log('logged in as', client.walletAddress());

async function hit(path) {
  try {
    const res = await client.get(path);
    return res;
  } catch (e) {
    return { status: 0, ok: false, data: { error: e.message } };
  }
}

// 1. Offerings with all filters, many pages.
const filters = ['TRENDING', 'NEW', 'ENDING_SOON', 'FINISHED', 'FINALIZED', 'ALL', 'COMPLETED'];
for (const f of filters) {
  for (let page = 1; page <= 5; page++) {
    const res = await hit(`/api/v1/tokens/offerings?filter=${f}&page=${page}&limit=100`);
    if (!res.ok || !res.data?.success) { if (page === 1) console.log(`  /offerings?filter=${f} page=1 ✗ status=${res.status}`); break; }
    const items = res.data.data?.items ?? [];
    const total = res.data.data?.totalItems ?? items.length;
    const hit_ = items.find((t) => (t.tboId || '').toUpperCase().startsWith(PREFIX.toUpperCase()));
    console.log(`  /offerings?filter=${f}&page=${page}: ${items.length}/${total} items${hit_ ? ' 🎯 HIT' : ''}`);
    if (hit_) {
      console.log(`    → tboId=${hit_.tboId}  name=${hit_.tokenName}  type=${hit_.offeringType}  boxesSold=${hit_.boxesSold}/${hit_.totalBoxes}`);
      break;
    }
    if (items.length < 100) break;
  }
}

// 2. User inventory / purchased.
console.log('\n-- inventory/purchased --');
for (const p of [
  '/api/v1/inventory/tokens',
  '/api/v1/inventory/boxes',
  '/api/v1/inventory/tbos',
  '/api/v1/users/me/purchases',
  '/api/v1/purchases',
]) {
  const res = await hit(p);
  if (!res.ok) { console.log(`  ${p} ✗ ${res.status}`); continue; }
  const items = res.data?.data?.items || res.data?.data || res.data?.items || [];
  const arr = Array.isArray(items) ? items : [];
  const hit_ = arr.find((t) => {
    const tid = t.tboId || t.tokenId || t.id || '';
    return (tid || '').toUpperCase().startsWith(PREFIX.toUpperCase());
  });
  console.log(`  ${p}: ${arr.length} items${hit_ ? ' 🎯 HIT' : ''}`);
  if (arr.length) {
    for (const s of arr.slice(0, 3)) console.log(`    sample: ${JSON.stringify(s).slice(0, 200)}`);
  }
}

// 3. Try direct /tokens/{prefix} with padding.
console.log('\n-- direct /tokens/{id} --');
for (const t of [PREFIX, PREFIX.padEnd(26, '0'), PREFIX + 'XXXXXXXXXXXXXXXXX'.slice(0, 26 - PREFIX.length)]) {
  const res = await hit(`/api/v1/tokens/${t}`);
  console.log(`  /tokens/${t}: status=${res.status} ok=${res.ok}`);
  if (res.data && res.ok) console.log(`    data.tboId=${res.data?.data?.tboId}`);
}
