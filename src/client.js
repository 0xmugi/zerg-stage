import fs from 'node:fs';
import crypto from 'node:crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { Keypair } from '@solana/web3.js';

export const API_BASE = 'https://api-stage.zerg.app';
export const ORIGIN = 'https://stage.zerg.app';

export const BASE_HEADERS = {
  'accept': 'application/json',
  'accept-language': 'en-US,en;q=0.7',
  'content-type': 'application/json',
  'origin': ORIGIN,
  'priority': 'u=1, i',
  'referer': `${ORIGIN}/`,
  'sec-ch-ua': '"Brave";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-site',
  'sec-gpc': '1',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  'x-frontend-key': 'Zerg-Frontend/1.0',
};

export function loadKeypair(pkPath) {
  const raw = fs.readFileSync(pkPath, 'utf8').trim();
  const secret = bs58.decode(raw);
  if (secret.length === 64) return Keypair.fromSecretKey(secret);
  if (secret.length === 32) return Keypair.fromSeed(secret);
  throw new Error(
    `Unexpected private key size: ${secret.length} bytes (expected 32 or 64)`,
  );
}

export function uuidv4() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export class ZergClient {
  constructor(keypair) {
    this.keypair = keypair;
    this.cookies = new Map();
    // Single-flight login: kalau ada login() yg lagi jalan, semua caller
    // share Promise yg sama (gak fire login paralel).
    this._loginInFlight = null;
    // Login cooldown: setelah fail, jangan retry lagi sampai timestamp ini.
    // Mencegah spam ke nonce endpoint pas API outage.
    this._loginCooldownUntil = 0;
  }

  walletAddress() {
    return this.keypair.publicKey.toBase58();
  }

  mergeSetCookies(arr) {
    if (!arr || !arr.length) return;
    for (const c of arr) {
      const [kv] = c.split(';');
      const idx = kv.indexOf('=');
      if (idx < 0) continue;
      const k = kv.slice(0, idx).trim();
      const v = kv.slice(idx + 1).trim();
      this.cookies.set(k, v);
    }
  }

  cookieHeader() {
    if (!this.cookies.size) return undefined;
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  async request(method, path, body, extraHeaders = {}, _isRetry = false) {
    const headers = { ...BASE_HEADERS, ...extraHeaders };
    const cookie = this.cookieHeader();
    if (cookie) headers['cookie'] = cookie;

    const init = { method, headers };
    if (body !== undefined && body !== null) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    // Hard timeout — Node's fetch has NO default and would hang forever if
    // the server stalls. 30s is generous for healthy paths (most respond
    // <1s) but short enough that bot stays responsive during outages.
    init.signal = AbortSignal.timeout(30_000);

    let res;
    try {
      res = await fetch(`${API_BASE}${path}`, init);
    } catch (e) {
      // AbortSignal.timeout fires DOMException name="TimeoutError"; rethrow
      // with friendlier wording so upstream sees the cause clearly.
      if (e?.name === 'TimeoutError' || /aborted/i.test(e?.message ?? '')) {
        throw new Error(`HTTP timeout: ${method} ${path} (>30s)`);
      }
      throw e;
    }

    if (typeof res.headers.getSetCookie === 'function') {
      this.mergeSetCookies(res.headers.getSetCookie());
    } else {
      const sc = res.headers.get('set-cookie');
      if (sc) this.mergeSetCookies([sc]);
    }

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    // Auto re-login on 401 Unauthorized (cookie expired). Retry once.
    // Skip auth endpoints themselves to avoid loops.
    const isAuthPath =
      path === '/api/v1/auth/nonce' || path === '/api/v1/auth/verify';
    if (res.status === 401 && !_isRetry && !isAuthPath && this.keypair) {
      // Skip noisy log kalau login lagi cooldown atau in-flight (concurrent
      // 401s share 1 login attempt).
      const isFreshLogin =
        !this._loginInFlight && this._loginCooldownUntil <= Date.now();
      try {
        if (isFreshLogin) {
          console.log(`[auth] 401 on ${path} — re-login...`);
        }
        await this.login();
        return this.request(method, path, body, extraHeaders, true);
      } catch (e) {
        if (isFreshLogin) {
          console.error('[auth] re-login failed:', e.message);
        }
        // fall through with original 401 response
      }
    }

    return { status: res.status, ok: res.ok, headers: res.headers, text, data };
  }

  get(path, headers) {
    return this.request('GET', path, null, headers);
  }
  post(path, body, headers) {
    return this.request('POST', path, body, headers);
  }

  signMessage(message) {
    const bytes =
      typeof message === 'string' ? new TextEncoder().encode(message) : message;
    const sig = nacl.sign.detached(bytes, this.keypair.secretKey);
    return bs58.encode(sig);
  }

  // Public login wrapper:
  //   - Single-flight: concurrent callers share one in-flight Promise.
  //   - Cooldown: setelah fail, throw fast tanpa hit endpoint sampai cooldown habis.
  async login() {
    if (this._loginInFlight) return this._loginInFlight;

    const now = Date.now();
    if (this._loginCooldownUntil > now) {
      const remainSec = Math.ceil((this._loginCooldownUntil - now) / 1000);
      throw new Error(`login cooldown ${remainSec}s (last attempt failed)`);
    }

    this._loginInFlight = this._doLogin()
      .then((data) => {
        // Sukses → reset cooldown
        this._loginCooldownUntil = 0;
        return data;
      })
      .catch((e) => {
        // Fail → set cooldown 60s biar gak spam endpoint yg lagi down
        this._loginCooldownUntil = Date.now() + 60_000;
        throw e;
      })
      .finally(() => {
        this._loginInFlight = null;
      });
    return this._loginInFlight;
  }

  async _doLogin() {
    const walletAddress = this.walletAddress();

    const nonceRes = await this.post('/api/v1/auth/nonce', { walletAddress });
    if (!nonceRes.ok) {
      throw new Error(
        `nonce failed: ${nonceRes.status} ${JSON.stringify(nonceRes.data).slice(0, 100)}`,
      );
    }
    const nonce = nonceRes.data?.data?.nonce;
    const message =
      nonceRes.data?.data?.message ?? `Sign in to Zerg.App: ${nonce}`;
    if (!nonce) throw new Error('No nonce in response');

    const signature = this.signMessage(message);

    const verifyRes = await this.post(
      '/api/v1/auth/verify',
      { walletAddress, nonce, signature, message },
      { 'x-idempotency-key': uuidv4() },
    );
    if (!verifyRes.ok) {
      throw new Error(
        `verify failed: ${verifyRes.status} ${JSON.stringify(verifyRes.data).slice(0, 100)}`,
      );
    }
    return verifyRes.data?.data;
  }
}
