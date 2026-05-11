import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { ZergClient, loadKeypair } from '../src/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BOX_ID = process.argv[2];
if (!BOX_ID) {
  console.error('Usage: node capture.js <BOX_ID>');
  process.exit(1);
}

async function main() {
  console.log('[1] Login via API to get auth_token cookie...');
  const kp = loadKeypair(path.join(__dirname, '..', 'data', 'pk.txt'));
  const client = new ZergClient(kp);
  await client.login();
  const authToken = client.cookies.get('auth_token');
  console.log(`   OK, auth_token length=${authToken?.length}`);

  console.log('[2] Launch headless browser...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  );

  await page.setCookie({
    name: 'auth_token',
    value: authToken,
    domain: '.zerg.app',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Strict',
  });

  // Collect every script URL that gets loaded + every XHR/fetch to zerg.app
  const scripts = new Set();
  const apiCalls = [];
  page.on('requestfinished', async (req) => {
    const url = req.url();
    const rt = req.resourceType();
    if (rt === 'script' && url.includes('stage.zerg.app')) scripts.add(url);
  });

  const wantedApi = (url) =>
    url.includes('api-stage.zerg.app') ||
    (url.includes('stage.zerg.app') && url.includes('/api/'));

  page.on('response', async (res) => {
    const url = res.url();
    if (!wantedApi(url)) return;
    const req = res.request();
    let responseBody = null;
    try {
      responseBody = await res.text();
    } catch {}
    apiCalls.push({
      method: req.method(),
      url,
      status: res.status(),
      requestBody: req.postData() ?? null,
      responseBody: responseBody?.slice(0, 2000) ?? null,
    });
  });

  console.log(`[3] Navigate to /tbo/details/${BOX_ID}...`);
  try {
    await page.goto(`https://stage.zerg.app/tbo/details/${BOX_ID}`, {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });
  } catch (e) {
    console.log('   goto err:', e.message);
  }
  await new Promise((r) => setTimeout(r, 8000));

  // Try to hover/click various buttons to potentially trigger more network requests
  console.log('[4] Try to trigger purchase UI...');
  try {
    // Screenshot for reference
    await page.screenshot({ path: 'page.png', fullPage: true });
  } catch (e) {
    console.log('  screenshot err:', e.message);
  }

  // Get all button texts to find the buy button
  const buttons = await page.evaluate(() => {
    const bs = Array.from(document.querySelectorAll('button'));
    return bs.map((b, i) => ({
      i,
      text: (b.innerText || b.textContent || '').trim().slice(0, 80),
      disabled: b.disabled,
      aria: b.getAttribute('aria-label') || '',
    }));
  });
  console.log('   buttons:', buttons.length);
  buttons.forEach((b) => {
    if (b.text || b.aria) {
      console.log(`   [${b.i}] ${b.disabled ? '(disabled) ' : ''}"${b.text}"${b.aria ? ' aria=' + b.aria : ''}`);
    }
  });

  // Try clicking a button that mentions buy / purchase / beli
  const buyIdx = buttons.findIndex((b) =>
    /\b(buy|purchase|beli)\b/i.test(b.text + ' ' + b.aria) && !b.disabled,
  );
  if (buyIdx >= 0) {
    console.log(`   Clicking button [${buyIdx}]`);
    try {
      await page.evaluate((i) => {
        document.querySelectorAll('button')[i]?.click();
      }, buyIdx);
      await new Promise((r) => setTimeout(r, 5000));
    } catch (e) {
      console.log('   click err:', e.message);
    }
  } else {
    console.log('   (no buy button found to click)');
  }

  // Save a snippet of page HTML to help debugging
  const html = await page.content();
  fs.writeFileSync('page-rendered.html', html);

  console.log(`\n[5] Scripts loaded (${scripts.size}):`);
  for (const s of scripts) console.log('  ', s);

  console.log(`\n[6] Zerg API calls captured (${apiCalls.length}):`);
  for (const c of apiCalls) {
    console.log(`\n  ${c.method} ${c.url} -> ${c.status}`);
    if (c.requestBody) console.log('    body :', c.requestBody.slice(0, 400));
    if (c.responseBody) console.log('    resp :', c.responseBody.slice(0, 400));
  }

  fs.writeFileSync(
    'capture.json',
    JSON.stringify({ scripts: Array.from(scripts), apiCalls }, null, 2),
  );

  await browser.close();
}

main().catch((e) => {
  console.error('Error:', e);
  process.exit(99);
});
