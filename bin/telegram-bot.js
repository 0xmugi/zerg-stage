// Telegram Bot front-end for Zerg buy/open jobs.
// Run: `npm run telegram` (or `node bin/telegram-bot.js`).
//
// Setup: see config.js section 8 (telegram). Need bot token from @BotFather
// and your Telegram user ID from @userinfobot.

// Force synchronous (unbuffered) stdout/stderr — when running under pm2,
// stdout is a pipe yang block-buffered (4KB). Tanpa ini, console.log dari
// dalam runner gak nongol di pm2 logs sampe buffer penuh, bikin debug susah.
if (process.stdout._handle?.setBlocking) process.stdout._handle.setBlocking(true);
if (process.stderr._handle?.setBlocking) process.stderr._handle.setBlocking(true);

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Telegraf, Markup } from 'telegraf';

import { ZergClient } from '../src/client.js';
import { AccountManager } from '../src/account-manager.js';
import { runJob, makePlan } from '../src/runner.js';
import { MAX_PER_OPEN, openBoxes, claimTokens } from '../src/actions.js';
import { setTimeout as sleepP } from 'node:timers/promises';
import { config } from '../config.js';
import { createRpcPool } from '../src/rpc-pool.js';
import { getGumballStatus, runDailyForAccount } from '../src/gumball.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// RPC pool — supports multiple URLs untuk auto-failover kalau Helius 503/429.
// Priority:
//   1. env SOLANA_RPC_URL (comma-separated)
//   2. config.rpcUrls (array, baru)
//   3. config.rpcUrl (string, backward-compat; bisa comma-separated juga)
const RPC_URLS = (
  process.env.SOLANA_RPC_URL ??
  (Array.isArray(config.rpcUrls) && config.rpcUrls.length
    ? config.rpcUrls.join(',')
    : config.rpcUrl)
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ───────────────── Sanity checks ─────────────────
if (!config.telegram?.botToken) {
  console.error(
    '❌ config.telegram.botToken kosong. Setup dulu di config.js section 8.',
  );
  process.exit(1);
}
if (!config.telegram?.allowedUserIds?.length) {
  console.error(
    '❌ config.telegram.allowedUserIds kosong. Tambahin user ID kamu di config.js.',
  );
  process.exit(1);
}

// ───────────────── Helpers ─────────────────
const fmtMs = (ms) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;

function parseTokenId(input) {
  if (!input) return null;
  const m = input.match(/[0-9A-HJKMNP-TV-Z]{26}/i);
  return m ? m[0].toUpperCase() : null;
}

function parseRange(s) {
  if (!s) return null;
  const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(String(s));
  if (!m) return null;
  const a = parseInt(m[1], 10);
  const b = m[2] ? parseInt(m[2], 10) : a;
  if (b < a) return null;
  return { min: a, max: b };
}

function fmtSol(lamports, digits = 6) {
  return (lamports / 1e9).toFixed(digits);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Truncate signature for display
const shortSig = (s) => (s ? `${s.slice(0, 8)}…${s.slice(-6)}` : '');

// Parse "30m", "2h", "1h30m", or bare number "90" (=90 minutes).
// Returns total milliseconds or null if invalid.
function parseDelayString(input) {
  const s = String(input ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  if (/^\d+$/.test(s)) return parseInt(s, 10) * 60_000; // bare = minutes
  const re = /(\d+)\s*(h|m|s)/g;
  let total = 0;
  let consumed = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const n = parseInt(m[1], 10);
    const u = m[2];
    if (u === 'h') total += n * 3_600_000;
    else if (u === 'm') total += n * 60_000;
    else if (u === 's') total += n * 1_000;
    consumed = m.index + m[0].length;
  }
  if (consumed !== s.length) return null;
  return total > 0 ? total : null;
}

// Format absolute future time "today HH:MM" or "tomorrow HH:MM" etc.
function fmtFutureTime(absMs) {
  const t = new Date(absMs);
  return t.toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

// Random integer in [min, max] inclusive.
function randInRange(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

// Sleep that resolves early if signal aborts.
function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    }
  });
}

// Returns a user-facing "busy" message if a job/auto-task is active, else null.
// Use this at command entry points (e.g. /buy, /open) to block conflicting work.
function checkBusy() {
  if (currentJob) {
    return '⚠️ Job lain lagi jalan. /stop dulu atau /status.';
  }
  if (scheduledTask) {
    if (scheduledTask.status === 'scheduled') {
      return (
        `⏰ Auto-task udah dijadwalkan (mulai ${fmtFutureTime(scheduledTask.startAtMs)}). ` +
        `/stop dulu kalau mau ganti.`
      );
    }
    if (scheduledTask.status === 'running') {
      return '🤖 Auto-task lagi jalan. /status atau /stop.';
    }
  }
  return null;
}

// Format milliseconds as "Xh Ym" / "Xm Ys" for human-friendly display.
function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// ───────────────── Accounts & API setup ─────────────────
const accounts = new AccountManager(
  path.join(__dirname, '..', 'data', 'accounts.json'),
  path.join(__dirname, '..', 'data', 'pk.txt'), // legacy migration source
);
accounts.init();

const conn = createRpcPool(RPC_URLS, 'confirmed');

if (!accounts.names().length) {
  console.error(
    '❌ Belum ada akun. Taruh private key di data/pk.txt, atau tambah via Telegram "/account add <nama>".',
  );
}

// Active account convenience accessors. Always use these - never hold stale refs.
function active() {
  const a = accounts.getActive();
  if (!a) throw new Error('Ga ada active account');
  return a;
}
const activeKp = () => active().kp;
const activeClient = () => active().client;

console.log(
  `Accounts: ${accounts.names().join(', ') || '(none)'}  active=${accounts.activeName ?? '-'}`,
);
console.log(
  `RPC pool: ${RPC_URLS.length} endpoint(s)\n  - ` +
    RPC_URLS.map((u) => u.replace(/api-key=[^&]+/i, 'api-key=***')).join('\n  - '),
);

// Login active account at startup if available
if (accounts.getActive()) {
  console.log(`Logging in "${accounts.activeName}"...`);
  try {
    await active().client.login();
    console.log(`  ✓ authenticated (${active().kp.publicKey.toBase58()})`);
  } catch (e) {
    console.error(`  ❌ login gagal: ${e.message}`);
  }
}

// Global safety nets: never crash the bot from a stray promise rejection.
// Common sources: Solana RPC 503/timeout, Telegram API hiccup, ZergClient
// transient network errors during background re-login.
process.on('unhandledRejection', (reason, promise) => {
  const msg = reason?.message ?? reason?.stack ?? String(reason);
  console.error('[unhandledRejection]', msg.slice(0, 500));
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.stack ?? err?.message ?? String(err));
});

// Refresh active account login periodically. ZergClient also auto re-logins
// on 401 for any individual request, so this is just a safety net. Login is
// single-flight + cooldowned di ZergClient, jadi bg poll yang nyebrang sama
// in-flight/cooldown gak bakal hit endpoint dua kali.
setInterval(
  () => {
    const a = accounts.getActive();
    if (!a) return;
    a.client.login().catch((e) => {
      // Suppress noisy "cooldown" message — that's expected when API outage.
      if (!/cooldown/i.test(e?.message ?? '')) {
        console.error('bg re-login:', e.message);
      }
    });
  },
  45 * 60 * 1000,
);

// ───────────────── Bot setup ─────────────────
// handlerTimeout: Infinity because a job handler (buy+open loop) can run for
// many minutes / hours. Telegraf's default 90s timeout would fire bot.catch
// with a misleading "Internal error" message while the job itself is fine.
const bot = new Telegraf(config.telegram.botToken, {
  handlerTimeout: Infinity,
});

// Auth middleware
bot.use((ctx, next) => {
  const uid = ctx.from?.id;
  if (!config.telegram.allowedUserIds.includes(uid)) {
    console.log(`[auth] reject uid=${uid} from ${ctx.from?.username}`);
    return ctx.reply('🚫 Unauthorized. Tambahin ID kamu ke config.js.');
  }
  return next();
});

// Reply keyboard — 4 category buttons that open inline sub-menus.
// Tapping a button sends the literal text so it MUST match a registered
// bot.command(). The old per-action buttons are still available by typing
// the slash command directly or via the inline sub-menus.
const MAIN_MENU = Markup.keyboard([
  ['💰 Wallet', '🎁 Trading'],
  ['🤖 Tasks', 'ℹ️ Info'],
  ['📊 Status', '⏸ Stop'],
]).resize();

// Auto-attach MAIN_MENU to every ctx.reply() unless the caller already
// provided a reply_markup (e.g. inline keyboard). This way the quick-action
// keyboard stays up-to-date without user having to /start after each code update.
bot.use((ctx, next) => {
  const origReply = ctx.reply.bind(ctx);
  ctx.reply = (text, extra) => {
    const opts = extra ?? {};
    if (opts.reply_markup) return origReply(text, opts);
    return origReply(text, { ...opts, ...MAIN_MENU });
  };
  return next();
});

// Sessions per chat (for wizard mode)
// chatId -> { state: string, data: any }
//
// Persisted to disk so wizard progress survives bot restarts (we redeploy a
// LOT during dev). Without this, a /autotask user who reached the confirm
// screen would lose their selections to a restart → "Session expired" toast.
const SESSIONS_FILE = path.join(__dirname, '..', 'data', 'sessions.json');
const _sessionsMap = new Map();

// Sets aren't JSON-serializable by default. Replacer/reviver wraps them in a
// sentinel object so we can round-trip.
function _replacer(_key, value) {
  if (value instanceof Set) return { __set: [...value] };
  return value;
}
function _reviver(_key, value) {
  if (value && typeof value === 'object' && Array.isArray(value.__set)) {
    return new Set(value.__set);
  }
  return value;
}

let _saveScheduled = false;
function _saveSessionsSoon() {
  if (_saveScheduled) return;
  _saveScheduled = true;
  // Debounce writes so rapid set/delete calls coalesce.
  setTimeout(() => {
    _saveScheduled = false;
    try {
      const obj = {};
      for (const [k, v] of _sessionsMap) obj[String(k)] = v;
      // Ensure data/ dir exists (mkdir recursive is a no-op if present).
      fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj, _replacer, 2), {
        mode: 0o600,
      });
    } catch (e) {
      console.error('[sessions] save fail:', e?.message ?? e);
    }
  }, 250);
}

function _loadSessions() {
  if (!fs.existsSync(SESSIONS_FILE)) return;
  try {
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
    if (!raw.trim()) return;
    const obj = JSON.parse(raw, _reviver);
    for (const [k, v] of Object.entries(obj)) {
      // chat.id is always a number in Telegraf; preserve type
      const id = /^-?\d+$/.test(k) ? Number(k) : k;
      _sessionsMap.set(id, v);
    }
    if (_sessionsMap.size > 0) {
      console.log(`[sessions] restored ${_sessionsMap.size} session(s) from disk`);
    }
  } catch (e) {
    console.error('[sessions] load fail:', e?.message ?? e);
  }
}
_loadSessions();

// Map-like facade so existing code (`sessions.get(...)`, `sessions.set(...)`,
// `sessions.delete(...)`, `sessions.has(...)`) keeps working unchanged.
const sessions = {
  get: (id) => _sessionsMap.get(id),
  set: (id, val) => {
    _sessionsMap.set(id, val);
    _saveSessionsSoon();
    return sessions;
  },
  delete: (id) => {
    const r = _sessionsMap.delete(id);
    _saveSessionsSoon();
    return r;
  },
  has: (id) => _sessionsMap.has(id),
  get size() {
    return _sessionsMap.size;
  },
};

// Helper for wizard callback handlers — when a callback fires but the session
// is gone (bot restarted with old persistence, or user cleared), show BOTH
// the small toast (answerCbQuery) AND a chat message explaining how to
// recover. The toast alone is easy to miss on mobile.
async function replySessionExpired(ctx, restartCmd) {
  await ctx.answerCbQuery('Session expired').catch(() => {});
  const cmdHint = restartCmd ? ` /${restartCmd} lagi ya` : ' Mulai dari /menu lagi.';
  await ctx
    .reply(
      `⚠️ <b>Session expired</b>\n` +
        `Sessi wizard hilang (biasanya karena bot di-restart).\n` +
        `Ketik${cmdHint}`,
      { parse_mode: 'HTML' },
    )
    .catch(() => {});
}

// Currently running job (only one at a time)
let currentJob = null;
// shape: {
//   ctx, chatId, msgId, abortCtrl,
//   state: { iter, total, txOk, txFail, bought, opened, currentToken, status, lastEvent },
//   summary?: object,
// }

// Currently scheduled or running auto-task (only one at a time).
// shape: {
//   chatId, accountNames: string[], tokenIds: string[],
//   loopsPerToken: number, qty: { min, max },
//   startAtMs: number,                     // when to start (epoch ms)
//   timer: ReturnType<typeof setTimeout>,  // pre-start delay timer
//   abortCtrl: AbortController,            // active during execution; abort to stop
//   status: 'scheduled' | 'running' | 'done' | 'cancelled',
//   currentAccountIdx: number,
//   results: Array<{ accountName, ok, summary?, error? }>,
// }
let scheduledTask = null;

// ───────────────── Commands ─────────────────
bot.start(async (ctx) => {
  const wallet = accounts.getActive()
    ? activeClient().walletAddress()
    : '(no account)';
  const accList = accounts.names();
  await ctx.reply(
    `👋 <b>Zerg Bot Ready</b>\n\n` +
      `Active: <b>${escapeHtml(accounts.activeName ?? '-')}</b>${accList.length > 1 ? ` (of ${accList.length})` : ''}\n` +
      `Wallet: <code>${wallet}</code>\n` +
      `Network: devnet/stage\n\n` +
      `Pakai keyboard di bawah atau ketik /help.`,
    { parse_mode: 'HTML', ...MAIN_MENU },
  );
});

const cmdHelp = async (ctx) => {
  await ctx.reply(
    `<b>📚 Commands</b>\n\n` +
      `<b>📂 Account</b>\n` +
      `<b>/accounts</b> - list semua akun (+ switch via button)\n` +
      `<b>/account add &lt;nama&gt;</b> - tambah akun baru\n` +
      `<b>/account use &lt;nama&gt;</b> - switch ke akun\n` +
      `<b>/account remove &lt;nama&gt;</b> - hapus akun\n` +
      `<b>/account rename &lt;old&gt; &lt;new&gt;</b> - rename\n\n` +
      `<b>💎 Wallet</b>\n` +
      `<b>/balance</b> - cek saldo SOL\n` +
      `<b>/profile</b> - XP, rank, breakdown\n\n` +
      `<b>🛒 Buy &amp; Open</b>\n` +
      `<b>/buy</b> - beli box baru (auto-open). Pilih dari trending.\n` +
      `<b>/buy &lt;ids&gt; [loops] [qty]</b> - quick buy\n` +
      `   contoh: <code>/buy 01KQV…ABC 10 20-25</code>\n` +
      `   multi: <code>/buy 01KQV…ABC,01KQV…XYZ 10</code>\n` +
      `<b>/open</b> - open box yg udah kamu punya (dari inventory)\n` +
      `<b>/open &lt;id&gt; &lt;count&gt;</b> - quick open by ID\n` +
      `   contoh: <code>/open 01KQV…ABC 100</code>\n\n` +
      `<b>📊 View</b>\n` +
      `<b>/tokens</b> - cek token kamu (+ claim button)\n\n` +
      `<b>🤖 Auto-task</b>\n` +
      `<b>/autotask</b> - schedule multi-account buy task (untuk tidur)\n` +
      `   pilih akun → ID token → loops → qty → delay\n` +
      `   bot bakal proses sekuensial dengan jeda anti-bot\n\n` +
      `<b>🎰 Daily</b>\n` +
      `<b>/check</b> - cek sisa spin per akun (gak burn quota)\n` +
      `<b>/daily</b> - spin gumball machine semua akun (max 10/akun/hari)\n` +
      `   pilih jeda antar akun: 5, 10, atau 15 menit\n` +
      `   multi-cycle retry: burst 30 × 2-4s, pause 5m, ulang sampe 5 cycle\n` +
      `   total per akun up to ~27m sebelum bail (token bucket Zerg)\n` +
      `   <i>kalo masih bail, /daily lagi setelah midnight UTC reset</i>\n\n` +
      `<b>📱 Menu</b>\n` +
      `<b>/menu</b> - menu kategori (Wallet/Trading/Tasks/Info)\n` +
      `   tap tombol bawah chat buat shortcut\n\n` +
      `<i>(/trending dan /boxes adalah alias untuk /buy dan /open)</i>\n\n` +
      `<b>/status</b> - status job/auto-task sekarang\n` +
      `<b>/stop</b> - cancel job/auto-task yg jalan\n` +
      `<b>/config</b> - lihat config aktif\n` +
      `<b>/login</b> - re-login ke API`,
    { parse_mode: 'HTML', ...MAIN_MENU },
  );
};
bot.command('help', cmdHelp);

const cmdBalance = async (ctx) => {
  try {
    const a = active();
    const lamports = await conn.getBalance(a.kp.publicKey, 'confirmed');
    await ctx.reply(
      `💰 <b>Balance</b>\n\n` +
        `Account: <b>${escapeHtml(accounts.activeName)}</b>\n` +
        `Wallet : <code>${a.client.walletAddress()}</code>\n` +
        `Saldo  : <b>${fmtSol(lamports)} SOL</b> (${lamports.toLocaleString()} lamports)`,
      { parse_mode: 'HTML' },
    );
  } catch (e) {
    await ctx.reply(`❌ Gagal cek saldo: ${e.message}`);
  }
};
bot.command('balance', cmdBalance);

const cmdProfile = async (ctx) => {
  try {
    const a = active();
    // Fetch XP + general profile in parallel (profile endpoint may 404, that's fine)
    const [xpRes, meRes] = await Promise.all([
      a.client.get('/api/v1/users/me/xp'),
      a.client.get('/api/v1/users/me').catch(() => ({ ok: false, data: null })),
    ]);

    if (!xpRes.ok || !xpRes.data?.success) {
      return ctx.reply(
        `❌ Gagal fetch XP: ${escapeHtml(JSON.stringify(xpRes.data).slice(0, 200))}`,
      );
    }

    const p = xpRes.data.data;
    const profile = meRes.ok ? meRes.data?.data : null;

    const fmtNum = (n) => (n ?? 0).toLocaleString('en-US');
    const wallet = a.client.walletAddress();
    const walletShort = `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;

    // XP breakdown: render as an aligned <pre> table so columns line up
    // (Telegram only honors width inside code/pre blocks).
    const total = p.totalXpEarned ?? 0;
    const pct = (n) => (total > 0 ? ((n ?? 0) / total) * 100 : 0);
    const breakdown = [
      ['Play', p.playXp],
      ['Referral', p.referralXp],
      ['Bonus', p.bonusXp],
      ['Sign-up', p.signUpXp],
    ]
      .filter(([, v]) => (v ?? 0) > 0)
      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));

    const labelW = Math.max(
      8,
      ...breakdown.map(([l]) => l.length),
    );
    const valW = Math.max(
      ...breakdown.map(([, v]) => fmtNum(v).length),
      1,
    );
    const breakdownTable = breakdown
      .map(
        ([l, v]) =>
          `${l.padEnd(labelW)}  ${fmtNum(v).padStart(valW)}  ${pct(v).toFixed(1).padStart(5)}%`,
      )
      .join('\n');

    const lines = [
      `<b>👤 Profile</b> · <i>${escapeHtml(accounts.activeName)}</i>`,
      ``,
      `<b>🏆 Season ${p.seasonNumber}</b> · Rank <b>#${p.rank ?? '?'}</b>`,
      `Total XP: <b>${fmtNum(p.totalXpEarned)}</b>`,
    ];

    if (breakdown.length) {
      lines.push(``);
      lines.push(`<b>XP Breakdown</b>`);
      lines.push(`<pre>${breakdownTable}</pre>`);
    }

    lines.push(``);
    lines.push(`<b>Account</b>`);
    lines.push(
      `Wallet: <code>${walletShort}</code>  <a href="https://solscan.io/account/${wallet}">view</a>`,
    );
    lines.push(`User ID: <code>${p.userId}</code>`);

    // Profile section — only render keys that exist
    const profileRows = [];
    if (profile?.username) {
      profileRows.push(`Username: <b>${escapeHtml(profile.username)}</b>`);
    }
    if (profile?.email) {
      profileRows.push(`Email: ${escapeHtml(profile.email)}`);
    }
    if (profile?.hasBetaAccess != null) {
      profileRows.push(`Beta access: ${profile.hasBetaAccess ? '✓' : '✗'}`);
    }
    if (profileRows.length) {
      lines.push(``);
      lines.push(`<b>Profile</b>`);
      lines.push(...profileRows);
    }

    await ctx.reply(lines.join('\n'), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  } catch (e) {
    await ctx.reply(`❌ Error: ${escapeHtml(e.message)}`);
  }
};
bot.command('profile', cmdProfile);

const cmdLogin = async (ctx) => {
  try {
    const data = await active().client.login();
    await ctx.reply(
      `✓ Logged in as <b>${escapeHtml(accounts.activeName)}</b>\n` +
        `<code>${escapeHtml(JSON.stringify(data))}</code>`,
      { parse_mode: 'HTML' },
    );
  } catch (e) {
    await ctx.reply(`❌ Login gagal: ${e.message}`);
  }
};
bot.command('login', cmdLogin);

// ───────────────── Account UI (inline buttons) ─────────────────
// Truncate a display string for inline button labels (Telegram has soft
// limits and long labels look ugly in the UI).
function shortLabel(s, max = 24) {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// Build the accounts menu content (text + inline keyboard).
// Uses INDEX in callback_data (not name) so that pathological names
// (e.g. user accidentally pasted a private key as name) don't blow past
// Telegram's 64-byte callback_data limit.
function buildAccountsMenu() {
  const names = accounts.names();
  const activeName = accounts.activeName;

  const body = names.length
    ? names
        .map((n) => {
          const a = accounts.get(n);
          const mark = n === activeName ? '▶' : '  ';
          const display = shortLabel(n, 30);
          return `${mark} <b>${escapeHtml(display)}</b>\n    <code>${a.kp.publicKey.toBase58()}</code>`;
        })
        .join('\n\n')
    : '<i>Belum ada akun.</i>';

  const rows = [];
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    const row = [];
    if (n !== activeName) {
      row.push(Markup.button.callback(`▶ Use ${shortLabel(n, 16)}`, `acc:use:${i}`));
    } else {
      row.push(Markup.button.callback(`✓ ${shortLabel(n, 16)} (active)`, 'acc:noop'));
    }
    row.push(Markup.button.callback('🗑', `acc:rm:${i}`));
    rows.push(row);
  }
  rows.push([
    Markup.button.callback('➕ Add', 'acc:add'),
    Markup.button.callback('✏️ Rename', 'acc:rn'),
  ]);
  rows.push([Markup.button.callback('❌ Close', 'acc:close')]);

  return {
    text: `<b>👥 Accounts</b>\n\n${body}\n\n<i>▶ = active</i>`,
    markup: Markup.inlineKeyboard(rows),
  };
}

// Render menu: either as a new reply (for /accounts command) or edit-in-place
// (when navigating inside inline keyboard).
async function renderAccountsMenu(ctx, { edit = false } = {}) {
  const { text, markup } = buildAccountsMenu();
  if (edit) {
    await ctx
      .editMessageText(text, { parse_mode: 'HTML', ...markup })
      .catch(() => {
        // If edit fails (e.g. not modified or message deleted), send new.
        return ctx.reply(text, { parse_mode: 'HTML', ...markup });
      });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', ...markup });
  }
}

// Keep the /accounts command as an entry point.
bot.command('accounts', (ctx) => renderAccountsMenu(ctx, { edit: false }));

// Legacy /account <action> <name> still works as a text shortcut.
bot.command('account', async (ctx) => {
  const args = ctx.message.text.trim().split(/\s+/).slice(1);
  // No args -> just show the menu
  if (!args.length) return renderAccountsMenu(ctx, { edit: false });

  const [action, ...rest] = args;
  const name = rest.join(' ').trim();

  if (action === 'list' || action === 'ls') {
    return renderAccountsMenu(ctx, { edit: false });
  }
  if (action === 'add') {
    if (!name) return ctx.reply('Format: <code>/account add &lt;nama&gt;</code>', { parse_mode: 'HTML' });
    if (/\s/.test(name)) return ctx.reply('Nama ga boleh pake spasi.');
    if (accounts.has(name)) return ctx.reply(`Akun "${name}" udah ada.`);
    sessions.set(ctx.chat.id, { state: 'wait-privkey', data: { name } });
    return ctx.reply(
      `Kirim <b>private key</b> (bs58) untuk akun <b>${escapeHtml(name)}</b>.\n\n` +
        `⚠️ Message dengan key bakal <b>auto-delete</b> setelah disimpen.\n\n` +
        `/cancel buat batalin.`,
      { parse_mode: 'HTML' },
    );
  }
  if (action === 'use') {
    if (!name || !accounts.has(name)) return ctx.reply(`Akun "${name}" ga ada.`);
    return doSwitchAccount(ctx, name, { viaMenu: false });
  }
  if (action === 'remove' || action === 'rm' || action === 'delete') {
    if (!name || !accounts.has(name)) return ctx.reply(`Akun "${name}" ga ada.`);
    return doRemoveAccount(ctx, name, { viaMenu: false });
  }
  if (action === 'rename') {
    const [oldN, newN] = rest;
    if (!oldN || !newN) {
      return ctx.reply(
        'Format: <code>/account rename &lt;oldName&gt; &lt;newName&gt;</code>',
        { parse_mode: 'HTML' },
      );
    }
    try {
      accounts.rename(oldN, newN);
      return ctx.reply(`✓ ${oldN} → ${newN}`);
    } catch (e) {
      return ctx.reply(`❌ ${escapeHtml(e.message)}`);
    }
  }
  await ctx.reply(
    'Actions: <code>list | add | use | remove | rename</code>\nAtau pakai tombol: /accounts',
    { parse_mode: 'HTML' },
  );
});

// Shared switch-account logic
async function doSwitchAccount(ctx, name, { viaMenu }) {
  if (currentJob) {
    if (viaMenu) await ctx.answerCbQuery('Job lagi jalan, /stop dulu');
    else await ctx.reply('⚠️ Job lagi jalan, /stop dulu.');
    return;
  }
  if (!accounts.has(name)) {
    if (viaMenu) await ctx.answerCbQuery('Akun ga ada');
    else await ctx.reply(`Akun "${name}" ga ada.`);
    return;
  }
  try {
    accounts.setActive(name);
    try {
      await active().client.login();
    } catch {}
    if (viaMenu) {
      await ctx.answerCbQuery(`✓ Active: ${name}`);
      await renderAccountsMenu(ctx, { edit: true });
    } else {
      await ctx.reply(
        `✓ Active: <b>${escapeHtml(name)}</b>\n<code>${active().kp.publicKey.toBase58()}</code>`,
        { parse_mode: 'HTML' },
      );
    }
  } catch (e) {
    if (viaMenu) await ctx.answerCbQuery(`❌ ${e.message.slice(0, 50)}`);
    else await ctx.reply(`❌ ${escapeHtml(e.message)}`);
  }
}

async function doRemoveAccount(ctx, name, { viaMenu }) {
  if (!accounts.has(name)) {
    if (viaMenu) await ctx.answerCbQuery('Akun ga ada');
    else await ctx.reply(`Akun "${name}" ga ada.`);
    return;
  }
  if (currentJob && accounts.activeName === name) {
    if (viaMenu) await ctx.answerCbQuery('Ga bisa hapus akun aktif, job jalan');
    else await ctx.reply('⚠️ Ga bisa hapus akun aktif yg lagi jalanin job.');
    return;
  }
  try {
    accounts.remove(name);
    if (viaMenu) {
      await ctx.answerCbQuery(`✓ Removed ${name}`);
      await renderAccountsMenu(ctx, { edit: true });
    } else {
      const newActive = accounts.activeName;
      await ctx.reply(
        `✓ Akun <b>${escapeHtml(name)}</b> dihapus.\n` +
          (newActive
            ? `Active sekarang: <b>${escapeHtml(newActive)}</b>`
            : '⚠️ Ga ada akun tersisa.'),
        { parse_mode: 'HTML' },
      );
    }
  } catch (e) {
    if (viaMenu) await ctx.answerCbQuery(`❌ ${e.message.slice(0, 50)}`);
    else await ctx.reply(`❌ ${escapeHtml(e.message)}`);
  }
}

// ───── Inline action handlers ─────
bot.action('acc:noop', (ctx) => ctx.answerCbQuery());

bot.action('acc:close', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => {});
});

bot.action('acc:back', async (ctx) => {
  await ctx.answerCbQuery();
  await renderAccountsMenu(ctx, { edit: true });
});

bot.action(/^acc:use:(\d+)$/, async (ctx) => {
  const idx = parseInt(ctx.match[1], 10);
  const name = accounts.nameAt(idx);
  if (!name) {
    await ctx.answerCbQuery('Akun ga ada');
    return;
  }
  await doSwitchAccount(ctx, name, { viaMenu: true });
});

bot.action(/^acc:rm:(\d+)$/, async (ctx) => {
  const idx = parseInt(ctx.match[1], 10);
  const name = accounts.nameAt(idx);
  if (!name) {
    await ctx.answerCbQuery('Akun ga ada');
    return;
  }
  await ctx.answerCbQuery();
  await ctx
    .editMessageText(
      `⚠️ Yakin hapus akun <b>${escapeHtml(shortLabel(name, 40))}</b>?\n` +
        `<code>${accounts.get(name).kp.publicKey.toBase58()}</code>\n\n` +
        `<i>Private key bakal hilang dari bot (tapi wallet-nya di blockchain masih ada).</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✓ Ya, hapus', `acc:rm-ok:${idx}`),
            Markup.button.callback('✗ Batal', 'acc:back'),
          ],
        ]),
      },
    )
    .catch(() => {});
});

bot.action(/^acc:rm-ok:(\d+)$/, async (ctx) => {
  const idx = parseInt(ctx.match[1], 10);
  const name = accounts.nameAt(idx);
  if (!name) {
    await ctx.answerCbQuery('Akun ga ada');
    return;
  }
  await doRemoveAccount(ctx, name, { viaMenu: true });
});

bot.action('acc:add', async (ctx) => {
  if (currentJob) {
    await ctx.answerCbQuery('Job lagi jalan');
    return;
  }
  sessions.set(ctx.chat.id, { state: 'wait-accname', data: {} });
  await ctx.answerCbQuery();
  await ctx.reply(
    `<b>➕ Add Account</b>\n\n` +
      `Kirim <b>nama akun</b> baru (ga boleh pake spasi).\n\n` +
      `/cancel buat batalin.`,
    { parse_mode: 'HTML' },
  );
});

bot.action('acc:rn', async (ctx) => {
  const names = accounts.names();
  if (!names.length) {
    await ctx.answerCbQuery('Ga ada akun');
    return;
  }
  await ctx.answerCbQuery();
  const buttons = names.map((n, i) => [
    Markup.button.callback(`✏️ ${shortLabel(n, 24)}`, `acc:rn-pick:${i}`),
  ]);
  buttons.push([Markup.button.callback('↩️ Back', 'acc:back')]);
  await ctx
    .editMessageText('<b>✏️ Pilih akun yg mau di-rename:</b>', {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons),
    })
    .catch(() => {});
});

bot.action(/^acc:rn-pick:(\d+)$/, async (ctx) => {
  const idx = parseInt(ctx.match[1], 10);
  const name = accounts.nameAt(idx);
  if (!name) {
    await ctx.answerCbQuery('Akun ga ada');
    return;
  }
  sessions.set(ctx.chat.id, { state: 'wait-renamenew', data: { oldName: name } });
  await ctx.answerCbQuery();
  await ctx.reply(
    `Kirim <b>nama baru</b> untuk akun <b>${escapeHtml(shortLabel(name, 30))}</b>.\n\n` +
      `/cancel buat batalin.`,
    { parse_mode: 'HTML' },
  );
});

// ───────────────── Trending picker (inline multi-select) ─────────────────
// Fetch top trending offerings (tokens currently being sold).
async function fetchTrending(client, limit = 15) {
  const res = await client.get(
    `/api/v1/tokens/offerings?filter=TRENDING&page=1&limit=${limit}`,
  );
  if (!res.ok || !res.data?.success) {
    throw new Error(
      `trending fetch failed: ${res.status} ${JSON.stringify(res.data).slice(0, 120)}`,
    );
  }
  return res.data.data?.items ?? [];
}

function buildTrendingText(items, selectedIds) {
  const lines = [
    `<b>🔥 Trending Tokens</b>`,
    '<i>Tap token buat pilih (multi-select). Tap "Lanjut" buat masuk ke wizard buy+open.</i>',
    '',
  ];
  for (let i = 0; i < items.length; i++) {
    const t = items[i];
    const mark = selectedIds.has(t.tboId) ? '✅' : '☐';
    const pct =
      t.totalBoxes > 0
        ? Math.min(100, Math.round((t.boxesSold / t.totalBoxes) * 100))
        : 0;
    const hoursLeft = Math.max(
      0,
      Math.round((new Date(t.saleEndAt).getTime() - Date.now()) / 3_600_000),
    );
    const price = parseFloat(t.boxPriceSol);
    const priceStr = price < 0.001 ? price.toExponential(2) : price.toFixed(6);
    lines.push(
      `${mark} <b>${escapeHtml(t.tokenName)}</b> (${escapeHtml(t.tokenTicker)})`,
    );
    lines.push(
      `   ${priceStr} SOL · ${pct}% sold · ${hoursLeft}h left · ${escapeHtml(t.offeringType)}`,
    );
  }
  lines.push('');
  lines.push(`<b>${selectedIds.size}</b> dipilih`);
  return lines.join('\n');
}

function buildTrendingKb(items, selectedIds) {
  const rows = [];
  for (let i = 0; i < items.length; i++) {
    const t = items[i];
    const mark = selectedIds.has(t.tboId) ? '✅' : '☐';
    const price = parseFloat(t.boxPriceSol);
    const priceStr = price < 0.001 ? price.toExponential(1) : price.toFixed(5);
    const label = `${mark} ${shortLabel(t.tokenTicker, 10)} · ${priceStr} SOL`;
    rows.push([Markup.button.callback(label, `tr:t:${i}`)]);
  }
  rows.push([
    Markup.button.callback('🔄 Refresh', 'tr:r'),
    Markup.button.callback('✏️ Manual', 'tr:m'),
  ]);
  rows.push([
    Markup.button.callback(
      `✓ Lanjut${selectedIds.size ? ` (${selectedIds.size})` : ''}`,
      'tr:go',
    ),
    Markup.button.callback('❌ Cancel', 'tr:x'),
  ]);
  return Markup.inlineKeyboard(rows);
}

async function showTrendingPicker(ctx) {
  const loadingMsg = await ctx.reply('🔍 Loading trending tokens…');
  let items;
  try {
    items = await fetchTrending(active().client);
  } catch (e) {
    await ctx.telegram
      .editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        undefined,
        `❌ Gagal fetch trending: ${escapeHtml(e.message)}\n\nFallback ke manual input.`,
        { parse_mode: 'HTML' },
      )
      .catch(() => {});
    sessions.set(ctx.chat.id, { state: 'wait-tokens', data: { mode: 'buy' } });
    return ctx.reply(
      'Kirim <b>token IDs</b> (ULID, comma-separated kalo banyak) atau /cancel.',
      { parse_mode: 'HTML' },
    );
  }
  if (!items.length) {
    await ctx.telegram
      .editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        undefined,
        'Ga ada token trending sekarang. Pakai /buy &lt;id&gt; manual.',
        { parse_mode: 'HTML' },
      )
      .catch(() => {});
    return;
  }

  const selected = new Set();
  sessions.set(ctx.chat.id, {
    state: 'trending-pick',
    data: { items, selected },
  });

  await ctx.telegram
    .editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      undefined,
      buildTrendingText(items, selected),
      {
        parse_mode: 'HTML',
        ...buildTrendingKb(items, selected),
      },
    )
    .catch(async () => {
      // If edit fails (e.g. message too long), send fresh
      await ctx.reply(buildTrendingText(items, selected), {
        parse_mode: 'HTML',
        ...buildTrendingKb(items, selected),
      });
    });
}

// Toggle a token in the trending selection
bot.action(/^tr:t:(\d+)$/, async (ctx) => {
  const sess = sessions.get(ctx.chat.id);
  if (!sess || sess.state !== 'trending-pick') {
    await ctx.answerCbQuery('Session expired. /buy lagi ya');
    return;
  }
  const idx = parseInt(ctx.match[1], 10);
  const t = sess.data.items[idx];
  if (!t) {
    await ctx.answerCbQuery('Item ga ada');
    return;
  }
  if (sess.data.selected.has(t.tboId)) {
    sess.data.selected.delete(t.tboId);
    await ctx.answerCbQuery(`✗ ${t.tokenTicker}`);
  } else {
    sess.data.selected.add(t.tboId);
    await ctx.answerCbQuery(`✓ ${t.tokenTicker}`);
  }
  await ctx
    .editMessageText(
      buildTrendingText(sess.data.items, sess.data.selected),
      {
        parse_mode: 'HTML',
        ...buildTrendingKb(sess.data.items, sess.data.selected),
      },
    )
    .catch(() => {}); // ignore "not modified"
});

// Refresh trending list
bot.action('tr:r', async (ctx) => {
  const sess = sessions.get(ctx.chat.id);
  if (!sess || sess.state !== 'trending-pick') {
    await ctx.answerCbQuery('Session expired');
    return;
  }
  await ctx.answerCbQuery('🔄 Refreshing…');
  try {
    const items = await fetchTrending(active().client);
    sess.data.items = items;
    // Keep only selections still trending
    const newIds = new Set(items.map((t) => t.tboId));
    for (const id of Array.from(sess.data.selected)) {
      if (!newIds.has(id)) sess.data.selected.delete(id);
    }
    await ctx
      .editMessageText(
        buildTrendingText(items, sess.data.selected),
        {
          parse_mode: 'HTML',
          ...buildTrendingKb(items, sess.data.selected),
        },
      )
      .catch(() => {});
  } catch (e) {
    await ctx.answerCbQuery(`❌ ${e.message.slice(0, 50)}`);
  }
});

// Switch to manual ID input
bot.action('tr:m', async (ctx) => {
  const sess = sessions.get(ctx.chat.id);
  const mode = sess?.data?.mode ?? 'buy';
  sessions.set(ctx.chat.id, { state: 'wait-tokens', data: { mode } });
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await ctx.reply(
    `✏️ <b>Manual Input</b>\n\n` +
      `Kirim token ID (ULID atau URL).\n` +
      `Multi-token: pisah pake koma.\n\n` +
      `(/cancel buat batalin)`,
    { parse_mode: 'HTML' },
  );
});

// Continue with selected tokens -> jump into existing wait-loops wizard step
bot.action('tr:go', async (ctx) => {
  const sess = sessions.get(ctx.chat.id);
  if (!sess || sess.state !== 'trending-pick') {
    await ctx.answerCbQuery('Session expired');
    return;
  }
  if (!sess.data.selected.size) {
    await ctx.answerCbQuery('Pilih minimal 1 token');
    return;
  }
  const tokenIds = Array.from(sess.data.selected);
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  // Hand off to existing wait-loops state (always buy+open from trending)
  sessions.set(ctx.chat.id, {
    state: 'wait-loops',
    data: { mode: 'buy', tokenIds },
  });
  const tickers = sess.data.items
    .filter((t) => sess.data.selected.has(t.tboId))
    .map((t) => t.tokenTicker)
    .join(', ');
  await ctx.reply(
    `✓ <b>${tokenIds.length}</b> token: ${escapeHtml(tickers)}\n\n` +
      `Berapa kali loop ${tokenIds.length > 1 ? 'PER token' : ''}?\n` +
      `Kirim angka (default: ${config.defaultLoopsPerToken ?? 10})`,
    { parse_mode: 'HTML' },
  );
});

// Cancel trending picker
bot.action('tr:x', async (ctx) => {
  sessions.delete(ctx.chat.id);
  await ctx.answerCbQuery('Cancelled');
  await ctx
    .editMessageText('❌ Cancelled.', { parse_mode: 'HTML' })
    .catch(() => {});
});

// /trending - shortcut to show trending picker
bot.command('trending', async (ctx) => {
  const busy = checkBusy();
  if (busy) return ctx.reply(busy);
  return showTrendingPicker(ctx);
});

// ───────────────── Inventory: Boxes & Tokens ─────────────────
async function fetchUnopenedBoxes(client, limit = 20) {
  const res = await client.get(
    `/api/v1/inventory/unopened-boxes?page=1&limit=${limit}`,
  );
  if (!res.ok || !res.data?.success) {
    throw new Error(
      `unopened-boxes failed: ${res.status} ${JSON.stringify(res.data).slice(0, 120)}`,
    );
  }
  return res.data.data?.items ?? [];
}

async function fetchInventoryTokens(client, limit = 20) {
  const res = await client.get(
    `/api/v1/inventory/tokens?page=1&limit=${limit}`,
  );
  if (!res.ok || !res.data?.success) {
    throw new Error(
      `inventory/tokens failed: ${res.status} ${JSON.stringify(res.data).slice(0, 120)}`,
    );
  }
  return res.data.data?.items ?? [];
}

// ── Boxes picker ──
function buildBoxesText(items, selectedIds) {
  if (!items.length) {
    return '<b>📦 Unopened Boxes</b>\n\n<i>Ga ada box yg belum dibuka. /buy dulu yuk.</i>';
  }
  const lines = [
    '<b>📦 Unopened Boxes</b>',
    '<i>Tap buat pilih, multi-select OK. "Open All" = open semua box terpilih.</i>',
    '',
  ];
  let totalSelected = 0;
  for (const t of items) {
    const mark = selectedIds.has(t.tboId) ? '✅' : '☐';
    if (selectedIds.has(t.tboId)) totalSelected += t.unopenedBoxes;
    lines.push(
      `${mark} <b>${escapeHtml(t.tokenName)}</b> (${escapeHtml(t.tokenTicker)}) — ${t.unopenedBoxes} boxes`,
    );
  }
  lines.push('');
  lines.push(
    `<b>${selectedIds.size}</b> token, <b>${totalSelected}</b> box dipilih`,
  );
  return lines.join('\n');
}

function buildBoxesKb(items, selectedIds) {
  const rows = [];
  for (let i = 0; i < items.length; i++) {
    const t = items[i];
    const mark = selectedIds.has(t.tboId) ? '✅' : '☐';
    const label = `${mark} ${shortLabel(t.tokenTicker, 12)} · ${t.unopenedBoxes}`;
    rows.push([Markup.button.callback(label, `bx:t:${i}`)]);
  }
  if (items.length) {
    let total = 0;
    for (const t of items) if (selectedIds.has(t.tboId)) total += t.unopenedBoxes;
    rows.push([
      Markup.button.callback('☑️ All', 'bx:all'),
      Markup.button.callback('☐ None', 'bx:none'),
      Markup.button.callback('🔄 Refresh', 'bx:r'),
    ]);
    rows.push([
      Markup.button.callback(
        `🎁 Open All${selectedIds.size ? ` (${total} boxes)` : ''}`,
        'bx:go',
      ),
      Markup.button.callback('❌ Cancel', 'bx:x'),
    ]);
  } else {
    rows.push([
      Markup.button.callback('🔄 Refresh', 'bx:r'),
      Markup.button.callback('❌ Close', 'bx:x'),
    ]);
  }
  return Markup.inlineKeyboard(rows);
}

async function showBoxesPicker(ctx) {
  const loadingMsg = await ctx.reply('🔍 Loading unopened boxes…');
  let items;
  try {
    items = await fetchUnopenedBoxes(active().client);
  } catch (e) {
    return ctx.telegram
      .editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        undefined,
        `❌ Gagal fetch boxes: ${escapeHtml(e.message)}`,
        { parse_mode: 'HTML' },
      )
      .catch(() => {});
  }

  const selected = new Set();
  sessions.set(ctx.chat.id, {
    state: 'boxes-pick',
    data: { items, selected },
  });

  await ctx.telegram
    .editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      undefined,
      buildBoxesText(items, selected),
      { parse_mode: 'HTML', ...buildBoxesKb(items, selected) },
    )
    .catch(async () => {
      await ctx.reply(buildBoxesText(items, selected), {
        parse_mode: 'HTML',
        ...buildBoxesKb(items, selected),
      });
    });
}

// /boxes — alias for /open (no args). Kept for backward-compat / discoverability.
bot.command('boxes', async (ctx) => {
  const busy = checkBusy();
  if (busy) return ctx.reply(busy);
  return showBoxesPicker(ctx);
});

bot.action(/^bx:t:(\d+)$/, async (ctx) => {
  const sess = sessions.get(ctx.chat.id);
  if (!sess || sess.state !== 'boxes-pick') {
    await ctx.answerCbQuery('Session expired. /boxes lagi ya');
    return;
  }
  const idx = parseInt(ctx.match[1], 10);
  const t = sess.data.items[idx];
  if (!t) {
    await ctx.answerCbQuery('Item ga ada');
    return;
  }
  if (sess.data.selected.has(t.tboId)) {
    sess.data.selected.delete(t.tboId);
    await ctx.answerCbQuery(`✗ ${t.tokenTicker}`);
  } else {
    sess.data.selected.add(t.tboId);
    await ctx.answerCbQuery(`✓ ${t.tokenTicker}`);
  }
  await ctx
    .editMessageText(buildBoxesText(sess.data.items, sess.data.selected), {
      parse_mode: 'HTML',
      ...buildBoxesKb(sess.data.items, sess.data.selected),
    })
    .catch(() => {});
});

bot.action('bx:all', async (ctx) => {
  const sess = sessions.get(ctx.chat.id);
  if (!sess || sess.state !== 'boxes-pick') {
    await ctx.answerCbQuery('Session expired');
    return;
  }
  for (const t of sess.data.items) sess.data.selected.add(t.tboId);
  await ctx.answerCbQuery('✓ All');
  await ctx
    .editMessageText(buildBoxesText(sess.data.items, sess.data.selected), {
      parse_mode: 'HTML',
      ...buildBoxesKb(sess.data.items, sess.data.selected),
    })
    .catch(() => {});
});

bot.action('bx:none', async (ctx) => {
  const sess = sessions.get(ctx.chat.id);
  if (!sess || sess.state !== 'boxes-pick') {
    await ctx.answerCbQuery('Session expired');
    return;
  }
  sess.data.selected.clear();
  await ctx.answerCbQuery('✗ None');
  await ctx
    .editMessageText(buildBoxesText(sess.data.items, sess.data.selected), {
      parse_mode: 'HTML',
      ...buildBoxesKb(sess.data.items, sess.data.selected),
    })
    .catch(() => {});
});

bot.action('bx:r', async (ctx) => {
  const sess = sessions.get(ctx.chat.id);
  if (!sess) {
    await ctx.answerCbQuery('Session expired');
    return;
  }
  await ctx.answerCbQuery('🔄 Refreshing…');
  try {
    const items = await fetchUnopenedBoxes(active().client);
    sess.data.items = items;
    const newIds = new Set(items.map((t) => t.tboId));
    for (const id of Array.from(sess.data.selected)) {
      if (!newIds.has(id)) sess.data.selected.delete(id);
    }
    await ctx
      .editMessageText(buildBoxesText(items, sess.data.selected), {
        parse_mode: 'HTML',
        ...buildBoxesKb(items, sess.data.selected),
      })
      .catch(() => {});
  } catch (e) {
    await ctx.answerCbQuery(`❌ ${e.message.slice(0, 50)}`);
  }
});

bot.action('bx:x', async (ctx) => {
  sessions.delete(ctx.chat.id);
  await ctx.answerCbQuery('Cancelled');
  await ctx
    .editMessageText('❌ Cancelled.', { parse_mode: 'HTML' })
    .catch(() => {});
});

bot.action('bx:go', async (ctx) => {
  const sess = sessions.get(ctx.chat.id);
  if (!sess || sess.state !== 'boxes-pick') {
    await ctx.answerCbQuery('Session expired');
    return;
  }
  if (currentJob) {
    await ctx.answerCbQuery('Job lain lagi jalan');
    return;
  }
  if (!sess.data.selected.size) {
    await ctx.answerCbQuery('Pilih minimal 1 token');
    return;
  }
  const picks = sess.data.items.filter((t) => sess.data.selected.has(t.tboId));
  sessions.delete(ctx.chat.id);
  await ctx.answerCbQuery('🎁 Starting...');
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  // Fire-and-forget: opening many boxes can take minutes. Returning quickly
  // lets Telegraf process other commands (e.g. /status, /stop) concurrently.
  runOpenAllJob(ctx, picks).catch((e) => {
    console.error('[open-job] crash:', e);
    ctx
      .reply(`❌ Open job crash: ${escapeHtml(e?.message ?? String(e))}`)
      .catch(() => {});
  });
});

// Wrap openBoxes with retry on transient network errors (HTTP/2 stream resets,
// fetch failures, etc.). API returning {ok:false} is NOT retried — that means
// the server replied with an error which is usually a logic issue, not network.
async function openBoxesWithRetry({ client, tokenId, count }, maxAttempts = 6) {
  let lastErr;
  let firstStatus = 0;
  let interimAttempts = 0;
  const shortId = tokenId.slice(0, 8);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await openBoxes({ client, tokenId, count });
      const status = res.status;
      // Retry on rate-limit (429) atau server unavailable (5xx). Server-side
      // hiccup biasanya transient — kasih waktu recover daripada langsung fail.
      const isServerErr = status === 429 || (status >= 500 && status < 600);
      if (isServerErr && attempt < maxAttempts) {
        if (attempt === 1) {
          firstStatus = status;
          console.warn(`[open-retry] ${shortId} status=${status}, retrying…`);
        } else {
          interimAttempts++;
        }
        // 429 → 5s/10s/15s/... · 5xx → 10s/20s/30s/40s/50s
        const baseMs = status === 429 ? 5000 : 10_000;
        const delayMs = baseMs * attempt;
        await sleepP(delayMs).catch(() => {});
        continue;
      }
      // Reached here = either sukses, non-retryable error, atau retries habis.
      if (interimAttempts > 0 || firstStatus) {
        if (res.ok) {
          console.warn(
            `[open-retry] ${shortId} recovered after ${attempt} attempts (started ${firstStatus})`,
          );
        } else if (isServerErr) {
          // Final attempt masih 5xx → kasih give-up log
          console.error(
            `[open-retry] ${shortId} GAVE UP after ${attempt} attempts (last status ${status})`,
          );
        }
      }
      return res;
    } catch (e) {
      lastErr = e;
      const transient =
        /stream|timeout|ECONNRESET|ENOTFOUND|fetch failed|network|EAI_AGAIN|socket hang up/i.test(
          e?.message ?? String(e),
        );
      if (attempt === 1) {
        console.error(
          `[open-retry] ${shortId} network err: ${(e?.message ?? e).toString().slice(0, 80)}, retrying…`,
        );
      }
      if (!transient || attempt === maxAttempts) {
        if (attempt === maxAttempts) {
          console.error(
            `[open-retry] ${shortId} GAVE UP after ${attempt} network attempts`,
          );
        }
        return {
          ok: false,
          status: 0,
          data: { error: `network: ${e?.message ?? String(e)}` },
        };
      }
      // backoff: 3s/6s/9s/12s/15s
      await sleepP(3000 * attempt).catch(() => {});
    }
  }
  // Unreachable: loop has explicit return on every path. Defensive fallback.
  return {
    ok: false,
    status: firstStatus || 0,
    data: { error: `unreachable: ${lastErr?.message ?? `status ${firstStatus}`}` },
  };
}

// Resilient core: open every box in `picks` for one account.
// Reusable by /open (single account) dan /autotask open-only (multi-akun).
//
// Behaviour saat error:
//   - 409 ALL_BOXES_REVEALED → skip token, lanjut ke pick berikutnya
//   - Persistent fail di chunk yang sama → tunggu 30-60s, retry. Setelah
//     MAX_CHUNK_FAILS_PER_TOKEN gagal beruntun, skip token (bukan abort job).
//   - OUTAGE detection: kalau OUTAGE_THRESHOLD token berturut-turut skip karena
//     5xx fail (bukan all-revealed), pause job 5 menit sebelum lanjut. Mencegah
//     bot sia-sia hammering API yang lagi down extended.
//   - Abort signal → exit immediately
//
// onProgress events (semua optional, listener boleh skip):
//   { type: 'token-start', tokenIdx, ticker, total }
//   { type: 'chunk-ok',   tokenIdx, ticker, count, opened, total }
//   { type: 'chunk-retry', tokenIdx, ticker, fails, waitMs, status, errStr }
//   { type: 'token-skip', tokenIdx, ticker, reason, remaining, status, errStr }
//   { type: 'token-done', tokenIdx, ticker }
//   { type: 'outage-pause', consecutiveFails, waitMs }
//   { type: 'outage-resume' }
//
// Returns: { totalOpened, txOk, txFail, perToken: Map<tboId,{opened,total}> }
const MAX_CHUNK_FAILS_PER_TOKEN = 5;
const OUTAGE_THRESHOLD = 3; // 3 token-skip karena fail beruntun = outage signal
const OUTAGE_PAUSE_MS = 5 * 60_000; // 5 menit pause kalau outage detected

async function openAllPicks({ client, picks, signal, onProgress }) {
  const emit = (e) => {
    try {
      onProgress?.(e);
    } catch (err) {
      console.error('[openAllPicks onProgress]', err);
    }
  };

  let totalOpened = 0;
  let txOk = 0;
  let txFail = 0;
  let outageStreak = 0; // jumlah token-skip BERTURUT-TURUT karena 5xx (bukan all-revealed)
  const perToken = new Map();

  for (let i = 0; i < picks.length; i++) {
    if (signal?.aborted) break;
    const p = picks[i];
    const total = p.unopenedBoxes;
    perToken.set(p.tboId, { opened: 0, total });
    emit({ type: 'token-start', tokenIdx: i, ticker: p.tokenTicker, total });

    let remaining = total;
    let consecutiveChunkFails = 0;
    let tokenAborted = false;
    let tokenHadAnySuccess = false;

    while (remaining > 0 && !tokenAborted) {
      if (signal?.aborted) break;
      const c = Math.min(remaining, MAX_PER_OPEN);
      const r = await openBoxesWithRetry({ client, tokenId: p.tboId, count: c });

      if (r.ok) {
        totalOpened += c;
        txOk++;
        remaining -= c;
        consecutiveChunkFails = 0;
        outageStreak = 0; // any success resets outage detector
        tokenHadAnySuccess = true;
        const st = perToken.get(p.tboId);
        st.opened += c;
        emit({
          type: 'chunk-ok',
          tokenIdx: i,
          ticker: p.tokenTicker,
          count: c,
          opened: st.opened,
          total,
        });
      } else {
        txFail++;
        const errStr = JSON.stringify(r.data ?? r).slice(0, 200);
        const errCode = r.data?.error?.errorCode;
        // Single-line error log per chunk fail (openBoxesWithRetry sudah
        // log retry detail-nya, jadi disini cukup summary)
        console.error(
          `[openAllPicks] ${p.tokenTicker} chunk-fail status=${r.status}${errCode ? ` code=${errCode}` : ''}`,
        );

        // Permanent: token udah kosong di server. Skip, jangan blame seluruh job.
        if (errCode === 'ALL_BOXES_REVEALED' || r.status === 409) {
          // 409 BUKAN outage signal — token memang udah kosong (atau habis di-open
          // sama bot di run sebelumnya). Reset outage streak.
          outageStreak = 0;
          emit({
            type: 'token-skip',
            tokenIdx: i,
            ticker: p.tokenTicker,
            reason: 'all-revealed',
            remaining,
            status: r.status,
            errStr,
          });
          tokenAborted = true;
          break;
        }

        consecutiveChunkFails++;
        if (consecutiveChunkFails >= MAX_CHUNK_FAILS_PER_TOKEN) {
          // Token-skip karena 5xx persistent → outage signal kalau token ini
          // gak pernah sukses sama sekali (kalau sukses sebelumnya, mungkin
          // emang segmen tertentu yang corrupt, bukan outage).
          if (!tokenHadAnySuccess && r.status >= 500) {
            outageStreak++;
          }
          emit({
            type: 'token-skip',
            tokenIdx: i,
            ticker: p.tokenTicker,
            reason: 'too-many-fails',
            remaining,
            status: r.status,
            errStr,
          });
          tokenAborted = true;
          break;
        }

        // Transient: tunggu, retry chunk yang sama (jangan decrement remaining)
        const extraWait = 30_000 + Math.random() * 30_000; // 30-60s
        emit({
          type: 'chunk-retry',
          tokenIdx: i,
          ticker: p.tokenTicker,
          fails: consecutiveChunkFails,
          waitMs: extraWait,
          status: r.status,
          errStr,
        });
        await sleepP(extraWait, undefined, { signal }).catch(() => {});
        continue;
      }

      // Jitter antar chunk (config.delayBetweenOpenChunks dalam ms)
      if (remaining > 0) {
        const min = config.delayBetweenOpenChunks?.min ?? 500;
        const max = config.delayBetweenOpenChunks?.max ?? 1500;
        const d = min + Math.random() * (max - min);
        await sleepP(d, undefined, { signal }).catch(() => {});
      }
    }

    emit({ type: 'token-done', tokenIdx: i, ticker: p.tokenTicker });

    // Outage detection: kalau OUTAGE_THRESHOLD token berturut-turut skip karena
    // 5xx persistent fail, pause 5 menit. API kemungkinan besar lagi down,
    // gak ada gunanya keep hammering. Reset streak setelah pause biar pas
    // resume kita coba 3 token lagi sebelum pause lagi.
    if (outageStreak >= OUTAGE_THRESHOLD && i < picks.length - 1 && !signal?.aborted) {
      console.warn(
        `[openAllPicks] OUTAGE detected (${outageStreak} tokens skipped, last status 5xx). Pausing ${OUTAGE_PAUSE_MS / 60_000}min before next token.`,
      );
      emit({
        type: 'outage-pause',
        consecutiveFails: outageStreak,
        waitMs: OUTAGE_PAUSE_MS,
      });
      await sleepP(OUTAGE_PAUSE_MS, undefined, { signal }).catch(() => {});
      emit({ type: 'outage-resume' });
      outageStreak = 0; // reset, kasih kesempatan coba lagi
    } else if (i < picks.length - 1 && !signal?.aborted) {
      // Normal pause antar token
      const d = (config.delayBetweenTokens?.min ?? 5) * 1000;
      await sleepP(d, undefined, { signal }).catch(() => {});
    }
  }

  return { totalOpened, txOk, txFail, perToken };
}

// Sequential opener: open all selected items' unopenedBoxes count.
// Doesn't go through runJob (no buy + no on-chain step needed).
async function runOpenAllJob(ctx, picks) {
  const jobAccount = active();
  const jobAccountName = accounts.activeName;
  const ctrl = new AbortController();
  const totalBoxes = picks.reduce((s, p) => s + p.unopenedBoxes, 0);

  // Init per-pick counter (used by renderProgress)
  for (const p of picks) p._opened = 0;

  // Send job message via telegram API directly (bypass MAIN_MENU middleware).
  // Messages sent with reply-keyboard markup attached can hit "message can't be
  // edited" errors when trying to edit text on some Telegram clients.
  const startMsg = await ctx.telegram.sendMessage(
    ctx.chat.id,
    `🎁 <b>Opening Boxes</b>\n` +
      `Account: <b>${escapeHtml(jobAccountName)}</b>\n` +
      `Tokens: <b>${picks.length}</b> · Total boxes: <b>${totalBoxes}</b>\n\n` +
      `<i>Starting…</i>`,
    { parse_mode: 'HTML' },
  );

  const state = {
    iter: 0,
    total: picks.length,
    txOk: 0,
    txFail: 0,
    bought: 0,
    opened: 0,
    currentToken: picks[0]?.tokenTicker ?? '',
    status: 'opening',
    lastEvent: 'job-start',
  };

  currentJob = {
    chatId: ctx.chat.id,
    msgId: startMsg.message_id,
    abortCtrl: ctrl,
    state,
  };

  let pendingEdit = false;
  let lastRenderedText = '';
  let editFailures = 0;
  let renderRateLimitUntil = 0;
  let lastRenderTs = 0;
  // Latest statusLine provided by any caller during a pending render — the
  // debounce loop reads from here so a status update issued while we're
  // throttled isn't lost.
  let pendingStatusLine = null;
  const RENDER_THROTTLE_MS = 3000;
  const MAX_EDIT_FAILURES = 2;
  const buildOpenProgressText = (statusLine) => {
    const lines = [
      `🎁 <b>Opening Boxes</b>`,
      `Account: <b>${escapeHtml(jobAccountName)}</b>`,
      '',
    ];
    for (let i = 0; i < picks.length; i++) {
      const p = picks[i];
      const opened = p._opened ?? 0;
      const total = p.unopenedBoxes;
      const isCurrent = i === state.iter && state.status === 'opening';
      const mark = opened >= total ? '✓' : opened > 0 ? '◐' : '○';
      const cur = isCurrent ? ' ⏳' : '';
      lines.push(
        `${mark} <b>${escapeHtml(p.tokenTicker)}</b>: ${opened}/${total}${cur}`,
      );
    }
    lines.push('');
    lines.push(
      `<b>Progress</b>: ${state.opened}/${totalBoxes} · ✓${state.txOk} · ✗${state.txFail}`,
    );
    if (statusLine) lines.push(`<i>${escapeHtml(statusLine)}</i>`);
    return lines.join('\n');
  };
  const renderProgress = async (statusLine) => {
    if (statusLine != null) pendingStatusLine = statusLine;
    if (pendingEdit) return;
    if (Date.now() < renderRateLimitUntil) return;
    pendingEdit = true;
    try {
      // Debounce loop: keep flushing until the rendered text matches the
      // current state. Without the loop, events that fire during the edit
      // API call would be silently dropped (stale UI bug).
      while (true) {
        const wait = Math.max(0, RENDER_THROTTLE_MS - (Date.now() - lastRenderTs));
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        lastRenderTs = Date.now();
        const sl = pendingStatusLine;
        pendingStatusLine = null;
        const newText = buildOpenProgressText(sl);
        if (newText === lastRenderedText) break;
        if (editFailures >= MAX_EDIT_FAILURES) {
          if (sl) {
            await ctx.telegram
              .sendMessage(ctx.chat.id, newText, { parse_mode: 'HTML' })
              .catch(() => {});
            lastRenderedText = newText;
          }
          break;
        }
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          startMsg.message_id,
          undefined,
          newText,
          { parse_mode: 'HTML' },
        );
        lastRenderedText = newText;
        editFailures = 0;
      }
    } catch (e) {
      const msg = e?.description ?? e?.message ?? String(e);
      if (e?.response?.error_code === 429) {
        const retryAfter =
          (e.response.parameters?.retry_after ?? 60) * 1000;
        renderRateLimitUntil = Date.now() + retryAfter;
        console.warn(
          `[open-job render] 429 backoff ${(retryAfter / 1000).toFixed(0)}s`,
        );
      } else if (!/not modified/i.test(msg)) {
        editFailures++;
        console.warn(
          `[open-job render] ${msg} (failure ${editFailures}/${MAX_EDIT_FAILURES})`,
        );
      }
    } finally {
      pendingEdit = false;
    }
  };

  // Show initial state immediately so user knows the job started.
  await renderProgress();

  const skipped = []; // {ticker, reason, remaining, status, errStr}

  try {
    const result = await openAllPicks({
      client: jobAccount.client,
      picks,
      signal: ctrl.signal,
      onProgress: (e) => {
        switch (e.type) {
          case 'token-start':
            state.iter = e.tokenIdx;
            state.currentToken = e.ticker;
            state.status = 'opening';
            renderProgress();
            break;
          case 'chunk-ok': {
            state.opened += e.count;
            state.txOk++;
            const p = picks[e.tokenIdx];
            if (p) p._opened = e.opened;
            renderProgress();
            break;
          }
          case 'chunk-retry':
            state.txFail++;
            state.status = `⏳ retry ${e.fails}/${MAX_CHUNK_FAILS_PER_TOKEN} (status ${e.status}, wait ${(e.waitMs / 1000).toFixed(0)}s)`;
            renderProgress();
            break;
          case 'token-skip': {
            // chunk-retry sudah increment txFail; tambahin sekali aja kalau belum
            // ada chunk-retry sebelum-nya (e.g. ALL_REVEALED langsung skip).
            if (e.reason === 'all-revealed') state.txFail++;
            skipped.push({
              ticker: e.ticker,
              reason: e.reason,
              remaining: e.remaining,
              status: e.status,
              errStr: e.errStr,
            });
            // Friendly inline notice
            let msg;
            if (e.reason === 'all-revealed') {
              msg =
                `ℹ️ <b>${escapeHtml(e.ticker)}</b>: box-nya udah dibuka semua. Skip.`;
            } else {
              msg =
                `⚠️ <b>${escapeHtml(e.ticker)}</b>: gagal ${MAX_CHUNK_FAILS_PER_TOKEN}× berturut (status ${e.status}). ` +
                `Skip ${e.remaining} box, lanjut token berikutnya.\n` +
                `<code>${escapeHtml(String(e.errStr).slice(0, 150))}</code>`;
            }
            ctx.reply(msg, { parse_mode: 'HTML' }).catch(() => {});
            break;
          }
          case 'outage-pause':
            state.status = `🚨 OUTAGE detected · pause ${(e.waitMs / 60_000).toFixed(0)}min`;
            renderProgress();
            ctx
              .reply(
                `🚨 <b>API Outage detected</b>\n` +
                  `${e.consecutiveFails} token berturut gagal 5xx. ` +
                  `Pause <b>${(e.waitMs / 60_000).toFixed(0)} menit</b> ` +
                  `sebelum coba lagi…`,
                { parse_mode: 'HTML' },
              )
              .catch(() => {});
            break;
          case 'outage-resume':
            state.status = '▶️ resume after outage pause';
            renderProgress();
            ctx
              .reply(`▶️ <b>Resume</b> — coba lanjut token berikutnya.`, {
                parse_mode: 'HTML',
              })
              .catch(() => {});
            break;
        }
      },
    });
    state.status = ctrl.signal.aborted ? 'aborted' : 'done';
    const finalLine = ctrl.signal.aborted
      ? 'Aborted by user.'
      : `✓ Done. Total opened: ${result.totalOpened}/${totalBoxes}` +
        (skipped.length ? ` · ${skipped.length} token skipped` : '');
    await renderProgress(finalLine);
  } catch (e) {
    if (e?.name !== 'AbortError') {
      console.error('[open-job] fatal:', e);
      await ctx.reply(
        `❌ Open job error: ${escapeHtml(e?.message ?? String(e))}`,
      );
    }
  } finally {
    currentJob = null;
  }
}

// ── Tokens inventory view ──
function statusEmoji(t) {
  // Returns icon hint about token's claim/state.
  if (t.phase === 'CLAIMED') return '✅';
  if (t.claimableTokens > 0 && t.status === 'FINISHED') return '🟡'; // claimable
  if (t.status === 'LIVE') return '🟢';
  return '⚪';
}

function buildTokensText(items) {
  if (!items.length) {
    return '<b>🪙 Your Tokens</b>\n\n<i>Belum ada token. /buy dulu untuk dapat reward.</i>';
  }
  const lines = ['<b>🪙 Your Tokens</b>', ''];
  for (const t of items) {
    const dec = t.numOfDecimals ?? 6;
    const fmt = (raw) =>
      raw == null ? '0' : parseInt(raw).toLocaleString('en-US');
    const claimable = fmt(t.rewardedTokens ?? 0);
    const claimed = fmt(t.claimedTokens ?? 0);
    const icon = statusEmoji(t);
    lines.push(
      `${icon} <b>${escapeHtml(t.tokenName)}</b> (${escapeHtml(t.tokenTicker)})`,
    );
    lines.push(
      `   ${claimable} rewarded · ${claimed} claimed · <code>${escapeHtml(t.status)}/${escapeHtml(t.phase)}</code>`,
    );
    if (t.receipt?.transactionLink) {
      lines.push(
        `   <a href="${escapeHtml(t.receipt.transactionLink)}">tx</a>`,
      );
    }
  }
  lines.push('');
  lines.push(
    '<i>🟢 = live (buy/open) · 🟡 = claimable · ✅ = claimed · ⚪ = idle</i>',
  );
  return lines.join('\n');
}

function buildTokensKb(items) {
  const rows = [];
  // Only one tap-able row per claimable token. Active phases:
  //   LIVE/BUYING with claimableTokens>0   → user has rewards waiting (might allow claim)
  //   FINISHED/AVAILABLE / FINISHED/CLAIMED → can/cannot claim
  // We show the button whenever claimableTokens > 0 and not already CLAIMED.
  // The chain enforces actual eligibility; if not yet claimable, tx will fail
  // with a clear error which we surface.
  let claimAllNeeded = 0;
  for (let i = 0; i < items.length; i++) {
    const t = items[i];
    if (t.claimableTokens > 0 && t.phase !== 'CLAIMED') {
      claimAllNeeded++;
      rows.push([
        Markup.button.callback(
          `🟡 Claim ${shortLabel(t.tokenTicker, 12)}`,
          `tk:c:${i}`,
        ),
      ]);
    }
  }
  if (claimAllNeeded > 1) {
    rows.push([
      Markup.button.callback(
        `🟡 Claim All (${claimAllNeeded})`,
        'tk:ca',
      ),
    ]);
  }
  rows.push([
    Markup.button.callback('🔄 Refresh', 'tk:r'),
    Markup.button.callback('❌ Close', 'tk:x'),
  ]);
  return Markup.inlineKeyboard(rows);
}

async function showTokensInventory(ctx) {
  const loadingMsg = await ctx.reply('🔍 Loading inventory…');
  let items;
  try {
    items = await fetchInventoryTokens(active().client);
  } catch (e) {
    return ctx.telegram
      .editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        undefined,
        `❌ Gagal fetch tokens: ${escapeHtml(e.message)}`,
        { parse_mode: 'HTML' },
      )
      .catch(() => {});
  }

  sessions.set(ctx.chat.id, {
    state: 'tokens-view',
    data: { items },
  });

  await ctx.telegram
    .editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      undefined,
      buildTokensText(items),
      {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...buildTokensKb(items),
      },
    )
    .catch(async () => {
      await ctx.reply(buildTokensText(items), {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...buildTokensKb(items),
      });
    });
}

bot.command('tokens', async (ctx) => {
  return showTokensInventory(ctx);
});

bot.action('tk:r', async (ctx) => {
  await ctx.answerCbQuery('🔄 Refreshing…');
  try {
    const items = await fetchInventoryTokens(active().client);
    const sess = sessions.get(ctx.chat.id);
    if (sess && sess.state === 'tokens-view') sess.data.items = items;
    await ctx
      .editMessageText(buildTokensText(items), {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...buildTokensKb(items),
      })
      .catch(() => {});
  } catch (e) {
    await ctx.answerCbQuery(`❌ ${e.message.slice(0, 50)}`);
  }
});

bot.action('tk:x', async (ctx) => {
  sessions.delete(ctx.chat.id);
  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => {});
});

// On-chain claim handler. Builds + signs + sends a claim_tokens tx.
// Implementation reverse-engineered from a successful manual claim.
async function executeClaim(ctx, item) {
  const acct = active();
  const ticker = item.tokenTicker;
  const fmtAmount = (raw, dec) =>
    (Number(raw) / 10 ** dec).toLocaleString('en-US', {
      maximumFractionDigits: 6,
    });
  const human = fmtAmount(
    item.claimableTokensRaw ?? item.claimableTokens,
    item.numOfDecimals ?? 6,
  );

  const status = await ctx.telegram.sendMessage(
    ctx.chat.id,
    `🟡 <b>Claiming ${escapeHtml(ticker)}</b>\n` +
      `Amount: <b>${human}</b>\n` +
      `<i>Building &amp; signing tx…</i>`,
    { parse_mode: 'HTML' },
  );

  try {
    // Use raw amount with decimals (u64). API gives `claimableTokensRaw` as string.
    const amountRaw = item.claimableTokensRaw ?? item.claimableTokens;
    const res = await claimTokens({
      conn,
      kp: acct.kp,
      onChainId: item.onChainId,
      amountRaw,
      send: true,
    });
    if (!res.ok) {
      const errStr = JSON.stringify(res.err ?? res).slice(0, 200);
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        status.message_id,
        undefined,
        `❌ <b>Claim ${escapeHtml(ticker)} gagal</b>\n` +
          `<code>${escapeHtml(errStr)}</code>\n\n` +
          `<i>Mungkin belum eligible (status/phase belum siap), atau sudah pernah di-claim.</i>`,
        { parse_mode: 'HTML' },
      );
      return false;
    }
    const sig = res.sig;
    const link = `https://solscan.io/tx/${sig}?cluster=devnet`;
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      status.message_id,
      undefined,
      `✅ <b>Claimed ${escapeHtml(ticker)}</b>\n` +
        `Amount: <b>${human}</b>\n` +
        `<a href="${link}">tx: ${sig.slice(0, 10)}…${sig.slice(-6)}</a>`,
      { parse_mode: 'HTML', disable_web_page_preview: true },
    );
    return true;
  } catch (e) {
    console.error('[claim]', e);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      status.message_id,
      undefined,
      `❌ <b>Claim ${escapeHtml(ticker)} error</b>\n` +
        `<code>${escapeHtml(e?.message ?? String(e))}</code>`,
      { parse_mode: 'HTML' },
    );
    return false;
  }
}

// Single claim
bot.action(/^tk:c:(\d+)$/, async (ctx) => {
  const sess = sessions.get(ctx.chat.id);
  if (!sess || sess.state !== 'tokens-view') {
    await ctx.answerCbQuery('Session expired. /tokens lagi ya');
    return;
  }
  if (currentJob) {
    await ctx.answerCbQuery('Job lain lagi jalan, /stop dulu');
    return;
  }
  const idx = parseInt(ctx.match[1], 10);
  const t = sess.data.items[idx];
  if (!t) {
    await ctx.answerCbQuery('Token ga ada');
    return;
  }
  await ctx.answerCbQuery('Claiming…');
  await executeClaim(ctx, t);
  // After claim attempt, refresh the inventory list so UI reflects new state
  try {
    const items = await fetchInventoryTokens(active().client);
    sess.data.items = items;
    await ctx
      .editMessageText(buildTokensText(items), {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...buildTokensKb(items),
      })
      .catch(() => {});
  } catch {}
});

// Claim all eligible tokens sequentially
bot.action('tk:ca', async (ctx) => {
  const sess = sessions.get(ctx.chat.id);
  if (!sess || sess.state !== 'tokens-view') {
    await ctx.answerCbQuery('Session expired');
    return;
  }
  if (currentJob) {
    await ctx.answerCbQuery('Job lain lagi jalan, /stop dulu');
    return;
  }
  const eligible = sess.data.items.filter(
    (t) => t.claimableTokens > 0 && t.phase !== 'CLAIMED',
  );
  if (!eligible.length) {
    await ctx.answerCbQuery('Ga ada yg bisa di-claim');
    return;
  }
  await ctx.answerCbQuery(`Claiming ${eligible.length}…`);
  let okCount = 0;
  let failCount = 0;
  for (const t of eligible) {
    const ok = await executeClaim(ctx, t);
    if (ok) okCount++;
    else failCount++;
    // Small delay between on-chain txs
    await sleepP(1500).catch(() => {});
  }
  await ctx.reply(
    `<b>Claim All Done</b>\n✓ ${okCount} OK · ✗ ${failCount} fail`,
    { parse_mode: 'HTML' },
  );
  // Refresh list
  try {
    const items = await fetchInventoryTokens(active().client);
    sess.data.items = items;
    await ctx
      .editMessageText(buildTokensText(items), {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...buildTokensKb(items),
      })
      .catch(() => {});
  } catch {}
});

const cmdConfig = async (ctx) => {
  const c = config;
  await ctx.reply(
    `<b>⚙️ Active Config</b>\n\n` +
      `Delay antar tx: ${c.delayBetweenTx.min}-${c.delayBetweenTx.max}s\n` +
      `Delay buy→open: ${c.delayBeforeOpen.min}-${c.delayBeforeOpen.max}s\n` +
      `Inter-token   : ${c.delayBetweenTokens.min}-${c.delayBetweenTokens.max}s\n` +
      `Coffee break  : ${(c.coffeeBreak.prob * 100).toFixed(0)}% × ${c.coffeeBreak.min}-${c.coffeeBreak.max}s\n` +
      `Default qty   : ${c.defaultQtyPerTx.min}-${c.defaultQtyPerTx.max}\n` +
      `Default loops : ${c.defaultLoopsPerToken ?? 'wajib isi'}\n` +
      `RPC pool (${RPC_URLS.length})\n` +
      RPC_URLS.map(
        (u, i) =>
          `  <code>${i + 1}. ${escapeHtml(u.replace(/api-key=[^&]+/, 'api-key=***'))}</code>`,
      ).join('\n') +
      `\n\n` +
      `<i>Edit config.js buat ganti default-nya.</i>`,
    { parse_mode: 'HTML' },
  );
};
bot.command('config', cmdConfig);

const cmdStatus = async (ctx) => {
  const lines = [];
  if (scheduledTask) {
    const t = scheduledTask;
    if (t.status === 'scheduled') {
      const remain = Math.max(0, t.startAtMs - Date.now());
      const modeLine =
        t.taskMode === 'open'
          ? '📦 Open All Boxes'
          : t.bulkOpenAfter
            ? '📦 Buy semua → Open semua'
            : '⚡ Buy + Open per loop';
      const detailLine =
        t.taskMode === 'open'
          ? ''
          : `\nToken: ${t.tokenIds.length} · Loops: ${t.loopsPerToken}`;
      lines.push(
        `<b>⏰ Auto-task scheduled</b>\n` +
          `Mulai: <b>${fmtFutureTime(t.startAtMs)}</b> (${fmtDuration(remain)} lagi)\n` +
          `Akun: ${t.accountNames.join(', ')}` +
          detailLine +
          `\nMode: ${modeLine}`,
      );
    } else if (t.status === 'running') {
      const cur = t.accountNames[t.currentAccountIdx] ?? '-';
      const title = t.taskMode === 'daily' ? '🎰 Daily running' : '🤖 Auto-task running';
      lines.push(
        `<b>${title}</b>\n` +
          `Akun: <b>[${t.currentAccountIdx + 1}/${t.accountNames.length}] ${escapeHtml(cur)}</b>\n` +
          `Selesai: ${t.results.length} · Sisa: ${t.accountNames.length - t.results.length - 1}`,
      );
    }
  }
  if (currentJob) {
    // Prefer the rich live formatter installed by the runner so /status
    // mirrors the live progress message exactly.
    if (typeof currentJob.renderStatus === 'function') {
      try {
        lines.push(currentJob.renderStatus());
      } catch (e) {
        console.error('[status] renderStatus failed:', e);
      }
    } else {
      const s = currentJob.state;
      lines.push(
        `<b>📊 Job Status</b>\n` +
          `Iter: <b>${s.iter}/${s.total}</b>\n` +
          `Token: ${escapeHtml(s.currentToken || '-')}\n` +
          `Tx OK/Fail: ${s.txOk}/${s.txFail}\n` +
          `Bought: ${s.bought}  Opened: ${s.opened}\n` +
          `Last: ${escapeHtml(s.status || '-')}`,
      );
    }
  }
  if (!lines.length) {
    return ctx.reply(
      'Ga ada job yg lagi jalan.\nKetik /buy, /open, atau /autotask buat mulai.',
    );
  }
  await ctx.reply(lines.join('\n\n'), { parse_mode: 'HTML' });
};
bot.command('status', cmdStatus);

// /check — cheap pre-flight diagnostic. Hits ONLY /gumball/status (does not
// burn quota or risk triggering the strict /play anti-abuse) for every
// account so user can decide whether to /daily now or wait.
const cmdCheck = async (ctx) => {
  const allNames = accounts.names();
  if (!allNames.length) {
    return ctx.reply('Ga ada akun. /accounts dulu.');
  }

  const loadingMsg = await ctx.reply('🔍 Checking gumball status…');

  // Per-account hard timeout — fetch() has NO default timeout, so a slow or
  // unresponsive server would otherwise hang /check forever. Empirically the
  // /status endpoint replies in <1s when healthy.
  const PER_ACCOUNT_TIMEOUT_MS = 10_000;
  const withTimeout = (promise, ms, label) =>
    Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`timeout: ${label} >${ms}ms`)), ms),
      ),
    ]);

  const results = [];
  for (const name of allNames) {
    const a = accounts.get(name);
    const t0 = Date.now();
    try {
      await withTimeout(a.client.login(), PER_ACCOUNT_TIMEOUT_MS, 'login');
      const s = await withTimeout(
        getGumballStatus(a.client),
        PER_ACCOUNT_TIMEOUT_MS,
        'status',
      );
      results.push({ name, ok: true, s });
      console.log(`[check] ${name} ok (${Date.now() - t0}ms)`);
    } catch (e) {
      results.push({ name, ok: false, error: e.message });
      console.warn(`[check] ${name} FAIL (${Date.now() - t0}ms): ${e.message}`);
    }
    // Live progress: edit loading msg so user can see we're making progress.
    const partial = results.length;
    await ctx.telegram
      .editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        undefined,
        `🔍 Checking gumball status… (${partial}/${allNames.length})`,
      )
      .catch(() => {});
    // Tiny jitter so we don't smell like a bot probing 4 endpoints in sync
    await new Promise((r) => setTimeout(r, 600 + Math.random() * 600));
  }

  const lines = ['<b>🎰 Daily Status</b>', ''];
  let totalRemaining = 0;
  let anyError = false;
  for (const r of results) {
    if (!r.ok) {
      anyError = true;
      lines.push(`❌ <b>${escapeHtml(r.name)}</b> — ${escapeHtml(r.error.slice(0, 100))}`);
      continue;
    }
    const s = r.s;
    totalRemaining += s.playsRemaining ?? 0;
    const icon = !s.isActive
      ? '🚫'
      : s.playsRemaining === 0
        ? '✓'
        : s.playsRemaining < s.dailyLimit
          ? '◐'
          : '○';
    lines.push(
      `${icon} <b>${escapeHtml(r.name)}</b> — ${s.playsToday}/${s.dailyLimit} spent · <b>${s.playsRemaining}</b> left`,
    );
  }
  lines.push('');
  lines.push(`<b>Total tersisa:</b> ${totalRemaining} spin`);

  // Show next reset time (server returns UTC midnight; use the first OK row)
  const firstOk = results.find((r) => r.ok);
  if (firstOk?.s?.resetsAt) {
    const resetMs = new Date(firstOk.s.resetsAt).getTime();
    const untilMs = resetMs - Date.now();
    if (untilMs > 0) {
      lines.push(`<b>Reset dalam:</b> ${fmtDuration(untilMs)}`);
    }
  }

  if (totalRemaining > 0 && !anyError) {
    lines.push('');
    lines.push('<i>Pake /daily buat spin semua (multi-cycle retry, sampe ~27m/akun).</i>');
  }

  // Send final result as NEW message — editMessageText can silently fail or
  // race with subsequent user actions. New message guarantees delivery.
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  // Best-effort cleanup of the loading indicator. Delete is fine if it
  // works; otherwise leave it.
  if (loadingMsg) {
    await ctx.telegram
      .deleteMessage(ctx.chat.id, loadingMsg.message_id)
      .catch(() => {});
  }
};
bot.command('check', cmdCheck);

const cmdStop = async (ctx) => {
  let acted = false;
  if (scheduledTask) {
    if (scheduledTask.status === 'scheduled') {
      // Cancel pre-start timer
      clearTimeout(scheduledTask.timer);
      scheduledTask.status = 'cancelled';
      const t = scheduledTask;
      scheduledTask = null;
      await ctx.reply(
        `🚫 <b>Auto-task dibatalin</b>\nWas scheduled for ${fmtFutureTime(t.startAtMs)}.`,
        { parse_mode: 'HTML' },
      );
      acted = true;
    } else if (scheduledTask.status === 'running') {
      // Abort the executor (also aborts current sub-job via shared signal)
      scheduledTask.abortCtrl.abort();
      await ctx.reply(
        '⏸ Stopping auto-task... (sub-job sekarang akan beresin sleep cycle)',
      );
      acted = true;
    }
  }
  if (currentJob && !acted) {
    currentJob.abortCtrl.abort();
    await ctx.reply('⏸ Sending stop signal... (tunggu sleep cycle selesai)');
    acted = true;
  }
  if (!acted) await ctx.reply('Ga ada job yg jalan.');
};
bot.command('stop', cmdStop);

// /buy command — buy NEW boxes (with auto-open).
// No args  → trending picker (multi-select tokens, then loops/qty wizard).
// With args→ quick form: /buy <ids> [loops] [qty]
bot.command('buy', async (ctx) => {
  const busy = checkBusy();
  if (busy) return ctx.reply(busy);
  const args = ctx.message.text.trim().split(/\s+/).slice(1);
  if (args.length === 0) {
    return showTrendingPicker(ctx);
  }

  const tokensArg = args[0];
  const loopsArg = args[1] ?? String(config.defaultLoopsPerToken ?? 10);
  const qtyArg =
    args[2] ?? `${config.defaultQtyPerTx.min}-${config.defaultQtyPerTx.max}`;

  const tokenIds = tokensArg
    .split(',')
    .map((s) => parseTokenId(s.trim()))
    .filter(Boolean);
  if (!tokenIds.length) return ctx.reply('❌ Token ID ga valid.');

  const loops = parseRange(loopsArg);
  if (!loops || loops.min < 1) return ctx.reply('❌ Loops format salah.');

  const qty = parseRange(qtyArg);
  if (!qty || qty.min < 1 || qty.max > MAX_PER_OPEN) {
    return ctx.reply(`❌ Qty harus 1..${MAX_PER_OPEN}.`);
  }

  await prepareJob(ctx, {
    tokenIds,
    loopsPerToken: loops.min, // use min if range; user can specify exact
    qty,
    openOnly: false,
    bulkOpenAfter: false, // quick form keeps the existing per-loop behaviour
  });
});

// /open command — open boxes you ALREADY OWN (no buy step).
// No args  → inventory picker: shows your unopened boxes, multi-select, Open All.
// With args→ quick form: /open <id> <count> (manual ID, advanced)
bot.command('open', async (ctx) => {
  const busy = checkBusy();
  if (busy) return ctx.reply(busy);
  const args = ctx.message.text.trim().split(/\s+/).slice(1);
  if (args.length === 0) {
    return showBoxesPicker(ctx);
  }

  const tokenIds = args[0]
    .split(',')
    .map((s) => parseTokenId(s.trim()))
    .filter(Boolean);
  if (!tokenIds.length) return ctx.reply('❌ Token ID ga valid.');

  // For /open: arg[1] = total boxes per token (will be split into chunks of 25)
  const totalBoxes = parseInt(args[1] ?? '25', 10);
  if (!totalBoxes || totalBoxes < 1) {
    return ctx.reply('❌ Count harus angka >= 1.');
  }

  // Convert total boxes -> loops × 25 (cap to MAX_PER_OPEN per call)
  const loopsPerToken = Math.ceil(totalBoxes / MAX_PER_OPEN);
  const lastChunk = totalBoxes % MAX_PER_OPEN || MAX_PER_OPEN;
  // Use range qty so last call is correct size; simpler: cap qty at MAX_PER_OPEN
  // and let last loop process whatever is left. For now we do uniform 25/loop;
  // user can be more precise with /buy logic if needed.
  await prepareJob(ctx, {
    tokenIds,
    loopsPerToken,
    qty: { min: lastChunk, max: MAX_PER_OPEN },
    openOnly: true,
    bulkOpenAfter: false,
  });
});

bot.command('cancel', async (ctx) => {
  if (sessions.has(ctx.chat.id)) {
    sessions.delete(ctx.chat.id);
    await ctx.reply('Wizard dibatalin.');
  } else {
    await ctx.reply('Ga ada wizard yg aktif.');
  }
});

// IMPORTANT: register /autotask command BEFORE bot.on('text') below.
// bot.on('text') runs in registration order; if it returns without calling
// next() (which it does when there's no session), later bot.command()
// registrations never fire. startAutoTaskWizard is a hoisted function decl
// declared later in the file.
bot.command(['autotask', 'auto_task'], (ctx) => startAutoTaskWizard(ctx));
bot.command('daily', (ctx) => startDailyWizard(ctx));

// ───────────────── Menu (categorized inline submenus) ─────────────────
// Root menu shown by /menu and by tapping a category reply-keyboard button.
// Each category opens an inline sub-menu (buttons) that routes to the same
// handlers as the slash commands (cmdBalance, startAutoTaskWizard, etc.).
function rootMenuMarkup() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('💰 Wallet', 'menu:wallet'),
      Markup.button.callback('🎁 Trading', 'menu:trade'),
    ],
    [
      Markup.button.callback('🤖 Tasks', 'menu:tasks'),
      Markup.button.callback('ℹ️ Info', 'menu:info'),
    ],
    [
      Markup.button.callback('📊 Status', 'menu:cmd:status'),
      Markup.button.callback('⏸ Stop', 'menu:cmd:stop'),
    ],
  ]);
}
function walletMenuMarkup() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('👛 Balance', 'menu:cmd:balance'),
      Markup.button.callback('👤 Profile', 'menu:cmd:profile'),
    ],
    [
      Markup.button.callback('🔑 Accounts', 'menu:cmd:accounts'),
      Markup.button.callback('🪙 Tokens', 'menu:cmd:tokens'),
    ],
    [Markup.button.callback('🔐 Re-login', 'menu:cmd:login')],
    [Markup.button.callback('← Back', 'menu:root')],
  ]);
}
function tradeMenuMarkup() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('🛒 Buy (trending)', 'menu:cmd:buy'),
      Markup.button.callback('📦 Open Boxes', 'menu:cmd:open'),
    ],
    [Markup.button.callback('🪙 My Tokens', 'menu:cmd:tokens')],
    [Markup.button.callback('← Back', 'menu:root')],
  ]);
}
function tasksMenuMarkup() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('🤖 Auto-task', 'menu:cmd:autotask'),
      Markup.button.callback('🎰 Daily', 'menu:cmd:daily'),
    ],
    [
      Markup.button.callback('🔍 Check Daily', 'menu:cmd:check'),
    ],
    [
      Markup.button.callback('📊 Status', 'menu:cmd:status'),
      Markup.button.callback('⏸ Stop', 'menu:cmd:stop'),
    ],
    [Markup.button.callback('← Back', 'menu:root')],
  ]);
}
function infoMenuMarkup() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('⚙️ Config', 'menu:cmd:config'),
      Markup.button.callback('📖 Help', 'menu:cmd:help'),
    ],
    [Markup.button.callback('← Back', 'menu:root')],
  ]);
}

const MENU_TITLES = {
  root: '📱 <b>Menu</b>\nPilih kategori:',
  wallet: '💰 <b>Wallet & Account</b>',
  trade: '🎁 <b>Trading</b>\nBeli / buka box',
  tasks: '🤖 <b>Tasks</b>\nAuto-task & Daily',
  info: 'ℹ️ <b>Info & Config</b>',
};
const MENU_MARKUPS = {
  root: rootMenuMarkup,
  wallet: walletMenuMarkup,
  trade: tradeMenuMarkup,
  tasks: tasksMenuMarkup,
  info: infoMenuMarkup,
};

async function showMenu(ctx, key, { edit = false } = {}) {
  const text = MENU_TITLES[key];
  const markup = MENU_MARKUPS[key]();
  if (edit) {
    await ctx
      .editMessageText(text, { parse_mode: 'HTML', ...markup })
      .catch(() =>
        ctx.reply(text, { parse_mode: 'HTML', ...markup }),
      );
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', ...markup });
  }
}

bot.command('menu', (ctx) => showMenu(ctx, 'root'));

// Reply-keyboard text buttons open their category. Must be registered BEFORE
// bot.on('text') (which swallows non-slash text when no wizard is active).
bot.hears('💰 Wallet', (ctx) => showMenu(ctx, 'wallet'));
bot.hears('🎁 Trading', (ctx) => showMenu(ctx, 'trade'));
bot.hears('🤖 Tasks', (ctx) => showMenu(ctx, 'tasks'));
bot.hears('ℹ️ Info', (ctx) => showMenu(ctx, 'info'));
bot.hears('📊 Status', (ctx) => cmdStatus(ctx));
bot.hears('⏸ Stop', (ctx) => cmdStop(ctx));

// Navigate between sub-menus by editing the existing message in-place.
bot.action(/^menu:(root|wallet|trade|tasks|info)$/, async (ctx) => {
  await ctx.answerCbQuery();
  return showMenu(ctx, ctx.match[1], { edit: true });
});

// Route action buttons → existing command handlers. For wizards we call the
// start* functions directly (they handle checkBusy); for simple commands we
// call the named cmdX wrappers. All of these were declared above so they are
// defined by the time a user taps a button.
bot.action(/^menu:cmd:(\w+)$/, async (ctx) => {
  const cmd = ctx.match[1];
  await ctx.answerCbQuery();
  // Keep the menu message but remove its keyboard so it doesn't feel "stuck".
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  switch (cmd) {
    case 'balance': return cmdBalance(ctx);
    case 'profile': return cmdProfile(ctx);
    case 'accounts': return renderAccountsMenu(ctx, { edit: false });
    case 'tokens': return showTokensInventory(ctx);
    case 'login': return cmdLogin(ctx);
    case 'buy': {
      const busy = checkBusy();
      if (busy) return ctx.reply(busy);
      return showTrendingPicker(ctx);
    }
    case 'open': {
      const busy = checkBusy();
      if (busy) return ctx.reply(busy);
      return showBoxesPicker(ctx);
    }
    case 'autotask': return startAutoTaskWizard(ctx);
    case 'daily': return startDailyWizard(ctx);
    case 'check': return cmdCheck(ctx);
    case 'status': return cmdStatus(ctx);
    case 'stop': return cmdStop(ctx);
    case 'config': return cmdConfig(ctx);
    case 'help': return cmdHelp(ctx);
    default:
      return ctx.reply(`Unknown action: ${cmd}`);
  }
});

// ───────────────── Wizard message handler ─────────────────
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();

  // Telegram doesn't tag hyphenated commands as bot_command entities,
  // so bot.command() misses "/auto-task". Catch the literal text here
  // before the wizard early-return swallows it. (startAutoTaskWizard is
  // a hoisted function declaration.)
  if (/^\/auto-task(\s|$|@)/i.test(text)) {
    sessions.delete(ctx.chat.id); // break out of any active wizard
    return startAutoTaskWizard(ctx);
  }

  const sess = sessions.get(ctx.chat.id);
  if (!sess) return; // ignore non-command non-wizard messages

  if (text.startsWith('/')) return; // commands handled elsewhere

  // --- Add account wizard: ask name ---
  if (sess.state === 'wait-accname') {
    const name = text;
    if (/\s/.test(name)) {
      return ctx.reply('❌ Nama ga boleh pake spasi. Coba lagi atau /cancel.');
    }
    if (name.length > 32) {
      return ctx.reply('❌ Nama maksimal 32 karakter. Kependekan aja, contoh "main", "farm1".');
    }
    if (name.length >= 43 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(name)) {
      return ctx.reply(
        '❌ Itu keliatan kayak <b>private key</b>, bukan nama.\n\n' +
          'Kasih nama pendek aja (e.g. <code>main</code>, <code>farm1</code>). ' +
          'Private key dimintanya nanti di step ke-2.',
        { parse_mode: 'HTML' },
      );
    }
    if (accounts.has(name)) {
      return ctx.reply(`❌ Akun "${name}" udah ada. Coba nama lain atau /cancel.`);
    }
    sess.state = 'wait-privkey';
    sess.data.name = name;
    return ctx.reply(
      `Nama OK: <b>${escapeHtml(name)}</b>\n\n` +
        `Sekarang kirim <b>private key</b> (bs58) untuk akun ini.\n\n` +
        `⚠️ Message dengan key bakal <b>auto-delete</b> setelah disimpen.\n\n` +
        `/cancel buat batalin.`,
      { parse_mode: 'HTML' },
    );
  }

  // --- Add account wizard: private key input (final step) ---
  if (sess.state === 'wait-privkey') {
    const { name } = sess.data;
    try {
      const added = accounts.add(name, text);
      sessions.delete(ctx.chat.id);
      // Try to delete the message with the private key for safety
      await ctx.deleteMessage().catch(() => {});
      // Login in background (non-blocking)
      added.client.login().catch((e) =>
        ctx.reply(`⚠️ Login ${name} gagal: ${e.message}`),
      );
      await ctx.reply(
        `✓ Akun <b>${escapeHtml(name)}</b> ditambah.\n` +
          `Wallet: <code>${added.kp.publicKey.toBase58()}</code>`,
        { parse_mode: 'HTML' },
      );
      // Show updated accounts menu
      await renderAccountsMenu(ctx, { edit: false });
    } catch (e) {
      sessions.delete(ctx.chat.id);
      await ctx.reply(`❌ Gagal add akun: ${escapeHtml(e.message)}`);
    }
    return;
  }

  // --- Rename wizard: new name input ---
  if (sess.state === 'wait-renamenew') {
    const newName = text;
    const { oldName } = sess.data;
    sessions.delete(ctx.chat.id);
    if (/\s/.test(newName)) {
      return ctx.reply('❌ Nama ga boleh pake spasi.');
    }
    try {
      accounts.rename(oldName, newName);
      await ctx.reply(`✓ ${escapeHtml(oldName)} → <b>${escapeHtml(newName)}</b>`, { parse_mode: 'HTML' });
      await renderAccountsMenu(ctx, { edit: false });
    } catch (e) {
      await ctx.reply(`❌ Rename gagal: ${escapeHtml(e.message)}`);
    }
    return;
  }

  if (sess.state === 'wait-tokens') {
    const tokenIds = text
      .split(',')
      .map((s) => parseTokenId(s.trim()))
      .filter(Boolean);
    if (!tokenIds.length) {
      return ctx.reply('❌ Ga nemu ULID. Kirim ulang atau /cancel.');
    }
    sess.data.tokenIds = tokenIds;
    sess.state = 'wait-loops';
    return ctx.reply(
      `✓ ${tokenIds.length} token.\n\n` +
        `Berapa kali loop ${tokenIds.length > 1 ? 'PER token' : ''}?\n` +
        `Kirim angka (default: ${config.defaultLoopsPerToken ?? 10})`,
    );
  }

  if (sess.state === 'wait-loops') {
    const loops = parseRange(text);
    if (!loops || loops.min < 1) {
      return ctx.reply('❌ Format salah. Contoh: 10');
    }
    sess.data.loops = loops.min;
    sess.state = 'wait-qty';
    return ctx.reply(
      `✓ ${loops.min} loops.\n\n` +
        `Qty per tx? (max ${MAX_PER_OPEN})\n` +
        `Default: ${config.defaultQtyPerTx.min}-${config.defaultQtyPerTx.max}\n` +
        `Format: <code>25</code> atau <code>20-25</code>`,
      { parse_mode: 'HTML' },
    );
  }

  if (sess.state === 'wait-qty') {
    const qty = parseRange(text);
    if (!qty || qty.min < 1 || qty.max > MAX_PER_OPEN) {
      return ctx.reply(`❌ Qty harus 1..${MAX_PER_OPEN}`);
    }
    sess.data.qty = qty;

    // /open mode (open boxes from inventory) doesn't have a "buy" step,
    // so the buy-mode picker is irrelevant — go straight to the job.
    if (sess.data.mode === 'open') {
      sessions.delete(ctx.chat.id);
      await prepareJob(ctx, {
        tokenIds: sess.data.tokenIds,
        loopsPerToken: sess.data.loops,
        qty: sess.data.qty,
        openOnly: true,
        bulkOpenAfter: false,
      });
      return;
    }

    // /buy mode: ask user to pick buy mode (per-loop vs bulk).
    sess.state = 'wait-mode';
    return ctx.reply(
      `<b>Pilih mode pembelian:</b>\n\n` +
        `⚡ <b>Buy + Open per loop</b>\n` +
        `   tiap iter: beli → tunggu → open. Default, anti-bot natural.\n\n` +
        `📦 <b>Buy semua dulu, baru open semua</b>\n` +
        `   loop beli aja sampe abis, baru bulk-open per token.\n` +
        `   cocok kalau mau nimbun box dulu.`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⚡ Buy + Open per loop', 'bm:auto')],
          [Markup.button.callback('📦 Buy semua → Open semua', 'bm:bulk')],
          [Markup.button.callback('❌ Batal', 'bm:cancel')],
        ]),
      },
    );
  }

  // ── Auto-task wizard text states ──
  if (sess.state === 'at-tokens') {
    const tokenIds = text
      .split(',')
      .map((s) => parseTokenId(s.trim()))
      .filter(Boolean);
    if (!tokenIds.length) {
      return ctx.reply('❌ Ga nemu ULID. Kirim ulang atau /cancel.');
    }
    sess.data.tokenIds = tokenIds;
    sess.state = 'at-loops';
    return ctx.reply(
      `✓ ${tokenIds.length} token.\n\n` +
        `Berapa kali loop PER token (per akun)?\n` +
        `Kirim angka (default: ${config.defaultLoopsPerToken ?? 10})`,
    );
  }

  if (sess.state === 'at-loops') {
    const loops = parseRange(text);
    if (!loops || loops.min < 1) {
      return ctx.reply('❌ Format salah. Contoh: 10');
    }
    sess.data.loops = loops.min;
    sess.state = 'at-qty';
    return ctx.reply(
      `✓ ${loops.min} loops/token/akun.\n\n` +
        `Qty per tx? (max ${MAX_PER_OPEN})\n` +
        `Default: ${config.defaultQtyPerTx.min}-${config.defaultQtyPerTx.max}\n` +
        `Format: <code>25</code> atau <code>20-25</code>`,
      { parse_mode: 'HTML' },
    );
  }

  if (sess.state === 'at-qty') {
    const qty = parseRange(text);
    if (!qty || qty.min < 1 || qty.max > MAX_PER_OPEN) {
      return ctx.reply(`❌ Qty harus 1..${MAX_PER_OPEN}`);
    }
    sess.data.qty = qty;
    sess.state = 'at-mode';
    return ctx.reply(
      `✓ Qty ${qty.min === qty.max ? qty.min : `${qty.min}-${qty.max}`}.\n\n` +
        `<b>Pilih mode pembelian:</b>\n\n` +
        `⚡ <b>Buy + Open per loop</b>\n` +
        `   tiap iter: beli → tunggu → open. Default, anti-bot natural.\n\n` +
        `📦 <b>Buy semua dulu, baru open semua</b>\n` +
        `   loop beli aja sampe abis (per akun), baru bulk-open per token.\n` +
        `   cocok kalau mau nimbun box dulu.`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⚡ Buy + Open per loop', 'at:m:auto')],
          [Markup.button.callback('📦 Buy semua → Open semua', 'at:m:bulk')],
          [Markup.button.callback('❌ Batal', 'at:cancel')],
        ]),
      },
    );
  }

  if (sess.state === 'at-delay') {
    let delayMs;
    const trimmed = text.trim();
    if (trimmed === '0' || trimmed === '0m') {
      delayMs = 0;
    } else {
      delayMs = parseDelayString(trimmed);
      if (delayMs == null) {
        return ctx.reply(
          '❌ Format salah. Contoh: <code>30m</code>, <code>2h</code>, <code>1h30m</code>, atau <code>90</code> (=90 menit)',
          { parse_mode: 'HTML' },
        );
      }
    }
    sess.data.delayMs = delayMs;
    const startAtMs = Date.now() + delayMs;
    const accountList = sess.data.accountNames.join(', ');

    // Open-only mode: skip token/qty/mode info, kasih confirm langsung.
    if (sess.data.taskMode === 'open') {
      const summary =
        `<b>📋 Confirm Auto-task</b>\n\n` +
        `Akun (${sess.data.accountNames.length}): <b>${escapeHtml(accountList)}</b>\n` +
        `Mode: <b>📦 Open All Boxes</b>\n` +
        `<i>Bot bakal fetch unopened-box list tiap akun, terus open semuanya.</i>\n` +
        `Mulai: <b>${
          delayMs === 0
            ? 'sekarang'
            : `${fmtFutureTime(startAtMs)} (${fmtDuration(delayMs)} lagi)`
        }</b>\n` +
        `Anti-bot: random 5-15m antar akun\n\n` +
        `Lanjutkan?`;
      sess.state = 'at-confirm';
      sess.data.startAtMs = startAtMs;
      return ctx.reply(summary, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Schedule', 'at:confirm'),
            Markup.button.callback('❌ Batal', 'at:cancel'),
          ],
        ]),
      });
    }

    // Buy + Open mode: full summary
    const qty = sess.data.qty;
    const modeLabel = sess.data.bulkOpenAfter
      ? '📦 Buy semua → Open semua'
      : '⚡ Buy + Open per loop';
    const summary =
      `<b>📋 Confirm Auto-task</b>\n\n` +
      `Akun (${sess.data.accountNames.length}): <b>${escapeHtml(accountList)}</b>\n` +
      `Token (${sess.data.tokenIds.length}): ${sess.data.tokenIds
        .map((s) => `<code>${s.slice(0, 8)}…</code>`)
        .join(', ')}\n` +
      `Loops/token: <b>${sess.data.loops}</b>\n` +
      `Qty: <b>${qty.min === qty.max ? qty.min : `${qty.min}-${qty.max}`}</b>\n` +
      `Mode: <b>${modeLabel}</b>\n` +
      `Mulai: <b>${
        delayMs === 0
          ? 'sekarang'
          : `${fmtFutureTime(startAtMs)} (${fmtDuration(delayMs)} lagi)`
      }</b>\n` +
      `Anti-bot: random 5-15m antar akun\n\n` +
      `Lanjutkan?`;
    sess.state = 'at-confirm';
    sess.data.startAtMs = startAtMs;
    return ctx.reply(summary, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Schedule', 'at:confirm'),
          Markup.button.callback('❌ Batal', 'at:cancel'),
        ],
      ]),
    });
  }
});

// ───────────────── Job preparation ─────────────────
async function prepareJob(
  ctx,
  { tokenIds, loopsPerToken, qty, openOnly, bulkOpenAfter = false },
) {
  // Snapshot the account we're using for this job. If user switches account
  // between /buy and clicking Confirm, this job still uses the original.
  const jobAccount = active();
  const jobAccountName = accounts.activeName;

  // Fetch token details + gate on sale state (reject post-sale "claim" or
  // expired sale window — program would reject purchase_tbos with 0x1784).
  const tokens = [];
  const errors = [];
  for (const id of tokenIds) {
    try {
      const det = await jobAccount.client.get(`/api/v1/tokens/${id}`);
      if (!det.ok || !det.data?.success) {
        errors.push(
          `${id}: ${JSON.stringify(det.data).slice(0, 80)}`,
        );
        continue;
      }
      const d = det.data.data;
      // In open-only mode the user already owns boxes — no sale gate needed.
      if (!openOnly) {
        const step = String(d?.step || '').toLowerCase();
        const endStr = d?.campaign?.boxOffering?.endTimestamp;
        const saleEnd = endStr ? new Date(endStr).getTime() : null;
        const now = Date.now();
        if (step === 'claim' || step === 'finished' || step === 'cashout') {
          errors.push(
            `${id.slice(0, 8)}… (${d?.token?.ticker || '?'}): sale udah berakhir (step=${step}), ga bisa di-buy lagi. Pakai /claim kalo mau claim tokens.`,
          );
          continue;
        }
        if (saleEnd && saleEnd < now) {
          const mins = Math.round((now - saleEnd) / 60000);
          errors.push(
            `${id.slice(0, 8)}… (${d?.token?.ticker || '?'}): sale window expired ${mins}m lalu.`,
          );
          continue;
        }
      }
      tokens.push({ tokenId: id, data: d });
    } catch (e) {
      errors.push(`${id}: ${e.message}`);
    }
  }
  if (!tokens.length) {
    return ctx.reply(`❌ Ga ada token valid:\n${errors.join('\n')}`);
  }

  const { plan, order } = makePlan(
    tokens.map((t) => t.tokenId),
    loopsPerToken,
  );

  const avgQty = (qty.min + qty.max) / 2;
  let estCost = 0;
  for (const step of plan) {
    const t = tokens.find((tt) => tt.tokenId === step.tokenId);
    estCost += avgQty * parseFloat(t.data.campaign?.boxValueSOL ?? '0');
  }

  // Show summary with confirm buttons
  const modeLabel = openOnly
    ? '🎁 OPEN ONLY'
    : bulkOpenAfter
      ? '📦 BUY ALL → OPEN ALL'
      : '⚡ BUY + OPEN per loop';
  const summary =
    `<b>📋 Confirm Job</b>\n\n` +
    `Mode: <b>${modeLabel}</b>\n\n` +
    tokens
      .map((t) => {
        const cnt = plan.filter((p) => p.tokenId === t.tokenId).length;
        const boxValue = parseFloat(t.data.campaign?.boxValueSOL ?? '0');
        const tokenEst = cnt * avgQty * boxValue;
        const estStr = openOnly
          ? ''
          : ` → <b>~${tokenEst.toFixed(6)} SOL</b>`;
        return `• ${t.data.token.name} (${t.data.token.ticker}) — ${cnt} loops @ ${t.data.campaign?.boxValueSOL} SOL${estStr}`;
      })
      .join('\n') +
    `\n\nLoops/token: <b>${loopsPerToken}</b>\n` +
    `Total iters: <b>${plan.length}</b>\n` +
    `Qty: <b>${qty.min === qty.max ? qty.min : `${qty.min}-${qty.max}`}</b> random\n` +
    (tokens.length > 1
      ? `Order: ${order.map((id) => tokens.find((t) => t.tokenId === id).data.token.ticker).join(' → ')}\n`
      : '') +
    (openOnly
      ? ''
      : `Est. cost: <b>~${estCost.toFixed(6)} SOL</b>\n`) +
    `\n${errors.length ? `<i>Skipped: ${errors.length} invalid</i>\n\n` : ''}` +
    `Lanjutkan?`;

  // Stash pending job in session (include the account snapshot)
  sessions.set(ctx.chat.id, {
    state: 'pending-confirm',
    data: {
      tokens,
      plan,
      order,
      qty,
      loopsPerToken,
      openOnly,
      bulkOpenAfter,
      jobAccount,
      jobAccountName,
    },
  });

  await ctx.reply(summary, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Lanjut', 'job:start'),
        Markup.button.callback('❌ Batal', 'job:cancel'),
      ],
    ]),
  });
}

// ───────────────── Inline button handlers ─────────────────
bot.action('job:cancel', async (ctx) => {
  sessions.delete(ctx.chat.id);
  await ctx.editMessageText('❌ Dibatalin.');
  await ctx.answerCbQuery();
});

bot.action('job:start', async (ctx) => {
  const sess = sessions.get(ctx.chat.id);
  if (!sess || sess.state !== 'pending-confirm') {
    return replySessionExpired(ctx, 'buy');
  }
  if (currentJob) {
    await ctx.answerCbQuery('Job lain lagi jalan');
    return;
  }
  sessions.delete(ctx.chat.id);
  await ctx.answerCbQuery('🚀 Starting...');
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  // Fire-and-forget: a job may run for many minutes. Returning from the
  // handler quickly lets Telegraf process other updates while the job runs.
  runWithLiveProgress(ctx, sess.data).catch((e) => {
    console.error('[job] crash:', e);
    ctx.reply(`❌ Job crash: ${escapeHtml(e?.message ?? String(e))}`).catch(() => {});
  });
});

// ───────────────── Live progress runner ─────────────────
async function runWithLiveProgress(ctx, opts) {
  const {
    tokens,
    plan,
    order,
    qty,
    loopsPerToken,
    openOnly,
    bulkOpenAfter = false,
    jobAccount,
    jobAccountName,
  } = opts;
  // Fall back to current active if snapshot missing (shouldn't happen)
  const jobKp = jobAccount?.kp ?? active().kp;
  const jobClient = jobAccount?.client ?? active().client;

  // Bypass MAIN_MENU middleware so editMessageText works reliably
  const sentMsg = await ctx.telegram.sendMessage(
    ctx.chat.id,
    '⏳ Starting…',
    { parse_mode: 'HTML' },
  );

  const state = {
    iter: 0,
    total: plan.length,
    txOk: 0,
    txFail: 0,
    bought: 0,
    opened: 0,
    currentToken: '',
    currentTokenId: null,
    currentQty: 0,
    status: 'starting',
    lastSig: null,
    perToken: new Map(),
    coffeeBreaks: 0,
    // 'buying' | 'opening' (only meaningful when bulkOpenAfter)
    phase: bulkOpenAfter ? 'buying' : null,
    bulkOpenTotal: 0, // total boxes the bulk-open phase needs to open
    bulkOpenDone: 0, // total boxes opened during bulk phase so far
  };

  const ctrl = new AbortController();
  let lastEditTs = 0;
  let pendingEdit = false;
  let lastText = '';
  // When Telegram returns 429 (rate-limited), skip editLive() until this ts.
  // Prevents the bot from spamming edits and getting hit with longer bans.
  let editRateLimitUntil = 0;
  // Throttle: minimum ms between actual edit API calls. 3000ms is comfortable
  // under Telegram's "1 message/sec per chat" limit even with bursts.
  const EDIT_THROTTLE_MS = 3000;

  const formatRunningStatus = () => {
    const pct =
      state.total > 0 ? Math.floor((state.iter / state.total) * 100) : 0;
    const bar =
      '█'.repeat(Math.floor(pct / 10)).padEnd(10, '░');
    const tickerLine = order
      .map((id) => {
        const t = tokens.find((tt) => tt.tokenId === id);
        const s = state.perToken.get(id) ?? { bought: 0, opened: 0 };
        return `• ${t.data.token.ticker}: ${openOnly ? `opened=${s.opened}` : `bought=${s.bought} opened=${s.opened}`}`;
      })
      .join('\n');

    const headerBadge = openOnly
      ? '🎁 OPEN ONLY'
      : bulkOpenAfter
        ? state.phase === 'opening'
          ? '📦 BULK · OPENING'
          : '📦 BULK · BUYING'
        : '⚡ BUY + OPEN';

    // In bulk-opening phase, show a separate progress bar for the open
    // sub-phase so the user can see how far through the stockpile we are.
    const bulkOpenLine =
      bulkOpenAfter && state.phase === 'opening' && state.bulkOpenTotal > 0
        ? (() => {
            const op =
              state.bulkOpenTotal > 0
                ? Math.floor(
                    (state.bulkOpenDone / state.bulkOpenTotal) * 100,
                  )
                : 0;
            const obar = '█'.repeat(Math.floor(op / 10)).padEnd(10, '░');
            return `\nOpen: <code>${obar}</code> ${op}% (${state.bulkOpenDone}/${state.bulkOpenTotal})`;
          })()
        : '';

    return (
      `<b>${headerBadge}</b>  <i>${ctrl.signal.aborted ? 'STOPPING…' : 'running'}</i>\n\n` +
      `<code>${bar}</code> ${pct}%  (${state.iter}/${state.total})` +
      `${bulkOpenLine}\n\n` +
      `Now: ${escapeHtml(state.currentToken || '-')} ` +
      `<i>${escapeHtml(state.status)}</i>\n\n` +
      `Tx ✓ ${state.txOk}  ✗ ${state.txFail}\n` +
      `${tickerLine}\n` +
      (state.coffeeBreaks > 0 ? `\n☕ ${state.coffeeBreaks}x coffee` : '')
    );
  };

  const editLive = async () => {
    if (pendingEdit) return;
    // If we hit Telegram 429, back off completely until cooldown ends.
    if (Date.now() < editRateLimitUntil) return;
    pendingEdit = true;
    try {
      // Debounce loop: re-render after each edit if state changed during the
      // API call. Prevents stale displays when many events fire quickly.
      while (true) {
        const now = Date.now();
        const wait = Math.max(0, EDIT_THROTTLE_MS - (now - lastEditTs));
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));

        const text = formatRunningStatus();
        if (text === lastText) break;
        lastText = text;
        lastEditTs = Date.now();

        await ctx.telegram.editMessageText(
          sentMsg.chat.id,
          sentMsg.message_id,
          undefined,
          text,
          { parse_mode: 'HTML' },
        );
      }
    } catch (e) {
      // 429 → set cooldown so we stop hammering Telegram. retry_after is in
      // seconds; default to 60s if missing.
      if (e?.response?.error_code === 429) {
        const retryAfter =
          (e.response.parameters?.retry_after ?? 60) * 1000;
        editRateLimitUntil = Date.now() + retryAfter;
        console.warn(
          `[editLive] 429 from Telegram, backing off ${(retryAfter / 1000).toFixed(0)}s`,
        );
      }
      // else: ignore (not modified / message gone / etc.)
    } finally {
      pendingEdit = false;
    }
  };

  // Register currentJob — expose renderStatus so /status can show the same
  // rich live view (progress bar, per-token tally, phase badge, etc.).
  currentJob = {
    chatId: ctx.chat.id,
    msgId: sentMsg.message_id,
    abortCtrl: ctrl,
    state,
    renderStatus: formatRunningStatus,
  };

  try {
    const summary = await runJob({
      conn,
      kp: jobKp,
      client: jobClient,
      tokens,
      qty,
      loopsPerToken,
      plan,
      order,
      openOnly,
      autoOpen: true,
      bulkOpenAfter,
      delays: {
        betweenTx: config.delayBetweenTx,
        postBuy: config.delayBeforeOpen,
        interToken: config.delayBetweenTokens,
        coffee: config.coffeeBreak,
        openChunkDelay: config.delayBetweenOpenChunks,
      },
      signal: ctrl.signal,
      onProgress: (e) => {
        switch (e.type) {
          case 'iter-start':
            state.iter = e.i + 1;
            state.currentTokenId = e.tokenId;
            state.currentToken = `${e.name} (${e.ticker})`;
            state.currentQty = e.qty;
            state.status = openOnly
              ? `opening ${e.qty}…`
              : `buying ${e.qty}…`;
            if (!state.perToken.has(e.tokenId)) {
              state.perToken.set(e.tokenId, { bought: 0, opened: 0 });
            }
            editLive();
            break;
          case 'buy-ok': {
            state.lastSig = e.sig;
            const st = state.perToken.get(state.currentTokenId);
            if (st) st.bought += state.currentQty;
            state.status = `✓ confirmed ${shortSig(e.sig)}`;
            editLive();
            break;
          }
          case 'buy-fail': {
            const errStr =
              typeof e.err === 'string' ? e.err : JSON.stringify(e.err)?.slice(0, 200);
            const logTail = Array.isArray(e.logs) ? e.logs.slice(-3).join(' | ') : '';
            console.error(
              `[buy-fail] iter=${e.i} err=${errStr}${logTail ? ` | logs: ${logTail.slice(0, 200)}` : ''}`,
            );
            state.status = `✗ buy failed: ${String(errStr).slice(0, 50)}`;
            editLive();
            break;
          }
          case 'open-ok': {
            // Bulk-phase opens carry tokenId on the event; per-iter opens use
            // the currentTokenId from iter-start.
            const tokId = e.tokenId ?? state.currentTokenId;
            const st = state.perToken.get(tokId);
            if (st) st.opened += e.count;
            if (e.phase === 'bulk') {
              state.bulkOpenDone += e.count;
              state.status = `✓ opened ${e.count} (${e.ticker})`;
            } else {
              state.status = `✓ opened ${e.count}`;
            }
            editLive();
            break;
          }
          case 'open-fail':
            console.error(
              `[open-fail] iter=${e.i} status=${e.status} body=${String(e.body).slice(0, 150)}`,
            );
            state.status = `✗ open failed (${e.status})`;
            editLive();
            break;
          case 'iter-end':
            // Authoritative totals from runner
            state.txOk = e.totals.txOk;
            state.txFail = e.totals.txFail;
            state.bought = e.totals.totalBought;
            state.opened = e.totals.totalOpened;
            editLive();
            break;
          case 'sleep':
            if (e.kind === 'inter-token') {
              state.status = `🔄 → ${e.nextTicker} (${fmtMs(e.durationMs)})`;
            } else if (e.kind === 'normal') {
              state.status =
                e.coffeeExtraMs > 0
                  ? `☕ coffee ${fmtMs(e.durationMs)}`
                  : `💤 ${fmtMs(e.durationMs)}`;
            } else if (e.kind === 'post-buy') {
              state.status = `… ${fmtMs(e.durationMs)} sebelum open`;
            } else if (e.kind === 'rate-limit') {
              state.status = `⏳ rate-limited, cooldown ${fmtMs(e.durationMs)}`;
            }
            if (e.coffeeExtraMs > 0) state.coffeeBreaks++;
            editLive();
            break;
          case 'phase-change':
            state.phase = e.phase;
            if (e.phase === 'opening') {
              // Pre-compute the total bought boxes; bulkOpenTotal grows as
              // bulk-open-start events arrive (one per token).
              state.bulkOpenTotal = 0;
              state.bulkOpenDone = 0;
              state.currentToken = '';
              state.status = '📦 starting bulk open…';
            }
            editLive();
            break;
          case 'bulk-open-start':
            state.bulkOpenTotal += e.total;
            state.currentTokenId = e.tokenId;
            state.currentToken = e.ticker;
            state.status = `📦 opening ${e.total} ${e.ticker}…`;
            editLive();
            break;
          case 'iter-error':
            console.error(`[iter-error] iter=${e.i} ${e.error}`);
            state.status = `⚠ ${e.error}`.slice(0, 80);
            editLive();
            break;
          case 'streak-abort':
            console.warn(
              `[streak-abort] ${e.consecutiveFails} consecutive fails — aborting job`,
            );
            state.status = `🛑 aborted: ${e.consecutiveFails} fail berturut (campaign sold-out / wallet issue?)`;
            ctrl.abort(); // also signal abort so any in-flight sleeps wake up
            editLive();
            break;
        }
      },
    });

    // Final message
    const aborted = ctrl.signal.aborted;
    const tickerLines = summary.perToken
      .map(
        (t) =>
          `• ${t.ticker} (${escapeHtml(t.name)}): ${t.bought ? `bought=${t.bought} ` : ''}opened=${t.opened}`,
      )
      .join('\n');

    const final =
      `<b>${aborted ? '⏸ STOPPED' : '✅ DONE'}</b> ${openOnly ? '🎁' : '📦'}\n\n` +
      `Iters: <b>${summary.completedIters ?? summary.totalIters}/${summary.totalIters}</b>\n` +
      `Tx ✓ ${summary.txOk}  ✗ ${summary.txFail}\n` +
      `Bought: <b>${summary.totalBought}</b>\n` +
      `Opened: <b>${summary.totalOpened}</b>\n` +
      `Elapsed: ${(summary.elapsedMs / 1000).toFixed(1)}s\n` +
      (summary.spentLamports != null
        ? `Spent: <b>${fmtSol(summary.spentLamports)} SOL</b> (saldo ${fmtSol(summary.endBalanceLamports)})\n`
        : '') +
      (tickerLines ? `\n${tickerLines}` : '');

    await ctx.telegram
      .editMessageText(
        sentMsg.chat.id,
        sentMsg.message_id,
        undefined,
        final,
        { parse_mode: 'HTML' },
      )
      .catch(() => ctx.reply(final, { parse_mode: 'HTML' }));
  } catch (e) {
    await ctx.reply(`❌ Job error: ${escapeHtml(e?.message ?? String(e))}`);
  } finally {
    currentJob = null;
  }
}

// ───────────────── Auto-task ─────────────────
// Build the inline keyboard for the account multi-select picker.
function buildAutoAccountsKb(allNames, selectedSet) {
  const rows = [];
  for (let i = 0; i < allNames.length; i++) {
    const name = allNames[i];
    const mark = selectedSet.has(name) ? '✅' : '☐';
    rows.push([
      Markup.button.callback(`${mark} ${shortLabel(name, 28)}`, `at:a:${i}`),
    ]);
  }
  rows.push([
    Markup.button.callback('☑️ All', 'at:all'),
    Markup.button.callback('☐ None', 'at:none'),
  ]);
  rows.push([
    Markup.button.callback(`✓ Lanjut (${selectedSet.size})`, 'at:next'),
    Markup.button.callback('❌ Batal', 'at:cancel'),
  ]);
  return Markup.inlineKeyboard(rows);
}

// Telegram only treats /commands matching [a-zA-Z0-9_] as bot_command entities.
// Hyphens (e.g. "/auto-task") are sent as plain text, so we register the
// canonical "autotask" command + alias "auto_task", and use bot.hears() below
// to catch the hyphenated form sent from old keyboards / muscle memory.
async function startAutoTaskWizard(ctx) {
  const busy = checkBusy();
  if (busy) return ctx.reply(busy);
  const allNames = accounts.names();
  if (!allNames.length) {
    return ctx.reply('Belum ada akun. /accounts add dulu.');
  }
  const selected = new Set();
  sessions.set(ctx.chat.id, {
    state: 'at-pick-accounts',
    data: { allNames, selected },
  });
  await ctx.reply(
    `<b>🤖 Auto-task — Pilih Akun</b>\n` +
      `Tap akun buat select. Bot bakal proses akun-akun ini sekuensial ` +
      `dengan jeda anti-bot 5-15 menit antar akun.\n\n` +
      `Cocok buat ditinggal tidur 😴`,
    {
      parse_mode: 'HTML',
      ...buildAutoAccountsKb(allNames, selected),
    },
  );
}

// /autotask command registration is intentionally placed earlier in the file,
// BEFORE bot.on('text'), because bot.on('text') consumes messages without
// calling next() when there's no active wizard session. See registration
// near the bot.command('cancel') block above.
//
// Backward-compat for "/auto-task" (hyphenated) is handled at the top of
// bot.on('text') above, since Telegram sends it as plain text (no bot_command
// entity for hyphens) and bot.command() can't match it.

// Toggle one account
bot.action(/^at:a:(\d+)$/, async (ctx) => {
  const sess = sessions.get(ctx.chat.id);
  if (!sess || sess.state !== 'at-pick-accounts') {
    await ctx.answerCbQuery('Session expired');
    return;
  }
  const idx = parseInt(ctx.match[1], 10);
  const name = sess.data.allNames[idx];
  if (!name) {
    await ctx.answerCbQuery('Akun ga ada');
    return;
  }
  if (sess.data.selected.has(name)) {
    sess.data.selected.delete(name);
    await ctx.answerCbQuery(`✗ ${name}`);
  } else {
    sess.data.selected.add(name);
    await ctx.answerCbQuery(`✓ ${name}`);
  }
  await ctx
    .editMessageReplyMarkup(
      buildAutoAccountsKb(sess.data.allNames, sess.data.selected).reply_markup,
    )
    .catch(() => {});
});

bot.action('at:all', async (ctx) => {
  const sess = sessions.get(ctx.chat.id);
  if (!sess || sess.state !== 'at-pick-accounts') {
    await ctx.answerCbQuery('Session expired');
    return;
  }
  for (const n of sess.data.allNames) sess.data.selected.add(n);
  await ctx.answerCbQuery('✓ All');
  await ctx
    .editMessageReplyMarkup(
      buildAutoAccountsKb(sess.data.allNames, sess.data.selected).reply_markup,
    )
    .catch(() => {});
});

bot.action('at:none', async (ctx) => {
  const sess = sessions.get(ctx.chat.id);
  if (!sess || sess.state !== 'at-pick-accounts') {
    await ctx.answerCbQuery('Session expired');
    return;
  }
  sess.data.selected.clear();
  await ctx.answerCbQuery('✗ Cleared');
  await ctx
    .editMessageReplyMarkup(
      buildAutoAccountsKb(sess.data.allNames, sess.data.selected).reply_markup,
    )
    .catch(() => {});
});

bot.action('at:cancel', async (ctx) => {
  sessions.delete(ctx.chat.id);
  await ctx.answerCbQuery('Cancelled');
  await ctx
    .editMessageText('❌ Auto-task dibatalin.', { parse_mode: 'HTML' })
    .catch(() => {});
});

// Auto-task mode picker → set bulkOpenAfter, advance to delay step
bot.action(/^at:m:(auto|bulk)$/, async (ctx) => {
  const sess = sessions.get(ctx.chat.id);
  if (!sess || sess.state !== 'at-mode') {
    await ctx.answerCbQuery('Session expired');
    return;
  }
  const mode = ctx.match[1]; // 'auto' or 'bulk'
  sess.data.bulkOpenAfter = mode === 'bulk';
  sess.state = 'at-delay';
  await ctx.answerCbQuery(mode === 'bulk' ? '📦 Bulk mode' : '⚡ Per-loop mode');
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await ctx.reply(
    `✓ Mode: <b>${mode === 'bulk' ? '📦 Buy semua → Open semua' : '⚡ Buy + Open per loop'}</b>\n\n` +
      `<b>Delay sebelum mulai?</b>\n` +
      `Format:\n` +
      `• <code>30m</code> = 30 menit\n` +
      `• <code>2h</code> = 2 jam\n` +
      `• <code>1h30m</code> = 1 jam 30 menit\n` +
      `• <code>0</code> = mulai sekarang juga\n` +
      `• Atau angka polos (= menit), contoh <code>90</code> = 90 menit`,
    { parse_mode: 'HTML' },
  );
});

// /buy wizard mode picker → set bulkOpenAfter, run prepareJob
bot.action(/^bm:(auto|bulk)$/, async (ctx) => {
  const sess = sessions.get(ctx.chat.id);
  if (!sess || sess.state !== 'wait-mode') {
    await ctx.answerCbQuery('Session expired');
    return;
  }
  const mode = ctx.match[1];
  const bulkOpenAfter = mode === 'bulk';
  const data = sess.data;
  sessions.delete(ctx.chat.id);
  await ctx.answerCbQuery(bulkOpenAfter ? '📦 Bulk mode' : '⚡ Per-loop mode');
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await prepareJob(ctx, {
    tokenIds: data.tokenIds,
    loopsPerToken: data.loops,
    qty: data.qty,
    openOnly: false,
    bulkOpenAfter,
  });
});

bot.action('bm:cancel', async (ctx) => {
  sessions.delete(ctx.chat.id);
  await ctx.answerCbQuery('Cancelled');
  await ctx
    .editMessageText('❌ Buy dibatalin.', { parse_mode: 'HTML' })
    .catch(() => {});
});

// Move from account picker → task type picker (buy+open vs open-only)
bot.action('at:next', async (ctx) => {
  const sess = sessions.get(ctx.chat.id);
  if (!sess || sess.state !== 'at-pick-accounts') {
    await ctx.answerCbQuery('Session expired');
    return;
  }
  if (!sess.data.selected.size) {
    await ctx.answerCbQuery('Pilih minimal 1 akun');
    return;
  }
  const accountNames = Array.from(sess.data.selected);
  sessions.set(ctx.chat.id, {
    state: 'at-pick-type',
    data: { accountNames },
  });
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await ctx.reply(
    `✓ <b>${accountNames.length}</b> akun: ${escapeHtml(accountNames.join(', '))}\n\n` +
      `<b>Pilih tipe auto-task:</b>\n\n` +
      `💰 <b>Buy + Open</b>: beli token + open box (loop per token)\n` +
      `📦 <b>Open All Boxes</b>: skip beli, langsung open <i>semua</i> ` +
      `box yang udah dimiliki tiap akun. Cocok buat consume puluhan ribu ` +
      `box yang nunggak.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('💰 Buy + Open', 'at:type:buy'),
          Markup.button.callback('📦 Open All Boxes', 'at:type:open'),
        ],
        [Markup.button.callback('❌ Cancel', 'at:cancel')],
      ]),
    },
  );
});

// Type picker: Buy + Open → ask for token IDs
bot.action('at:type:buy', async (ctx) => {
  const sess = sessions.get(ctx.chat.id);
  if (!sess || sess.state !== 'at-pick-type') {
    await ctx.answerCbQuery('Session expired');
    return;
  }
  sess.data.taskMode = 'buy';
  sess.state = 'at-tokens';
  await ctx.answerCbQuery('💰 Buy + Open');
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await ctx.reply(
    `Kirim <b>tboID token</b> yang mau dibeli (comma-separated):\n` +
      `<code>01KQV…ABC, 01KQV…XYZ</code>`,
    { parse_mode: 'HTML' },
  );
});

// Type picker: Open Only → skip langsung ke delay step
bot.action('at:type:open', async (ctx) => {
  const sess = sessions.get(ctx.chat.id);
  if (!sess || sess.state !== 'at-pick-type') {
    await ctx.answerCbQuery('Session expired');
    return;
  }
  sess.data.taskMode = 'open';
  sess.state = 'at-delay';
  await ctx.answerCbQuery('📦 Open All Boxes');
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});
  await ctx.reply(
    `📦 Mode: <b>Open All Boxes</b>\n` +
      `Bot bakal auto-fetch unopened-box list tiap akun, terus open semuanya.\n\n` +
      `<b>Delay sebelum mulai?</b>\n` +
      `Format:\n` +
      `• <code>30m</code> = 30 menit\n` +
      `• <code>2h</code> = 2 jam\n` +
      `• <code>1h30m</code> = 1 jam 30 menit\n` +
      `• <code>0</code> = mulai sekarang juga\n` +
      `• Atau angka polos (= menit), contoh <code>90</code> = 90 menit`,
    { parse_mode: 'HTML' },
  );
});

// Final confirm: schedule the task
bot.action('at:confirm', async (ctx) => {
  const sess = sessions.get(ctx.chat.id);
  if (!sess || sess.state !== 'at-confirm') {
    return replySessionExpired(ctx, 'autotask');
  }
  const busy = checkBusy();
  if (busy) {
    await ctx.answerCbQuery(busy.slice(0, 50));
    return;
  }
  const {
    accountNames,
    tokenIds = [],
    loops = 0,
    qty = { min: 0, max: 0 },
    delayMs,
    startAtMs,
    bulkOpenAfter = false,
    taskMode = 'buy', // 'buy' | 'open'
  } = sess.data;
  sessions.delete(ctx.chat.id);
  await ctx.answerCbQuery('Scheduled');
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});

  // Register the scheduled task
  scheduledTask = {
    chatId: ctx.chat.id,
    accountNames: [...accountNames],
    tokenIds: [...tokenIds],
    loopsPerToken: loops,
    qty,
    bulkOpenAfter,
    taskMode,
    startAtMs,
    timer: null,
    abortCtrl: null,
    status: 'scheduled',
    currentAccountIdx: -1,
    results: [],
  };

  // Wrap runAutoTask launch with a catch — setTimeout swallows the promise,
  // so without this any rejection from runAutoTask would crash the process.
  const launch = () => {
    runAutoTask(ctx).catch((e) => {
      console.error('[auto-task] crash:', e);
      ctx.telegram
        .sendMessage(
          ctx.chat.id,
          `❌ Auto-task crash: ${escapeHtml(e?.message ?? String(e))}`,
          { parse_mode: 'HTML' },
        )
        .catch(() => {});
      if (scheduledTask) scheduledTask.status = 'failed';
    });
  };
  if (delayMs <= 0) {
    // Start now (next tick so the confirmation message renders first)
    scheduledTask.timer = setTimeout(launch, 100);
  } else {
    scheduledTask.timer = setTimeout(launch, delayMs);
  }

  const modeLine =
    taskMode === 'open'
      ? `Mode: <b>📦 Open All Boxes</b>\n`
      : `Token: ${tokenIds.length}\n` +
        `Loops/token: ${loops}\n` +
        `Mode: <b>${bulkOpenAfter ? '📦 Buy semua → Open semua' : '⚡ Buy + Open per loop'}</b>\n`;
  await ctx.reply(
    `⏰ <b>Auto-task scheduled</b>\n\n` +
      `Mulai: <b>${
        delayMs <= 0 ? 'sekarang' : fmtFutureTime(startAtMs)
      }</b>\n` +
      `Akun: ${accountNames.length} (${escapeHtml(accountNames.join(', '))})\n` +
      modeLine +
      `\n<i>Pakai /status buat cek progress, /stop buat batal.</i>\n` +
      `<i>Tidur tenang, gpp matikan HP — bot tetep jalan di komputer 💤</i>`,
    { parse_mode: 'HTML' },
  );
});

// The actual executor: switches account, runs full buy job per account,
// inter-account anti-bot sleep. Fire-and-forget from setTimeout.
async function runAutoTask(ctx) {
  const task = scheduledTask;
  if (!task || task.status !== 'scheduled') return; // already cancelled
  task.status = 'running';
  task.abortCtrl = new AbortController();
  const startedAtMs = Date.now();

  const interMin = (config.interAccountDelay?.min ?? 5 * 60) * 1000;
  const interMax = (config.interAccountDelay?.max ?? 15 * 60) * 1000;

  const startBanner =
    task.taskMode === 'open'
      ? `🚀 <b>Auto-task dimulai</b>\n` +
        `Akun: ${task.accountNames.length}\n` +
        `Mode: 📦 Open All Boxes`
      : `🚀 <b>Auto-task dimulai</b>\n` +
        `Akun: ${task.accountNames.length} · Token: ${task.tokenIds.length} · ` +
        `Loops: ${task.loopsPerToken}\n` +
        `Mode: ${task.bulkOpenAfter ? '📦 Buy semua → Open semua' : '⚡ Buy + Open per loop'}`;
  await ctx.telegram
    .sendMessage(task.chatId, startBanner, { parse_mode: 'HTML' })
    .catch(() => {});

  for (let ai = 0; ai < task.accountNames.length; ai++) {
    if (task.abortCtrl.signal.aborted) break;
    const accountName = task.accountNames[ai];
    task.currentAccountIdx = ai;

    const acct = accounts.get(accountName);
    if (!acct) {
      task.results.push({
        accountName,
        ok: false,
        error: 'account not found',
      });
      await ctx.telegram
        .sendMessage(
          task.chatId,
          `⚠ [${ai + 1}/${task.accountNames.length}] Akun <b>${escapeHtml(accountName)}</b> ga ada di accounts.json — skip`,
          { parse_mode: 'HTML' },
        )
        .catch(() => {});
      continue;
    }

    // Ensure logged in (login is idempotent for our client)
    try {
      const me = await acct.client.get('/api/v1/users/me');
      if (!me.ok) await acct.client.login();
    } catch {
      try {
        await acct.client.login();
      } catch (e) {
        task.results.push({
          accountName,
          ok: false,
          error: `login failed: ${e.message}`,
        });
        await ctx.telegram
          .sendMessage(
            task.chatId,
            `❌ [${ai + 1}/${task.accountNames.length}] Login gagal akun <b>${escapeHtml(accountName)}</b>: ${escapeHtml(e.message)}`,
            { parse_mode: 'HTML' },
          )
          .catch(() => {});
        continue;
      }
    }

    // ─────────── Open-Only mode branch ───────────
    // Skip seluruh buy flow. Fetch unopened-box list, lalu open semua via
    // openAllPicks (yang sudah resilient: retry chunk, skip token kalau persistent fail).
    if (task.taskMode === 'open') {
      const openMsg = await ctx.telegram
        .sendMessage(
          task.chatId,
          `<b>▶️ [${ai + 1}/${task.accountNames.length}] ${escapeHtml(accountName)}</b>\n` +
            `<i>📦 Fetching unopened boxes…</i>`,
          { parse_mode: 'HTML' },
        )
        .catch(() => null);

      let picks;
      try {
        picks = await fetchUnopenedBoxes(acct.client, 100);
      } catch (e) {
        task.results.push({
          accountName,
          ok: false,
          error: `fetch boxes failed: ${e.message}`,
        });
        if (openMsg) {
          await ctx.telegram
            .editMessageText(
              task.chatId,
              openMsg.message_id,
              undefined,
              `<b>❌ [${ai + 1}/${task.accountNames.length}] ${escapeHtml(accountName)}</b>\n` +
                `Fetch box gagal: <code>${escapeHtml(e.message)}</code>`,
              { parse_mode: 'HTML' },
            )
            .catch(() => {});
        }
        // Inter-account delay (sama kayak buy mode)
        const isLast = ai === task.accountNames.length - 1;
        if (!isLast && !task.abortCtrl.signal.aborted) {
          await abortableSleep(
            randInRange(interMin, interMax),
            task.abortCtrl.signal,
          );
        }
        continue;
      }

      const totalBoxes = picks.reduce((s, p) => s + p.unopenedBoxes, 0);
      if (!picks.length || totalBoxes === 0) {
        task.results.push({
          accountName,
          ok: true,
          summary: { totalOpened: 0, txOk: 0, txFail: 0, skipped: [] },
        });
        if (openMsg) {
          await ctx.telegram
            .editMessageText(
              task.chatId,
              openMsg.message_id,
              undefined,
              `<b>ℹ️ [${ai + 1}/${task.accountNames.length}] ${escapeHtml(accountName)}</b>\n` +
                `Ga ada box buat di-open. Skip.`,
              { parse_mode: 'HTML' },
            )
            .catch(() => {});
        }
        const isLast = ai === task.accountNames.length - 1;
        if (!isLast && !task.abortCtrl.signal.aborted) {
          await abortableSleep(
            randInRange(interMin, interMax),
            task.abortCtrl.signal,
          );
        }
        continue;
      }

      // Sub-job state mirip buy mode tapi simpler (no buy/iter/plan)
      const subAbort = new AbortController();
      const onParentAbort = () => subAbort.abort();
      task.abortCtrl.signal.addEventListener('abort', onParentAbort, {
        once: true,
      });

      const openState = {
        totalBoxes,
        opened: 0,
        txOk: 0,
        txFail: 0,
        currentTicker: '',
        currentTokenIdx: 0,
        totalTokens: picks.length,
        status: 'starting',
        skipped: [],
      };

      const formatOpenSubText = () => {
        const pct =
          totalBoxes > 0
            ? Math.floor((openState.opened / totalBoxes) * 100)
            : 0;
        const bar = '█'.repeat(Math.floor(pct / 10)).padEnd(10, '░');
        const tickerLines = picks
          .map((p, idx) => {
            const isCur =
              idx === openState.currentTokenIdx &&
              openState.status !== 'done';
            const mark = isCur ? '⏳' : idx < openState.currentTokenIdx ? '✓' : '○';
            return `${mark} ${escapeHtml(p.tokenTicker)}: ${p.unopenedBoxes} boxes`;
          })
          .join('\n');
        return (
          `<b>▶️ [${ai + 1}/${task.accountNames.length}] ${escapeHtml(accountName)} · 📦 OPEN ALL</b>\n` +
          `<code>${bar}</code> ${pct}% (${openState.opened}/${totalBoxes})\n\n` +
          `Now: ${escapeHtml(openState.currentTicker || '-')} ` +
          `<i>${escapeHtml(openState.status)}</i>\n\n` +
          `Tx ✓ ${openState.txOk} ✗ ${openState.txFail}` +
          (openState.skipped.length ? ` · skip ${openState.skipped.length}` : '') +
          `\n\n${tickerLines}`
        );
      };

      let lastOpenText = '';
      let lastOpenEdit = 0;
      const renderOpenSub = async () => {
        const now = Date.now();
        if (now - lastOpenEdit < 1500) return;
        const text = formatOpenSubText();
        if (text === lastOpenText) return;
        lastOpenText = text;
        lastOpenEdit = now;
        if (!openMsg) return;
        await ctx.telegram
          .editMessageText(
            task.chatId,
            openMsg.message_id,
            undefined,
            text,
            { parse_mode: 'HTML' },
          )
          .catch(() => {});
      };

      // Set currentJob biar /status & /stop work
      currentJob = {
        chatId: task.chatId,
        msgId: openMsg?.message_id,
        abortCtrl: subAbort,
        state: openState,
        renderStatus: formatOpenSubText,
      };

      let openSummary;
      try {
        openSummary = await openAllPicks({
          client: acct.client,
          picks,
          signal: subAbort.signal,
          onProgress: (e) => {
            switch (e.type) {
              case 'token-start':
                openState.currentTokenIdx = e.tokenIdx;
                openState.currentTicker = e.ticker;
                openState.status = `opening ${e.total} boxes`;
                renderOpenSub();
                break;
              case 'chunk-ok':
                openState.opened += e.count;
                openState.txOk++;
                renderOpenSub();
                break;
              case 'chunk-retry':
                openState.txFail++;
                openState.status = `⏳ retry ${e.fails}/${MAX_CHUNK_FAILS_PER_TOKEN} (status ${e.status}, ${(e.waitMs / 1000).toFixed(0)}s)`;
                renderOpenSub();
                break;
              case 'token-skip':
                if (e.reason === 'all-revealed') openState.txFail++;
                openState.skipped.push({
                  ticker: e.ticker,
                  reason: e.reason,
                  remaining: e.remaining,
                });
                openState.status =
                  e.reason === 'all-revealed'
                    ? `↪ ${e.ticker} udah kosong, skip`
                    : `↪ ${e.ticker} skip (${e.remaining} sisa)`;
                renderOpenSub();
                break;
              case 'outage-pause':
                openState.status = `🚨 OUTAGE · pause ${(e.waitMs / 60_000).toFixed(0)}min`;
                renderOpenSub();
                break;
              case 'outage-resume':
                openState.status = '▶️ resume';
                renderOpenSub();
                break;
            }
          },
        });
        task.results.push({
          accountName,
          ok: true,
          summary: {
            totalOpened: openSummary.totalOpened,
            txOk: openSummary.txOk,
            txFail: openSummary.txFail,
            skipped: openState.skipped,
          },
        });
      } catch (e) {
        console.error('[auto-task open]', accountName, e);
        task.results.push({ accountName, ok: false, error: e.message });
      } finally {
        task.abortCtrl.signal.removeEventListener('abort', onParentAbort);
        currentJob = null;
      }

      // Final per-account message (replace live message)
      const skippedNote = openState.skipped.length
        ? `\n${openState.skipped.length} token skipped`
        : '';
      const finalText = openSummary
        ? `<b>✅ [${ai + 1}/${task.accountNames.length}] ${escapeHtml(accountName)} done</b>\n` +
          `Opened <b>${openSummary.totalOpened}/${totalBoxes}</b>\n` +
          `Tx ✓ ${openSummary.txOk} ✗ ${openSummary.txFail}${skippedNote}`
        : `<b>❌ [${ai + 1}/${task.accountNames.length}] ${escapeHtml(accountName)} failed</b>\n` +
          `<i>${escapeHtml(task.results[task.results.length - 1]?.error ?? 'unknown')}</i>`;
      if (openMsg) {
        await ctx.telegram
          .editMessageText(
            task.chatId,
            openMsg.message_id,
            undefined,
            finalText,
            { parse_mode: 'HTML' },
          )
          .catch(() => {});
      }

      // Inter-account anti-bot sleep (same as buy mode)
      const isLast = ai === task.accountNames.length - 1;
      if (!isLast && !task.abortCtrl.signal.aborted) {
        const sleepMs = randInRange(interMin, interMax);
        await ctx.telegram
          .sendMessage(
            task.chatId,
            `💤 Anti-bot sleep <b>${fmtDuration(sleepMs)}</b> sebelum lanjut ke <b>${escapeHtml(task.accountNames[ai + 1])}</b>…`,
            { parse_mode: 'HTML' },
          )
          .catch(() => {});
        await abortableSleep(sleepMs, task.abortCtrl.signal);
      }
      continue; // skip the rest of the buy-mode loop body
    }
    // ─────────── /Open-Only mode branch ───────────

    // Per-account header message (live progress goes to a separate sub-job message)
    await ctx.telegram
      .sendMessage(
        task.chatId,
        `<b>▶️ [${ai + 1}/${task.accountNames.length}] ${escapeHtml(accountName)}</b>\n` +
          `<i>Fetching token details…</i>`,
        { parse_mode: 'HTML' },
      )
      .catch(() => {});

    // Fetch token details for this account's view.
    // Also gate on sale state — a token in post-sale ("step":"claim") or with
    // an expired sale window causes the program to reject purchase_tbos with
    // 0x1784 (InvalidTokenMint) / 0x1783 (TBONotInProposed). Surface the
    // reason clearly instead of burning 10 iterations into a streak-abort.
    const tokens = [];
    const errors = [];
    for (const id of task.tokenIds) {
      if (task.abortCtrl.signal.aborted) break;
      try {
        const det = await acct.client.get(`/api/v1/tokens/${id}`);
        if (!(det.ok && det.data?.success)) {
          errors.push(
            `${id.slice(0, 8)}…: ${JSON.stringify(det.data).slice(0, 80)}`,
          );
          continue;
        }
        const d = det.data.data;
        const step = String(d?.step || '').toLowerCase();
        const endStr = d?.campaign?.boxOffering?.endTimestamp;
        const saleEnd = endStr ? new Date(endStr).getTime() : null;
        const now = Date.now();
        // Reject if the sale is no longer accepting buys.
        if (step === 'claim' || step === 'finished' || step === 'cashout') {
          errors.push(
            `${id.slice(0, 8)}… (${d?.token?.ticker || '?'}): sale sudah berakhir — step="${step}". Token sekarang di phase CLAIM, ga bisa dibeli lagi.`,
          );
          continue;
        }
        if (saleEnd && saleEnd < now) {
          const mins = Math.round((now - saleEnd) / 60000);
          errors.push(
            `${id.slice(0, 8)}… (${d?.token?.ticker || '?'}): sale window udah expired ${mins}m lalu (${endStr}).`,
          );
          continue;
        }
        tokens.push({ tokenId: id, data: d });
      } catch (e) {
        errors.push(`${id.slice(0, 8)}…: ${e.message}`);
      }
    }

    if (!tokens.length) {
      task.results.push({
        accountName,
        ok: false,
        error: `no valid tokens (${errors.length} errs)`,
      });
      await ctx.telegram
        .sendMessage(
          task.chatId,
          `⚠ ${escapeHtml(accountName)}: ga ada token valid, skip\n` +
            `<code>${escapeHtml(errors.join('\n').slice(0, 300))}</code>`,
          { parse_mode: 'HTML' },
        )
        .catch(() => {});
      continue;
    }

    // Anti-bot: shuffle token order per account so they don't all hit the
    // same sequence at the same offset.
    const shuffledIds = [...tokens.map((t) => t.tokenId)].sort(
      () => Math.random() - 0.5,
    );
    const { plan, order } = makePlan(shuffledIds, task.loopsPerToken);

    // Sub-job live message (use raw API to avoid MAIN_MENU keyboard markup)
    const subMsg = await ctx.telegram.sendMessage(
      task.chatId,
      `⏳ <b>${escapeHtml(accountName)}</b> starting…`,
      { parse_mode: 'HTML' },
    );

    // Sub-job abort: aborts when parent aborts
    const subAbort = new AbortController();
    const onParentAbort = () => subAbort.abort();
    task.abortCtrl.signal.addEventListener('abort', onParentAbort, {
      once: true,
    });

    // Throttled sub-job progress message (edits the subMsg)
    const subState = {
      iter: 0,
      total: plan.length,
      txOk: 0,
      txFail: 0,
      bought: 0,
      opened: 0,
      currentTokenId: null,
      currentTicker: '',
      currentQty: 0,
      status: 'starting',
      phase: task.bulkOpenAfter ? 'buying' : null,
      bulkOpenTotal: 0,
      bulkOpenDone: 0,
      perToken: new Map(), // tokenId -> { bought, opened }
      // Track last buy-fail error so the final per-account message can show
      // WHY iterations failed (insufficient SOL, sold-out, nonce mismatch, …).
      // Without this, a streak-abort just looks like "done" with no context.
      lastError: null,
    };
    // Build the rich progress text — also exposed via currentJob.renderStatus
    // so /status can mirror the live message.
    const formatSubText = () => {
      const pct =
        subState.total > 0
          ? Math.floor((subState.iter / subState.total) * 100)
          : 0;
      const bar = '█'.repeat(Math.floor(pct / 10)).padEnd(10, '░');
      const phaseBadge = task.bulkOpenAfter
        ? subState.phase === 'opening'
          ? ' · 📦 OPENING'
          : ' · 📦 BUYING'
        : '';
      const bulkOpenLine =
        task.bulkOpenAfter &&
        subState.phase === 'opening' &&
        subState.bulkOpenTotal > 0
          ? (() => {
              const op = Math.floor(
                (subState.bulkOpenDone / subState.bulkOpenTotal) * 100,
              );
              const obar = '█'.repeat(Math.floor(op / 10)).padEnd(10, '░');
              return `\nOpen: <code>${obar}</code> ${op}% (${subState.bulkOpenDone}/${subState.bulkOpenTotal})`;
            })()
          : '';
      const tickerLine = order
        .map((id) => {
          const t = tokens.find((tt) => tt.tokenId === id);
          const s = subState.perToken?.get(id) ?? { bought: 0, opened: 0 };
          return `• ${t.data.token.ticker}: bought=${s.bought} opened=${s.opened}`;
        })
        .join('\n');
      return (
        `<b>▶️ [${ai + 1}/${task.accountNames.length}] ${escapeHtml(accountName)}${phaseBadge}</b>\n` +
        `<code>${bar}</code> ${pct}% (${subState.iter}/${subState.total})${bulkOpenLine}\n\n` +
        `Now: ${escapeHtml(subState.currentTicker || '-')} ` +
        `<i>${escapeHtml(subState.status)}</i>\n\n` +
        `Tx ✓ ${subState.txOk} ✗ ${subState.txFail}\n` +
        `${tickerLine}`
      );
    };

    let lastSubText = '';
    let lastSubEdit = 0;
    const renderSub = async () => {
      const now = Date.now();
      if (now - lastSubEdit < 1500) return;
      const text = formatSubText();
      if (text === lastSubText) return;
      lastSubText = text;
      lastSubEdit = now;
      await ctx.telegram
        .editMessageText(task.chatId, subMsg.message_id, undefined, text, {
          parse_mode: 'HTML',
        })
        .catch(() => {});
    };

    // Set currentJob so /status shows sub-job state and /stop aborts it.
    // renderStatus lets /status reuse the same rich layout.
    currentJob = {
      chatId: task.chatId,
      msgId: subMsg.message_id,
      abortCtrl: subAbort,
      state: subState,
      renderStatus: formatSubText,
    };
    // Mirror status fields to currentJob.state for /status
    Object.defineProperty(subState, 'currentToken', {
      get() {
        return subState.currentTicker;
      },
    });

    let summary;
    try {
      summary = await runJob({
        conn,
        kp: acct.kp,
        client: acct.client,
        tokens,
        qty: task.qty,
        loopsPerToken: task.loopsPerToken,
        plan,
        order,
        openOnly: false,
        autoOpen: true,
        bulkOpenAfter: task.bulkOpenAfter,
        delays: {
          betweenTx: config.delayBetweenTx,
          postBuy: config.delayBeforeOpen,
          interToken: config.delayBetweenTokens,
          coffee: config.coffeeBreak,
          openChunkDelay: config.delayBetweenOpenChunks,
        },
        signal: subAbort.signal,
        onProgress: (e) => {
          switch (e.type) {
            case 'iter-start':
              subState.iter = e.i + 1;
              subState.currentTokenId = e.tokenId;
              subState.currentTicker = e.ticker;
              subState.currentQty = e.qty;
              subState.status = `buying ${e.qty}…`;
              if (!subState.perToken.has(e.tokenId)) {
                subState.perToken.set(e.tokenId, { bought: 0, opened: 0 });
              }
              renderSub();
              break;
            case 'buy-ok': {
              const st = subState.perToken.get(subState.currentTokenId);
              if (st) st.bought += subState.currentQty;
              subState.status = `✓ bought ${shortSig(e.sig)}`;
              renderSub();
              break;
            }
            case 'buy-fail': {
              // Surface the actual error reason — without this the final
              // message has no clue WHY iterations failed (insufficient SOL,
              // sold-out, nonce mismatch, …).
              const errStr =
                typeof e.err === 'string'
                  ? e.err
                  : JSON.stringify(e.err)?.slice(0, 200) ?? 'unknown';
              const logTail = Array.isArray(e.logs)
                ? e.logs.slice(-3).join(' | ').slice(0, 200)
                : '';
              console.error(
                `[auto-task buy-fail] ${accountName} iter=${e.i} err=${errStr}${
                  logTail ? ` | logs: ${logTail}` : ''
                }`,
              );
              subState.lastError = errStr;
              subState.status = `✗ buy failed: ${errStr.slice(0, 50)}`;
              renderSub();
              break;
            }
            case 'open-fail': {
              const errStr = (e.body ?? `HTTP ${e.status}`).slice(0, 100);
              console.error(
                `[auto-task open-fail] ${accountName} iter=${e.i} status=${e.status} body=${e.body}`,
              );
              subState.lastError = errStr;
              subState.status = `✗ open failed: ${errStr.slice(0, 50)}`;
              renderSub();
              break;
            }
            case 'open-ok': {
              const tokId = e.tokenId ?? subState.currentTokenId;
              const st = subState.perToken.get(tokId);
              if (st) st.opened += e.count;
              if (e.phase === 'bulk') {
                subState.bulkOpenDone += e.count;
                subState.status = `✓ opened ${e.count} (${e.ticker})`;
              } else {
                subState.status = `✓ opened ${e.count}`;
              }
              renderSub();
              break;
            }
            case 'iter-end':
              subState.txOk = e.totals.txOk;
              subState.txFail = e.totals.txFail;
              subState.bought = e.totals.totalBought;
              subState.opened = e.totals.totalOpened;
              renderSub();
              break;
            case 'sleep':
              subState.status =
                e.kind === 'inter-token'
                  ? `🔄 → ${e.nextTicker} (${fmtMs(e.durationMs)})`
                  : e.kind === 'normal'
                    ? `💪 ${fmtMs(e.durationMs)}`
                    : e.kind === 'rate-limit'
                      ? `⏳ rate-limited, cooldown ${fmtMs(e.durationMs)}`
                      : `… ${fmtMs(e.durationMs)} sebelum open`;
              renderSub();
              break;
            case 'phase-change':
              subState.phase = e.phase;
              if (e.phase === 'opening') {
                subState.bulkOpenTotal = 0;
                subState.bulkOpenDone = 0;
                subState.currentTicker = '';
                subState.status = '📦 starting bulk open…';
              }
              renderSub();
              break;
            case 'bulk-open-start':
              subState.bulkOpenTotal += e.total;
              subState.currentTicker = e.ticker;
              subState.status = `📦 opening ${e.total} ${e.ticker}…`;
              renderSub();
              break;
            case 'iter-error':
              subState.lastError = String(e.error);
              console.error(
                `[auto-task iter-error] ${accountName} iter=${e.i}${
                  e.tokenId ? ` token=${e.tokenId}` : ''
                } err=${e.error}`,
              );
              subState.status = `⚠ ${String(e.error).slice(0, 60)}`;
              renderSub();
              break;
            case 'streak-abort':
              console.warn(
                `[auto-task streak-abort] ${e.consecutiveFails} fails — aborting sub-job`,
              );
              subState.status = `🛑 ${e.consecutiveFails} fail berturut, abort`;
              renderSub();
              break;
          }
        },
      });
      task.results.push({ accountName, ok: true, summary });
    } catch (e) {
      console.error('[auto-task sub-job]', accountName, e);
      task.results.push({ accountName, ok: false, error: e.message });
      summary = null;
    } finally {
      task.abortCtrl.signal.removeEventListener('abort', onParentAbort);
      currentJob = null;
    }

    // Final per-account message (replaces the "starting…" subMsg).
    //
    // Three outcomes:
    //   ✅ done       — all iterations completed normally
    //   ⚠ stopped    — runJob returned a summary but with abortReason set
    //                  (streak-abort = 10 consecutive failures, usually
    //                  insufficient SOL / sold-out / nonce mismatch)
    //   ❌ failed    — runJob threw (login/network/etc, no summary)
    let finalText;
    if (!summary) {
      finalText =
        `<b>❌ [${ai + 1}/${task.accountNames.length}] ${escapeHtml(accountName)} failed</b>\n` +
        `<i>${escapeHtml(task.results[task.results.length - 1]?.error ?? 'unknown')}</i>`;
    } else {
      const aborted = !!summary.abortReason;
      const headerIcon = aborted ? '⚠' : '✅';
      const headerLabel = aborted ? 'stopped early' : 'done';
      const reasonLine = aborted
        ? `\n<i>🛑 ${escapeHtml(summary.abortReason)}</i>` +
          (subState.lastError
            ? `\n<i>Last error:</i> <code>${escapeHtml(
                String(subState.lastError).slice(0, 200),
              )}</code>`
            : '')
        : '';
      finalText =
        `<b>${headerIcon} [${ai + 1}/${task.accountNames.length}] ${escapeHtml(accountName)} ${headerLabel}</b>\n` +
        `Iters ${summary.completedIters ?? summary.totalIters}/${summary.totalIters} · ` +
        `Tx ✓ ${summary.txOk} ✗ ${summary.txFail}\n` +
        `Bought <b>${summary.totalBought}</b> · Opened <b>${summary.totalOpened}</b>` +
        (summary.spentLamports != null
          ? `\nSpent ${fmtSol(summary.spentLamports)} SOL`
          : '') +
        reasonLine;
    }
    await ctx.telegram
      .editMessageText(
        task.chatId,
        subMsg.message_id,
        undefined,
        finalText,
        { parse_mode: 'HTML' },
      )
      .catch(() => {});

    // Inter-account anti-bot sleep (skip after last account or if aborted)
    const isLast = ai === task.accountNames.length - 1;
    if (!isLast && !task.abortCtrl.signal.aborted) {
      const sleepMs = randInRange(interMin, interMax);
      await ctx.telegram
        .sendMessage(
          task.chatId,
          `💤 Anti-bot sleep <b>${fmtDuration(sleepMs)}</b> sebelum lanjut ke <b>${escapeHtml(task.accountNames[ai + 1])}</b>…`,
          { parse_mode: 'HTML' },
        )
        .catch(() => {});
      await abortableSleep(sleepMs, task.abortCtrl.signal);
    }
  }

  // Final summary
  const okCount = task.results.filter((r) => r.ok).length;
  const failCount = task.results.filter((r) => !r.ok).length;
  const totalBought = task.results.reduce(
    (s, r) => s + (r.summary?.totalBought ?? 0),
    0,
  );
  const totalOpened = task.results.reduce(
    (s, r) => s + (r.summary?.totalOpened ?? 0),
    0,
  );
  const totalSpent = task.results.reduce(
    (s, r) => s + (r.summary?.spentLamports ?? 0),
    0,
  );
  const elapsedMs = Date.now() - startedAtMs;
  const aborted = task.abortCtrl?.signal.aborted;
  const isOpenMode = task.taskMode === 'open';
  const perAccLines = task.results
    .map((r) => {
      const head = `• <b>${escapeHtml(r.accountName)}</b>: `;
      if (!r.ok) {
        return head + `❌ ${escapeHtml(r.error ?? 'failed').slice(0, 80)}`;
      }
      if (isOpenMode) {
        const skipped = r.summary?.skipped?.length ?? 0;
        return (
          head +
          `opened ${r.summary?.totalOpened ?? 0}` +
          (skipped ? ` · ${skipped} skip` : '')
        );
      }
      return (
        head +
        `bought ${r.summary?.totalBought ?? 0}, opened ${r.summary?.totalOpened ?? 0}`
      );
    })
    .join('\n');

  const totalsBlock = isOpenMode
    ? `Total opened: <b>${totalOpened}</b>\n`
    : `Total bought: <b>${totalBought}</b>\n` +
      `Total opened: <b>${totalOpened}</b>\n` +
      (totalSpent ? `Total spent: <b>${fmtSol(totalSpent)} SOL</b>\n` : '');

  await ctx.telegram
    .sendMessage(
      task.chatId,
      `<b>🏁 Auto-task ${aborted ? 'STOPPED' : 'DONE'}</b>\n\n` +
        `Akun: <b>${okCount}</b> OK · <b>${failCount}</b> fail\n` +
        totalsBlock +
        `Elapsed: ${fmtDuration(elapsedMs)}\n\n` +
        perAccLines,
      { parse_mode: 'HTML' },
    )
    .catch(() => {});

  task.status = aborted ? 'cancelled' : 'done';
  scheduledTask = null;
}

// ───────────────── Daily (gumball) ─────────────────
//
// /daily — spin gumball machine for every account, with a fixed delay
// (default 30 menit, configurable via config.dailyAccountDelay) between
// accounts.  Reuses the `scheduledTask` slot so /status & /stop already work.

// Telegram-formatted rarity label (icon + name).
function rarityLabel(r) {
  switch (String(r).toUpperCase()) {
    case 'COMMON': return '⚪ COMMON';
    case 'UNCOMMON': return '🟢 UNCOMMON';
    case 'RARE': return '🔵 RARE';
    case 'EPIC': return '🟣 EPIC';
    case 'LEGENDARY': return '🟡 LEGENDARY';
    default: return String(r);
  }
}

// Friendly human readable spin error. The server typically returns:
//   "gumball/play 429: {"success":false,"error":{"message":"Rate limit exceeded.
//    Retry after 46854s.","code":429,"errorCode":"RATE_LIMIT_EXCEEDED"}"
// Parse the most useful bit (rate limit retry seconds) when present.
function summarizeSpinError(err) {
  const s = String(err ?? '');
  const m = /Retry after (\d+)s/i.exec(s);
  if (m) {
    const secs = parseInt(m[1], 10);
    return `⏳ rate-limited (retry in ${fmtDuration(secs * 1000)})`;
  }
  if (/429/.test(s)) return '⏳ rate-limited (429)';
  if (/401/.test(s)) return '🔑 auth expired (401)';
  // Generic fallback — clip long JSON dumps.
  return `⚠ ${s.slice(0, 80)}`;
}

async function startDailyWizard(ctx) {
  const busy = checkBusy();
  if (busy) return ctx.reply(busy);

  const allNames = accounts.names();
  if (!allNames.length) {
    return ctx.reply('Ga ada akun. Tambah dulu via /accounts.');
  }

  sessions.set(ctx.chat.id, {
    state: 'daily-pick-delay',
    data: { allNames: [...allNames] },
  });

  await ctx.reply(
    `<b>🎰 Daily Gumball</b>\n\n` +
      `Pilih jeda antar akun (anti-bot):\n` +
      `<i>Multi-cycle retry: burst 30 × 2-4s × 5 cycles dengan pause 5m. Worst-case ~27m/akun.</i>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('⚡ 5 menit', 'dt:delay:5'),
          Markup.button.callback('🚶 10 menit (rec)', 'dt:delay:10'),
          Markup.button.callback('🐢 15 menit', 'dt:delay:15'),
        ],
        [Markup.button.callback('❌ Cancel', 'dt:cancel')],
      ]),
    },
  );
}

// Delay picker → show confirmation with chosen delay.
bot.action(/^dt:delay:(5|10|15)$/, async (ctx) => {
  const sess = sessions.get(ctx.chat.id);
  if (!sess || sess.state !== 'daily-pick-delay') {
    return ctx.answerCbQuery('Session expired. /daily lagi ya');
  }
  const delayMin = parseInt(ctx.match[1], 10);
  sess.data.delayMin = delayMin;
  sess.state = 'daily-confirm';

  const allNames = sess.data.allNames;
  // Multi-cycle: up to 5 cycles, each burst ~1.5m + pause 5m. Worst-case
  // ~27m/akun but typically far less (success in cycle 1-2). Use 8m as a
  // mid-estimate so estimasi total tidak misleading.
  const perAccountMin = 8;
  const estTotalMin = (allNames.length - 1) * delayMin + allNames.length * perAccountMin;

  await ctx.answerCbQuery(`Jeda: ${delayMin}m`);
  await ctx
    .editMessageText(
      `<b>🎰 Daily Gumball — Confirm</b>\n\n` +
        `Spin gumball semua akun sampe <code>playsRemaining = 0</code>.\n` +
        `Per akun max 10 spin/hari (reset tengah malam UTC).\n\n` +
        `Akun (${allNames.length}): <b>${escapeHtml(allNames.join(', '))}</b>\n` +
        `Jeda antar akun: <b>${delayMin} menit</b>\n` +
        `Estimasi total: ~${fmtDuration(estTotalMin * 60_000)}\n\n` +
        `Lanjut?`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('✅ Start', 'dt:start'),
            Markup.button.callback('← Ganti delay', 'dt:back'),
          ],
          [Markup.button.callback('❌ Cancel', 'dt:cancel')],
        ]),
      },
    )
    .catch(() => {});
});

bot.action('dt:back', async (ctx) => {
  const sess = sessions.get(ctx.chat.id);
  if (!sess || sess.state !== 'daily-confirm') {
    return ctx.answerCbQuery('Session expired. /daily lagi ya');
  }
  sess.state = 'daily-pick-delay';
  await ctx.answerCbQuery();
  await ctx
    .editMessageText(
      `<b>🎰 Daily Gumball</b>\n\nPilih jeda antar akun (anti-bot):\n` +
        `<i>Multi-cycle retry: burst 30 × 2-4s × 5 cycles dengan pause 5m. Worst-case ~27m/akun.</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('⚡ 5 menit', 'dt:delay:5'),
            Markup.button.callback('🚶 10 menit (rec)', 'dt:delay:10'),
            Markup.button.callback('🐢 15 menit', 'dt:delay:15'),
          ],
          [Markup.button.callback('❌ Cancel', 'dt:cancel')],
        ]),
      },
    )
    .catch(() => {});
});

bot.action('dt:cancel', async (ctx) => {
  sessions.delete(ctx.chat.id);
  await ctx.answerCbQuery('Cancelled');
  await ctx
    .editMessageText('❌ Daily dibatalin.', { parse_mode: 'HTML' })
    .catch(() => {});
});

bot.action('dt:start', async (ctx) => {
  const sess = sessions.get(ctx.chat.id);
  if (!sess || sess.state !== 'daily-confirm') {
    return replySessionExpired(ctx, 'daily');
  }
  if (scheduledTask || currentJob) {
    sessions.delete(ctx.chat.id);
    return ctx.answerCbQuery('Ada job lain lagi jalan, /stop dulu');
  }

  const accountNames = sess.data.allNames;
  const delayMin = sess.data.delayMin ?? 5;
  sessions.delete(ctx.chat.id);
  await ctx.answerCbQuery('🚀 Starting...');
  await ctx.editMessageReplyMarkup(undefined).catch(() => {});

  scheduledTask = {
    chatId: ctx.chat.id,
    accountNames: [...accountNames],
    taskMode: 'daily',
    dailyDelayMin: delayMin, // carry user-chosen delay into executor
    startAtMs: Date.now(),
    timer: null,
    abortCtrl: null,
    status: 'scheduled',
    currentAccountIdx: -1,
    results: [],
  };

  // Fire-and-forget. setTimeout's callback returns void; if runDailyTask
  // rejects, nothing catches it → process crash. Wrap defensively.
  scheduledTask.timer = setTimeout(() => {
    runDailyTask(ctx).catch((e) => {
      console.error('[daily] crash:', e);
      ctx.telegram
        .sendMessage(
          ctx.chat.id,
          `❌ Daily crash: ${escapeHtml(e?.message ?? String(e))}`,
          { parse_mode: 'HTML' },
        )
        .catch(() => {});
      if (scheduledTask) {
        scheduledTask.status = 'failed';
        scheduledTask = null;
      }
    });
  }, 100);
});

async function runDailyTask(ctx) {
  const task = scheduledTask;
  if (!task || task.status !== 'scheduled') return;
  task.status = 'running';
  task.abortCtrl = new AbortController();
  const startedAtMs = Date.now();

  // User-chosen delay (5/10/15 minutes) from the picker. Fallback 10m kalau
  // task ternyata gak punya field (shouldn't happen, defensive).
  // Jitter ±20% — exact uniform spacing across accounts is itself a
  // bot-signature, so randomize within ~20% to look more human.
  const delayMinutes = task.dailyDelayMin ?? 10;
  const baseMs = delayMinutes * 60 * 1000;
  const delayMin = Math.round(baseMs * 0.8);
  const delayMax = Math.round(baseMs * 1.2);

  await ctx.telegram
    .sendMessage(
      task.chatId,
      `🎰 <b>Daily Gumball dimulai</b>\n` +
        `Akun: ${task.accountNames.length} · Jeda antar akun: ${delayMinutes}m`,
      { parse_mode: 'HTML' },
    )
    .catch(() => {});

  let grandXp = 0;
  let grandSpins = 0;
  // Track consecutive accounts that returned a long (>1h) rate-limit. Two in
  // a row strongly suggests the Zerg API has IP-flagged this VPS, so we
  // bail early instead of waiting through every inter-account delay.
  let consecutiveLongRateLimit = 0;
  const longRateLimitSecs = (errStr) => {
    const m = /Retry after (\d+)s/i.exec(String(errStr ?? ''));
    if (!m) return 0;
    const secs = parseInt(m[1], 10);
    return secs > 3600 ? secs : 0;
  };

  for (let ai = 0; ai < task.accountNames.length; ai++) {
    if (task.abortCtrl.signal.aborted) break;
    const accountName = task.accountNames[ai];
    task.currentAccountIdx = ai;

    const acct = accounts.get(accountName);
    if (!acct) {
      task.results.push({ accountName, ok: false, error: 'account not found' });
      await ctx.telegram
        .sendMessage(
          task.chatId,
          `⚠ [${ai + 1}/${task.accountNames.length}] <b>${escapeHtml(accountName)}</b> ga ada — skip`,
          { parse_mode: 'HTML' },
        )
        .catch(() => {});
      continue;
    }

    // Per-account live message
    const sentMsg = await ctx.telegram
      .sendMessage(
        task.chatId,
        `<b>▶️ [${ai + 1}/${task.accountNames.length}] ${escapeHtml(accountName)}</b>\n` +
          `<i>Cek status…</i>`,
        { parse_mode: 'HTML' },
      )
      .catch(() => null);

    // Make sure logged-in
    try {
      await acct.client.login();
    } catch (e) {
      task.results.push({ accountName, ok: false, error: `login: ${e.message}` });
      if (sentMsg) {
        await ctx.telegram
          .editMessageText(
            task.chatId,
            sentMsg.message_id,
            undefined,
            `<b>❌ [${ai + 1}/${task.accountNames.length}] ${escapeHtml(accountName)}</b>\n` +
              `Login gagal: <code>${escapeHtml(e.message)}</code>`,
            { parse_mode: 'HTML' },
          )
          .catch(() => {});
      }
      // Still respect inter-account delay so user pacing tetap konsisten
      const isLast = ai === task.accountNames.length - 1;
      if (!isLast && !task.abortCtrl.signal.aborted) {
        await abortableSleep(
          randInRange(delayMin, delayMax),
          task.abortCtrl.signal,
        );
      }
      continue;
    }

    // Per-account live render — throttled like the other live messages
    let lastEditTs = 0;
    let pendingEdit = false;
    let lastText = '';
    let editRateLimitUntil = 0;
    const EDIT_THROTTLE_MS = 3000;

    const subState = {
      status: '🔍 fetching status…',
      total: 0,
      done: 0,
      xp: 0,
      lastPrize: '',
      byRarity: {},
      finished: false,
    };

    const buildSubText = () => {
      const tally = Object.entries(subState.byRarity)
        .map(([r, n]) => `${rarityLabel(r)}×${n}`)
        .join('  ') || '-';
      const lines = [
        `<b>${subState.finished ? '✅' : '▶️'} [${ai + 1}/${task.accountNames.length}] ${escapeHtml(accountName)}</b>`,
        `<i>${escapeHtml(subState.status)}</i>`,
        '',
        `Spin: <b>${subState.done}/${subState.total}</b> · XP: <b>+${subState.xp}</b>`,
        `Drops: ${tally}`,
      ];
      if (subState.lastPrize) lines.push(`Last: ${subState.lastPrize}`);
      return lines.join('\n');
    };

    // Debounce loop: while any caller already holds pendingEdit, new events
    // just mutate subState and return. The holder loops after each edit to
    // detect state changes that happened during the API call, so the final
    // state is always flushed. Without this, rapid events during a throttle
    // wait would be silently dropped (caused "stale spinning…" bug).
    const renderSub = async () => {
      if (!sentMsg) return;
      if (pendingEdit) return;
      if (Date.now() < editRateLimitUntil) return;
      pendingEdit = true;
      try {
        while (true) {
          const wait = Math.max(0, EDIT_THROTTLE_MS - (Date.now() - lastEditTs));
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          const text = buildSubText();
          if (text === lastText) break;
          lastText = text;
          lastEditTs = Date.now();
          await ctx.telegram.editMessageText(
            task.chatId,
            sentMsg.message_id,
            undefined,
            text,
            { parse_mode: 'HTML' },
          );
        }
      } catch (e) {
        if (e?.response?.error_code === 429) {
          const retryAfter = (e.response.parameters?.retry_after ?? 60) * 1000;
          editRateLimitUntil = Date.now() + retryAfter;
          console.warn(
            `[daily render] 429 backoff ${(retryAfter / 1000).toFixed(0)}s`,
          );
        }
      } finally {
        pendingEdit = false;
      }
    };

    let summary;
    try {
      summary = await runDailyForAccount({
        client: acct.client,
        signal: task.abortCtrl.signal,
        // Token-bucket rate limit confirmed empirically: retrying through
        // 429s gets ~13% to slip through on initial bursts, so 2-4s gap
        // is the sweet spot — fast enough to ride the bucket, gentle
        // enough to look human. See src/gumball.js for full notes.
        spinDelayMs: { min: 2000, max: 4000 },
        // Bail after 30 consecutive 429s (~75-120s). Means the bucket
        // probably needs a 5-min refill — let caller schedule a retry pass.
        maxConsecutiveFails: 30,
        onProgress: (e) => {
          switch (e.type) {
            case 'status':
              subState.total = e.status?.playsRemaining ?? 0;
              if (!e.status?.isActive) {
                subState.status = '🚫 gumball nonaktif';
              } else if (subState.total === 0) {
                subState.status = '✓ udah max hari ini';
              } else {
                subState.status = `🎰 spinning sampe ${subState.total}…`;
              }
              renderSub();
              break;
            case 'spin-ok':
              subState.done = e.index;
              subState.xp += e.prize?.xpAmount ?? 0;
              subState.byRarity[e.prize.rarity] =
                (subState.byRarity[e.prize.rarity] ?? 0) + 1;
              subState.lastPrize = `${rarityLabel(e.prize.rarity)} +${e.prize.xpAmount} XP`;
              subState.status = `🎰 spinning · ${subState.done}/${subState.total}`;
              renderSub();
              break;
            case 'spin-fail':
              // Multi-cycle retry — log every 5th fail so terminal isn't spammed
              if (e.consecutiveFails % 5 === 0 || e.consecutiveFails === 1) {
                console.warn(
                  `[daily spin-retry] ${accountName} cycle=${e.cycle} consecutive=${e.consecutiveFails}: ${String(e.error).slice(0, 120)}`,
                );
              }
              // Show retry status without marking subjob finished — runner
              // is still trying through cycles.
              if (subState.done > 0) {
                subState.status = `🎰 ${subState.done}/${subState.total} · cycle ${e.cycle} retry ${e.consecutiveFails}/30…`;
              } else {
                subState.status = `🎰 cycle ${e.cycle} retry ${e.consecutiveFails}/30…`;
              }
              renderSub();
              break;
            case 'wait-cooldown':
              // Server told us exactly when next token drips — honor it.
              // Visible to user so they don't think bot is stuck.
              console.log(
                `[daily wait-cooldown] ${accountName} sleeping ${e.retryAfterSec}s (${(e.ms / 1000).toFixed(0)}s)`,
              );
              if (subState.done > 0) {
                subState.status = `🎰 ${subState.done}/${subState.total} · honor cooldown ${fmtMs(e.ms)}`;
              } else {
                subState.status = `⏳ honor cooldown ${fmtMs(e.ms)}`;
              }
              renderSub();
              break;
            case 'cycle-pause':
              // Burst ended (30 consecutive fails). Pausing to let bucket
              // refill before next cycle.
              console.log(
                `[daily cycle-pause] ${accountName} cycle ${e.cycle}/${e.totalCycles} sleeping ${(e.ms / 1000).toFixed(0)}s`,
              );
              if (subState.done > 0) {
                subState.status = `💤 ${subState.done}/${subState.total} · pause ${fmtMs(e.ms)} sebelum cycle ${e.cycle}/${e.totalCycles}`;
              } else {
                subState.status = `💤 pause ${fmtMs(e.ms)} sebelum cycle ${e.cycle}/${e.totalCycles}`;
              }
              renderSub();
              break;
            case 'sleep':
              // No render — too noisy and not informative
              break;
            case 'done':
              subState.finished = true;
              if (e.summary?.spins > 0) {
                const tail = e.summary.bailedOnMaxCycles
                  ? ` (bail after ${e.summary.cycles} cycles)`
                  : '';
                subState.status = `✅ selesai · +${e.summary.xpEarned} XP${tail}`;
              } else if (e.summary?.inactive) {
                subState.status = '🚫 gumball nonaktif';
              } else if (e.summary?.lastError) {
                subState.status = summarizeSpinError(e.summary.lastError);
              } else {
                subState.status = '✓ ga ada spin tersisa';
              }
              renderSub();
              break;
          }
        },
      });
      task.results.push({ accountName, ok: true, summary });
      grandXp += summary.xpEarned ?? 0;
      grandSpins += summary.spins ?? 0;

      // IP-wide bail logic: only flag if account got ZERO spins despite
      // retrying — that means the token bucket is fully drained and refill
      // hasn't helped. With the retry-loop, we expect at least 1 spin/account
      // most of the time, so ZERO consistently is unusual.
      if (summary.spins === 0 && longRateLimitSecs(summary.lastError) > 0) {
        consecutiveLongRateLimit++;
      } else if (summary.spins > 0) {
        consecutiveLongRateLimit = 0;
      }
    } catch (e) {
      console.error('[daily sub-job]', accountName, e);
      task.results.push({ accountName, ok: false, error: e.message });
      if (sentMsg) {
        await ctx.telegram
          .editMessageText(
            task.chatId,
            sentMsg.message_id,
            undefined,
            `<b>❌ [${ai + 1}/${task.accountNames.length}] ${escapeHtml(accountName)}</b>\n` +
              `Error: <code>${escapeHtml(e.message)}</code>`,
            { parse_mode: 'HTML' },
          )
          .catch(() => {});
      }
      // Long-retry 429 surfaced via login or other thrown errors counts too.
      if (longRateLimitSecs(e?.message) > 0) consecutiveLongRateLimit++;
    }

    // Per-account summary sent as a NEW message so the user always sees the
    // outcome even if the throttled live edit got dropped or raced with
    // the inter-account delay sendMessage. Reliable > pretty.
    const lastResult = task.results[task.results.length - 1];
    let summaryLine;
    if (!lastResult.ok) {
      summaryLine = `❌ <b>${escapeHtml(accountName)}</b> — ${escapeHtml(lastResult.error.slice(0, 120))}`;
    } else {
      const s = lastResult.summary ?? {};
      const attemptsTail = s.attempts > s.spins ? ` (${s.attempts} attempts)` : '';
      if (s.inactive) {
        summaryLine = `🚫 <b>${escapeHtml(accountName)}</b> — gumball nonaktif`;
      } else if (s.spins === 0 && s.lastError) {
        // 0 spins despite retrying = token bucket depleted, retry pass nanti
        summaryLine =
          `❌ <b>${escapeHtml(accountName)}</b> — 0 spin (${s.attempts ?? 0} retries) · ` +
          summarizeSpinError(s.lastError);
      } else if (s.spins === 0) {
        summaryLine = `✓ <b>${escapeHtml(accountName)}</b> — udah max hari ini`;
      } else if (s.bailedOnMaxCycles) {
        // All retry cycles exhausted (default 5 × burst+pause). Bucket
        // still locked — usually means server-imposed long cooldown that
        // outlasted our retry budget. /daily lagi nanti.
        summaryLine =
          `⚠ <b>${escapeHtml(accountName)}</b> — +${s.xpEarned} XP (${s.spins} spin)${attemptsTail} · ` +
          `${s.cycles} cycles habis · ` +
          summarizeSpinError(s.lastError);
      } else if (s.lastError) {
        summaryLine =
          `⚠ <b>${escapeHtml(accountName)}</b> — +${s.xpEarned} XP (${s.spins} spin)${attemptsTail} · ` +
          summarizeSpinError(s.lastError);
      } else {
        summaryLine = `✅ <b>${escapeHtml(accountName)}</b> — +${s.xpEarned} XP (${s.spins} spin)${attemptsTail}`;
      }
    }
    await ctx.telegram
      .sendMessage(task.chatId, summaryLine, { parse_mode: 'HTML' })
      .catch(() => {});

    // Bail out early if 2 consecutive accounts came back with >1h retry.
    if (consecutiveLongRateLimit >= 2) {
      const remaining = task.accountNames.length - ai - 1;
      const sample = task.results
        .map((r) => longRateLimitSecs(r.summary?.lastError ?? r.error))
        .filter((s) => s > 0);
      const avgSecs = sample.length
        ? Math.round(sample.reduce((a, b) => a + b, 0) / sample.length)
        : 3600;
      await ctx.telegram
        .sendMessage(
          task.chatId,
          `<b>🛑 IP rate-limited oleh Zerg API</b>\n\n` +
            `${consecutiveLongRateLimit} akun beruntun kena <code>RATE_LIMIT_EXCEEDED</code> ` +
            `dengan retry &gt; 1 jam (rata-rata <b>${fmtDuration(avgSecs * 1000)}</b>).\n` +
            `Anti-abuse Zerg memblokir IP VPS ini, bukan per-akun.\n\n` +
            `Skipping <b>${remaining}</b> akun sisa.\n\n` +
            `<b>Solusi:</b>\n` +
            `• Tunggu sampai retry-window habis\n` +
            `• Spin manual via browser (IP residensial)\n` +
            `• Pake VPN/proxy residensial di VPS`,
          { parse_mode: 'HTML' },
        )
        .catch(() => {});
      break;
    }

    // Inter-account delay (skip kalau akun terakhir / user abort)
    const isLast = ai === task.accountNames.length - 1;
    if (!isLast && !task.abortCtrl.signal.aborted) {
      const waitMs = randInRange(delayMin, delayMax);
      await ctx.telegram
        .sendMessage(
          task.chatId,
          `💤 Jeda <b>${fmtDuration(waitMs)}</b> sebelum akun berikutnya…`,
          { parse_mode: 'HTML' },
        )
        .catch(() => {});
      await abortableSleep(waitMs, task.abortCtrl.signal);
    }
  }

  const aborted = task.abortCtrl.signal.aborted;
  const elapsedMs = Date.now() - startedAtMs;
  const okCount = task.results.filter((r) => r.ok).length;
  const failCount = task.results.length - okCount;

  const perAccLines = task.results
    .map((r, i) => {
      if (!r.ok) return `${i + 1}. ❌ ${r.accountName} — ${r.error}`;
      const s = r.summary ?? {};
      if (s.inactive) return `${i + 1}. 🚫 ${r.accountName} — gumball nonaktif`;
      if (s.spins === 0) {
        // Distinguish actual error (rate-limit, auth, …) from genuine "no
        // spins left" — much less confusing for the user.
        if (s.lastError) {
          return `${i + 1}. ❌ ${r.accountName} — ${summarizeSpinError(s.lastError)}`;
        }
        return `${i + 1}. ✓ ${r.accountName} — udah max`;
      }
      // Partial run (e.g. 3/10 then error)
      if (s.lastError) {
        return (
          `${i + 1}. ⚠ ${r.accountName} — +${s.xpEarned} XP (${s.spins} spin) · ` +
          summarizeSpinError(s.lastError)
        );
      }
      return `${i + 1}. ✅ ${r.accountName} — +${s.xpEarned} XP (${s.spins} spin)`;
    })
    .join('\n');

  await ctx.telegram
    .sendMessage(
      task.chatId,
      `<b>🏁 Daily ${aborted ? 'STOPPED' : 'DONE'}</b>\n\n` +
        `Akun: <b>${okCount}</b> OK · <b>${failCount}</b> fail\n` +
        `Total: <b>+${grandXp} XP</b> dari <b>${grandSpins}</b> spin\n` +
        `Elapsed: ${fmtDuration(elapsedMs)}\n\n` +
        perAccLines,
      { parse_mode: 'HTML' },
    )
    .catch(() => {});

  task.status = aborted ? 'cancelled' : 'done';
  scheduledTask = null;
}

// ───────────────── Launch ─────────────────
bot.catch((err, ctx) => {
  console.error('bot error:', err);
  // Don't spam user with timeout errors (handler ran long but likely still OK)
  const isTimeout =
    err?.name === 'TimeoutError' || /timed out/i.test(err?.message ?? '');
  if (ctx && !isTimeout) {
    ctx.reply(`❌ Internal error: ${err.message}`).catch(() => {});
  }
});

bot.launch();
// telegraf v4 launch() resolves only when bot.stop() is called, so we log
// right after calling it (polling starts asynchronously).
console.log('🤖 Telegram bot online. Send /start in Telegram to begin.');
console.log(`Allowed user IDs: ${config.telegram.allowedUserIds.join(', ')}`);

process.once('SIGINT', () => {
  console.log('\nShutting down…');
  bot.stop('SIGINT');
});
process.once('SIGTERM', () => bot.stop('SIGTERM'));
