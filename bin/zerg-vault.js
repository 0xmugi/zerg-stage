#!/usr/bin/env node
// CLI for managing the at-rest encryption of data/ secrets.
//
//   node bin/zerg-vault.js init      # generate keyfile (refuses overwrite)
//   node bin/zerg-vault.js encrypt   # encrypt data/pk.txt + data/accounts.json
//   node bin/zerg-vault.js decrypt   # decrypt back to plaintext
//   node bin/zerg-vault.js status    # show vault state
//   node bin/zerg-vault.js rotate    # generate new key + re-encrypt
//
// See src/vault.js for the crypto format and key-resolution rules.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  loadVaultKey,
  generateKey,
  wrap,
  unwrap,
  isVaultBlob,
  _resetKeyCacheForTests,
} from '../src/vault.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_KEY_PATH =
  process.env.ZERG_VAULT_KEY_PATH ?? path.join(os.homedir(), '.zerg-vault-key');

// Files we manage. pk.txt and accounts.json hold secrets; sessions.json
// is benign UI state but cheap to protect.
const TARGETS = ['pk.txt', 'accounts.json', 'sessions.json'];

function usage(code = 2) {
  process.stderr.write(
    [
      'Usage: node bin/zerg-vault.js <command>',
      '',
      'Commands:',
      `  init       Generate a 32-byte random vault key at ${DEFAULT_KEY_PATH}`,
      '             (refuses to overwrite — back up + delete manually first)',
      '  encrypt    Encrypt data/pk.txt, data/accounts.json, data/sessions.json in-place.',
      '             Idempotent — already-encrypted files are skipped.',
      '  decrypt    Decrypt the same set back to plaintext in-place.',
      '  status     Show which files are encrypted vs plain + keyfile state.',
      '  rotate     Generate a new key and re-encrypt all files. The old key',
      '             is moved to a timestamped backup; keep it until verified.',
      '',
      'Env:',
      '  ZERG_VAULT_KEY_PATH   override default keyfile path',
      '  ZERG_VAULT_KEY        inline key (64 hex or 44 base64 chars)',
      '',
    ].join('\n'),
  );
  process.exit(code);
}

function fmtBytes(n) {
  return `${n}B`;
}

function init() {
  if (fs.existsSync(DEFAULT_KEY_PATH)) {
    console.error(`✗ ${DEFAULT_KEY_PATH} already exists — refusing to overwrite.`);
    console.error('  Back it up, delete it manually, then re-run init.');
    process.exit(1);
  }
  const key = generateKey();
  const hex = key.toString('hex');
  fs.writeFileSync(DEFAULT_KEY_PATH, hex + '\n', { mode: 0o600 });
  console.log(`✓ Generated 32-byte vault key at ${DEFAULT_KEY_PATH} (mode 600)`);
  console.log('');
  console.log('  Key (hex):  ' + hex);
  console.log('');
  console.log('  ⚠ Back this up to a password manager NOW.');
  console.log('    If you lose it, all encrypted data is permanently unrecoverable.');
  console.log('');
  console.log('  Next step:  node bin/zerg-vault.js encrypt');
}

function requireKey() {
  const k = loadVaultKey();
  if (!k) {
    console.error(`✗ No vault key configured.`);
    console.error(`  Run \`node bin/zerg-vault.js init\` first, or set ZERG_VAULT_KEY env.`);
    process.exit(1);
  }
  return k;
}

function encryptAll() {
  const key = requireKey();
  let touched = 0;
  for (const name of TARGETS) {
    const p = path.join(DATA_DIR, name);
    if (!fs.existsSync(p)) {
      console.log(`  -  ${name.padEnd(16)} skip (not present)`);
      continue;
    }
    const raw = fs.readFileSync(p, 'utf8');
    if (isVaultBlob(raw)) {
      console.log(`  ✓  ${name.padEnd(16)} already encrypted`);
      continue;
    }
    const blob = wrap(raw, key);
    fs.writeFileSync(p, blob, { mode: 0o600 });
    touched++;
    console.log(
      `  🔒 ${name.padEnd(16)} encrypted  (${fmtBytes(raw.length)} → ${fmtBytes(blob.length)})`,
    );
  }
  console.log('');
  console.log(touched > 0 ? `✓ ${touched} file(s) encrypted.` : '✓ Nothing to do.');
  if (touched > 0) console.log('  Restart the bot so it picks up the encrypted files.');
}

function decryptAll() {
  const key = requireKey();
  let touched = 0;
  for (const name of TARGETS) {
    const p = path.join(DATA_DIR, name);
    if (!fs.existsSync(p)) {
      console.log(`  -  ${name.padEnd(16)} skip (not present)`);
      continue;
    }
    const raw = fs.readFileSync(p, 'utf8');
    if (!isVaultBlob(raw)) {
      console.log(`  ✓  ${name.padEnd(16)} already plain`);
      continue;
    }
    const plain = unwrap(raw, key);
    fs.writeFileSync(p, plain, { mode: 0o600 });
    touched++;
    console.log(`  📄 ${name.padEnd(16)} decrypted`);
  }
  console.log('');
  console.log(touched > 0 ? `✓ ${touched} file(s) decrypted.` : '✓ Nothing to do.');
}

function status() {
  console.log(`Vault key path:  ${DEFAULT_KEY_PATH}`);
  const k = loadVaultKey();
  console.log(`Vault key state: ${k ? '✓ loaded (32 bytes)' : '✗ not configured'}`);
  console.log('');
  console.log('Files:');
  for (const name of TARGETS) {
    const p = path.join(DATA_DIR, name);
    if (!fs.existsSync(p)) {
      console.log(`  -  ${name.padEnd(16)} not found`);
      continue;
    }
    const raw = fs.readFileSync(p, 'utf8');
    const enc = isVaultBlob(raw);
    const stat = fs.statSync(p);
    const mode = (stat.mode & 0o777).toString(8).padStart(3, '0');
    console.log(
      `  ${enc ? '🔒' : '📄'} ${name.padEnd(16)} ${enc ? 'encrypted' : 'plain    '}  mode ${mode}  size ${fmtBytes(stat.size)}`,
    );
  }
}

function rotate() {
  const oldKey = requireKey();
  // Decrypt everything to memory using current key.
  const decrypted = {};
  for (const name of TARGETS) {
    const p = path.join(DATA_DIR, name);
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p, 'utf8');
    decrypted[name] = isVaultBlob(raw) ? unwrap(raw, oldKey) : raw;
  }

  // Back up old keyfile.
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${DEFAULT_KEY_PATH}.bak-${ts}`;
  fs.copyFileSync(DEFAULT_KEY_PATH, backup);
  fs.chmodSync(backup, 0o600);
  console.log(`✓ Old key backed up to ${backup}`);

  // Install new key.
  const newKey = generateKey();
  fs.writeFileSync(DEFAULT_KEY_PATH, newKey.toString('hex') + '\n', { mode: 0o600 });
  _resetKeyCacheForTests();
  console.log(`✓ New key installed at ${DEFAULT_KEY_PATH}`);

  // Re-encrypt with new key (bypass cache — pass newKey directly to wrap).
  for (const [name, plain] of Object.entries(decrypted)) {
    const p = path.join(DATA_DIR, name);
    fs.writeFileSync(p, wrap(plain, newKey), { mode: 0o600 });
    console.log(`  🔒 ${name.padEnd(16)} re-encrypted`);
  }
  console.log('');
  console.log('⚠ Restart the bot, then verify it can read accounts. If yes, delete the backup:');
  console.log(`    rm ${backup}`);
}

const cmd = process.argv[2];
switch (cmd) {
  case 'init':
    init();
    break;
  case 'encrypt':
    encryptAll();
    break;
  case 'decrypt':
    decryptAll();
    break;
  case 'status':
    status();
    break;
  case 'rotate':
    rotate();
    break;
  case '-h':
  case '--help':
  case 'help':
    usage(0);
    break;
  default:
    usage();
}
