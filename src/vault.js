// At-rest encryption for sensitive files (pk.txt, accounts.json).
//
// Threat model: an attacker exfiltrates the data/ folder (or a backup
// tarball, or your laptop) but NOT the keyfile stored outside the project
// directory (e.g. ~/.zerg-vault-key). They cannot recover the private keys.
//
// Crypto: AES-256-GCM (authenticated). 32-byte key, 12-byte random IV per
// encryption, 16-byte auth tag.
//
// File format is self-describing so the reader can detect encrypted vs
// plain without filename changes:
//
//   ZERG1\n
//   <base64(iv[12] || ciphertext || tag[16])>\n
//
// Key resolution (first match wins):
//   1. process.env.ZERG_VAULT_KEY              (inline, hex or base64 of 32B)
//   2. process.env.ZERG_VAULT_KEY_PATH         (path to keyfile)
//   3. ~/.zerg-vault-key                       (default)
//
// If no key is configured, read/write fall back to plaintext (preserves
// existing local-dev workflow).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const MAGIC = 'ZERG1';
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

// Module-scoped cache. undefined = not yet loaded, null = no key configured.
let _cachedKey;

// Lazily resolve the vault key. Returns Buffer(32) or null.
// Throws if a key source is configured but invalid.
export function loadVaultKey() {
  if (_cachedKey !== undefined) return _cachedKey;
  _cachedKey = _resolveKey();
  return _cachedKey;
}

// For tests / `rotate` flow: discard cached key so next loadVaultKey() re-reads.
export function _resetKeyCacheForTests() {
  _cachedKey = undefined;
}

function _resolveKey() {
  const inline = process.env.ZERG_VAULT_KEY;
  if (inline && inline.trim()) {
    const k = decodeKey(inline.trim());
    if (!k) {
      throw new Error(
        'ZERG_VAULT_KEY env is set but invalid (need 64 hex chars or 44 base64 chars = 32 bytes)',
      );
    }
    return k;
  }

  const keyPath =
    process.env.ZERG_VAULT_KEY_PATH ?? path.join(os.homedir(), '.zerg-vault-key');
  if (!fs.existsSync(keyPath)) return null;

  let raw;
  try {
    raw = fs.readFileSync(keyPath, 'utf8').trim();
  } catch (e) {
    throw new Error(`Vault keyfile ${keyPath} not readable: ${e.message}`);
  }
  const k = decodeKey(raw);
  if (!k) {
    throw new Error(
      `Vault keyfile ${keyPath} invalid (need 64 hex chars or 44 base64 chars = 32 bytes)`,
    );
  }
  return k;
}

function decodeKey(raw) {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  try {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === KEY_LEN) return buf;
  } catch {
    /* fallthrough */
  }
  return null;
}

// Generate a fresh 32-byte random key.
export function generateKey() {
  return crypto.randomBytes(KEY_LEN);
}

// Wrap plaintext into a self-describing vault blob string.
export function wrap(plaintext, key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_LEN) {
    throw new Error(`Vault key must be ${KEY_LEN}-byte Buffer`);
  }
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const pt = Buffer.from(String(plaintext), 'utf8');
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, ct, tag]).toString('base64');
  return `${MAGIC}\n${payload}\n`;
}

// Unwrap a vault blob back to plaintext. Throws on tamper / wrong key.
export function unwrap(blob, key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_LEN) {
    throw new Error(`Vault key must be ${KEY_LEN}-byte Buffer`);
  }
  const text = String(blob);
  const nl = text.indexOf('\n');
  if (nl < 0 || text.slice(0, nl) !== MAGIC) {
    throw new Error('Not a vault blob (missing ZERG1 header)');
  }
  const payload = Buffer.from(text.slice(nl + 1).trim(), 'base64');
  if (payload.length < IV_LEN + TAG_LEN) {
    throw new Error('Vault blob truncated');
  }
  const iv = payload.subarray(0, IV_LEN);
  const tag = payload.subarray(payload.length - TAG_LEN);
  const ct = payload.subarray(IV_LEN, payload.length - TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (e) {
    throw new Error(
      `Vault decrypt failed (wrong key or tampered blob): ${e.message}`,
    );
  }
}

// Cheap content sniff — does this look like a vault blob?
export function isVaultBlob(content) {
  return String(content).startsWith(`${MAGIC}\n`);
}

// Read a file that may be plain or vault-encrypted. Returns plaintext.
// Throws if the file is encrypted but no key is configured.
export function readMaybeVault(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  if (!isVaultBlob(raw)) return raw;
  const key = loadVaultKey();
  if (!key) {
    throw new Error(
      `${filePath} is encrypted but no vault key configured. ` +
        `Set ZERG_VAULT_KEY env or place keyfile at ~/.zerg-vault-key`,
    );
  }
  return unwrap(raw, key);
}

// Write a file. If a vault key is configured, the file is encrypted;
// otherwise it's written plaintext. Always mode 0o600.
export function writeMaybeVault(filePath, plaintext) {
  const key = loadVaultKey();
  const content = key ? wrap(plaintext, key) : String(plaintext);
  fs.writeFileSync(filePath, content, { mode: 0o600 });
}

export const VAULT_MAGIC = MAGIC;
