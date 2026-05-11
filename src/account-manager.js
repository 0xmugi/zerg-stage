// Multi-account management.
// Accounts are stored in `accounts.json`:
// {
//   "active": "main",
//   "list": [
//     { "name": "main",  "privateKey": "bs58..." },
//     { "name": "farm1", "privateKey": "bs58..." }
//   ]
// }
//
// Backward compat: if accounts.json does not exist but pk.txt does,
// auto-migrate pk.txt into accounts.json as "main".

import fs from 'node:fs';
import path from 'node:path';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { ZergClient } from './client.js';

function parsePrivateKey(raw) {
  const s = String(raw).trim();
  const bytes = bs58.decode(s);
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error(`Invalid key length: ${bytes.length}B (need 32 or 64)`);
}

export class AccountManager {
  constructor(storagePath, legacyPkPath) {
    this.storagePath = storagePath;
    this.legacyPkPath = legacyPkPath;
    // name -> { kp, client, privateKey }
    this.accounts = new Map();
    this.activeName = null;
  }

  _read() {
    if (fs.existsSync(this.storagePath)) {
      const raw = fs.readFileSync(this.storagePath, 'utf8');
      return JSON.parse(raw);
    }
    // Migrate from legacy pk.txt if available
    if (this.legacyPkPath && fs.existsSync(this.legacyPkPath)) {
      const pk = fs.readFileSync(this.legacyPkPath, 'utf8').trim();
      // Validate
      parsePrivateKey(pk);
      const migrated = {
        active: 'main',
        list: [{ name: 'main', privateKey: pk }],
      };
      fs.writeFileSync(this.storagePath, JSON.stringify(migrated, null, 2));
      return migrated;
    }
    return { active: null, list: [] };
  }

  _write() {
    const out = {
      active: this.activeName,
      list: Array.from(this.accounts.entries()).map(([name, a]) => ({
        name,
        privateKey: a.privateKey,
      })),
    };
    fs.writeFileSync(
      this.storagePath,
      JSON.stringify(out, null, 2) + '\n',
      { mode: 0o600 }, // owner-only
    );
  }

  // Load all accounts from disk. Does NOT login - caller should login active
  // account after init if needed.
  init() {
    const data = this._read();
    for (const acc of data.list) {
      try {
        const kp = parsePrivateKey(acc.privateKey);
        const client = new ZergClient(kp);
        this.accounts.set(acc.name, {
          kp,
          client,
          privateKey: acc.privateKey,
        });
      } catch (e) {
        console.error(`[accounts] skip "${acc.name}": ${e.message}`);
      }
    }
    if (data.active && this.accounts.has(data.active)) {
      this.activeName = data.active;
    } else {
      this.activeName = this.accounts.keys().next().value ?? null;
    }
  }

  names() {
    return Array.from(this.accounts.keys());
  }

  has(name) {
    return this.accounts.has(name);
  }

  get(name) {
    return this.accounts.get(name) ?? null;
  }

  getActive() {
    if (!this.activeName) return null;
    return this.accounts.get(this.activeName) ?? null;
  }

  // Add a new account. Validates the private key; does NOT login yet.
  // Throws if name exists or key invalid.
  add(name, privateKey) {
    if (!name || /\s/.test(name)) {
      throw new Error('Nama ga boleh kosong / pake spasi');
    }
    // Telegram inline button callback_data is limited to 64 bytes. Reserve
    // ~10 bytes for our prefix (e.g. "acc:rm-ok:") so allow up to 32 chars.
    if (name.length > 32) {
      throw new Error('Nama maksimal 32 karakter');
    }
    // Heuristic: if name looks like a base58 private key (>=43 chars all bs58
    // alphabet) the user probably pasted a key by mistake.
    if (name.length >= 43 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(name)) {
      throw new Error('Nama keliatan kayak private key. Pakai nama pendek (e.g. "main", "farm1")');
    }
    if (this.accounts.has(name)) {
      throw new Error(`Account "${name}" udah ada`);
    }
    const kp = parsePrivateKey(privateKey);
    const client = new ZergClient(kp);
    this.accounts.set(name, { kp, client, privateKey: privateKey.trim() });
    if (!this.activeName) this.activeName = name;
    this._write();
    return this.accounts.get(name);
  }

  // Get account name by index (insertion order). Used for stable callback_data
  // in inline buttons even when account names are too long for callback bytes.
  nameAt(index) {
    return this.names()[index] ?? null;
  }

  indexOf(name) {
    return this.names().indexOf(name);
  }

  remove(name) {
    if (!this.accounts.has(name)) throw new Error(`Account "${name}" ga ada`);
    this.accounts.delete(name);
    if (this.activeName === name) {
      this.activeName = this.accounts.keys().next().value ?? null;
    }
    this._write();
  }

  rename(oldName, newName) {
    if (!this.accounts.has(oldName)) throw new Error(`Account "${oldName}" ga ada`);
    if (this.accounts.has(newName)) throw new Error(`"${newName}" udah ada`);
    const entry = this.accounts.get(oldName);
    this.accounts.delete(oldName);
    this.accounts.set(newName, entry);
    if (this.activeName === oldName) this.activeName = newName;
    this._write();
  }

  // Switch active account. Does NOT login - caller should call
  // .getActive().client.login() after.
  setActive(name) {
    if (!this.accounts.has(name)) throw new Error(`Account "${name}" ga ada`);
    this.activeName = name;
    this._write();
  }
}
