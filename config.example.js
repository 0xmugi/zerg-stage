// Copy this file to `config.js` and fill in your values.
// `config.js` is gitignored — never commit it (contains bot token + RPC keys).
//
// See README.md "Setup di VPS" section for full instructions.

export const config = {
  // ───── 1. RPC ─────
  // Array of Solana devnet RPC URLs. Bot auto-failover kalau satu down/429.
  // Get free Helius key at https://helius.dev (pick Devnet).
  rpcUrls: [
    'https://devnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY',
    'https://api.devnet.solana.com',
  ],

  // ───── 2. Telegram ─────
  telegram: {
    // Get from @BotFather (Telegram). Format: "123456:ABCdef..."
    botToken: 'PASTE_YOUR_BOT_TOKEN_HERE',

    // Get your numeric ID from @userinfobot (Telegram).
    // Array — only these user IDs can interact with the bot.
    allowedUserIds: [0], // replace 0 with your real ID (number, no quotes)
  },

  // ───── 3. Buy/Open defaults ─────
  defaultLoopsPerToken: 10,
  defaultQtyPerTx: { min: 20, max: 25 }, // max 25 per Zerg API limit

  // ───── 4. Anti-bot delays (seconds unless noted) ─────
  delayBetweenTx: { min: 1, max: 3 },      // between successive buys
  delayBeforeOpen: { min: 1, max: 3 },     // after buy, before open
  delayBetweenTokens: { min: 5, max: 5 },  // switching to next token
  delayBetweenOpenChunks: { min: 500, max: 1500 }, // ms between open chunks
  coffeeBreak: { everyN: 50, min: 30, max: 60 },   // long pause every N tx

  // ───── 5. /autotask inter-account delay (seconds) ─────
  // After one account finishes its sub-job, wait this long before switching to
  // the next account. Random within the range.
  interAccountDelay: { min: 300, max: 900 }, // 5-15 min
};
