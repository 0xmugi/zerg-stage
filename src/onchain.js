import {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';

// Covenant A program (stage/devnet) - from frontend chunk analysis
export const PROGRAM_ID = new PublicKey(
  '4nAmLviJuLEzy87mekN4SCEpVcx2ymG2e5ukCbnHvaHo',
);

// SPL Token-2022 program (the program owning all tbo_token mints/vaults).
export const TOKEN_2022_PROGRAM_ID = new PublicKey(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
);

// Associated Token Account program.
export const ATA_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);

// Anchor discriminator for purchase_tbos = sha256("global:purchase_tbos")[:8]
export const DISC_PURCHASE_TBOS = Buffer.from([
  142, 234, 185, 188, 123, 80, 78, 178,
]);

// Anchor discriminator for claim_tokens = sha256("global:claim_tokens")[:8]
export const DISC_CLAIM_TOKENS = Buffer.from([
  108, 216, 210, 231, 0, 212, 42, 64,
]);

export function u64LE(n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}

export function pda(seeds, programId = PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

export function derivePurchasePdas({
  onChainId,
  campaignIndex,
  signer,
  nonce,
}) {
  const tboIdLE = u64LE(onChainId);
  const campaignIdLE = u64LE(campaignIndex);
  const nonceLE = u64LE(nonce);
  const signerBuf = signer.toBuffer();

  const globalConfig = pda([Buffer.from('global_config')]);
  const tboConfig = pda([Buffer.from('tbo_config'), tboIdLE]);
  const campaignTboConfig = pda([
    Buffer.from('campaign_tbo_config'),
    tboIdLE,
    campaignIdLE,
  ]);
  const userTboPurchases = pda([
    Buffer.from('user_tbo_purchases'),
    tboIdLE,
    signerBuf,
  ]);
  const userTboSinglePurchase = pda([
    Buffer.from('user_tbo_single_purchase'),
    tboIdLE,
    campaignIdLE,
    signerBuf,
    nonceLE,
  ]);

  return {
    globalConfig,
    tboConfig,
    campaignTboConfig,
    userTboPurchases,
    userTboSinglePurchase,
  };
}

// Reads the on-chain `user_tbo_purchases` account and returns `total_purchased` as BigInt.
// Layout: [8 disc][8 tbo_id][8 total_purchased][8 total_tokens_received][8 total_tokens_claimed]
// Returns 0n if the account does not exist yet (first purchase).
export async function readUserTotalPurchased(conn, userTboPurchasesPda) {
  const info = await conn.getAccountInfo(userTboPurchasesPda, 'confirmed');
  if (!info) return 0n;
  if (info.data.length < 24) {
    throw new Error(
      `user_tbo_purchases account too small: ${info.data.length}B`,
    );
  }
  return info.data.readBigUInt64LE(16);
}

export function buildPurchaseIx({
  onChainId,
  campaignIndex,
  quantity,
  nonce,
  signer,
}) {
  const tboIdLE = u64LE(onChainId);
  const campaignIdLE = u64LE(campaignIndex);
  const qtyLE = u64LE(quantity);
  const nonceLE = u64LE(nonce);

  const pdas = derivePurchasePdas({ onChainId, campaignIndex, signer, nonce });

  // disc + tbo_id + campaign_id + quantity + nonce (8*5 = 40B)
  const data = Buffer.concat([
    DISC_PURCHASE_TBOS,
    tboIdLE,
    campaignIdLE,
    qtyLE,
    nonceLE,
  ]);

  // Account order MUST match IDL `purchase_tbos.accounts` exactly:
  // 1. global_config (PDA, W)
  // 2. tbo_config (PDA, W)
  // 3. campaign_tbo_config (PDA, W)
  // 4. user_tbo_purchases (PDA, W) - init_if_needed
  // 5. user_tbo_single_purchase (PDA, W) - init (this is why nonce must be unique)
  // 6. signer (W, S)
  // 7. token_program - Token-2022 (program also uses for token validation,
  //    even when no transfer happens in this ix). Missing/wrong slot here
  //    causes 0x1784 (InvalidTokenMint) on TBOs whose status validates it.
  // 8. system_program (1111...)
  // 9. associated_token_program (ATokenG...)
  // 10. rent sysvar (SysvarRent111...)
  const keys = [
    { pubkey: pdas.globalConfig, isSigner: false, isWritable: true },
    { pubkey: pdas.tboConfig, isSigner: false, isWritable: true },
    { pubkey: pdas.campaignTboConfig, isSigner: false, isWritable: true },
    { pubkey: pdas.userTboPurchases, isSigner: false, isWritable: true },
    { pubkey: pdas.userTboSinglePurchase, isSigner: false, isWritable: true },
    { pubkey: signer, isSigner: true, isWritable: true },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: ATA_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ];

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys,
    data,
  });

  return { ix, pdas, data };
}

// ───────────────── Claim ─────────────────

// Returns the Associated Token Account PDA for (owner, mint) with Token-2022.
// `allowOwnerOffCurve=true` for owners that are PDAs (e.g., tbo_config vault).
export function deriveAta(owner, mint) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_2022_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM_ID,
  )[0];
}

// PDAs needed by the claim_tokens instruction.
export function deriveClaimPdas({ onChainId, signer }) {
  const onChainIdLE = u64LE(onChainId);
  const signerBuf = signer.toBuffer();

  const globalConfig = pda([Buffer.from('global_config')]);
  const tboConfig = pda([Buffer.from('tbo_config'), onChainIdLE]);
  const tboTokenMint = pda([Buffer.from('tbo_token'), onChainIdLE]);
  const userTboPurchases = pda([
    Buffer.from('user_tbo_purchases'),
    onChainIdLE,
    signerBuf,
  ]);
  // Vault: ATA owned by tbo_config. ATA derivation works for off-curve owners.
  const vaultAta = deriveAta(tboConfig, tboTokenMint);
  // Destination: user's ATA for the token mint.
  const userAta = deriveAta(signer, tboTokenMint);

  return {
    globalConfig,
    tboConfig,
    tboTokenMint,
    vaultAta,
    userTboPurchases,
    userAta,
  };
}

// Build the AssociatedTokenAccount "CreateIdempotent" instruction. This
// safely creates the user's ATA for a given mint (no-op if it already exists).
// Instruction byte 0x01 = CreateIdempotent.
// Account order: payer(W,S), ata(W), owner, mint, system_program, token_program.
export function buildCreateAtaIdempotentIx({ payer, owner, mint }) {
  const ata = deriveAta(owner, mint);
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: ata, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({
    programId: ATA_PROGRAM_ID,
    keys,
    data: Buffer.from([0x01]), // CreateIdempotent
  });
}

// Build the claim_tokens instruction.
// Args (after disc): on_chain_id: u64, amount: u64
// Account order (per reverse-engineered tx):
//   global_config (W), tbo_config (W), tbo_token mint (W),
//   vault_ata (W), user_tbo_purchases (W),
//   user_ata (W), signer (W,S),
//   token_2022 program, ata program
export function buildClaimIx({ onChainId, amount, signer }) {
  const pdas = deriveClaimPdas({ onChainId, signer });
  const data = Buffer.concat([
    DISC_CLAIM_TOKENS,
    u64LE(onChainId),
    u64LE(amount),
  ]);
  const keys = [
    { pubkey: pdas.globalConfig, isSigner: false, isWritable: true },
    { pubkey: pdas.tboConfig, isSigner: false, isWritable: true },
    { pubkey: pdas.tboTokenMint, isSigner: false, isWritable: true },
    { pubkey: pdas.vaultAta, isSigner: false, isWritable: true },
    { pubkey: pdas.userTboPurchases, isSigner: false, isWritable: true },
    { pubkey: pdas.userAta, isSigner: false, isWritable: true },
    { pubkey: signer, isSigner: true, isWritable: true },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ATA_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys,
    data,
  });
  return { ix, pdas, data };
}
