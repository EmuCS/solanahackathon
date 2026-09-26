// One-time devnet setup: keypairs, SOL for fees, and a payout stablecoin.
// Set PAYOUT_MINT (+ PAYOUT_SYMBOL) in .env to use Circle devnet USDC/EURC instead of the test mint.
import { LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction, PublicKey } from '@solana/web3.js';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import { connection, loadOrCreateKeypair, explorerAddr } from '../src/solana.js';
import { runtimeConfig, saveRuntimeConfig } from '../src/config.js';

const service = loadOrCreateKeypair('service'); // pays for registry memos
const treasury = loadOrCreateKeypair('treasury'); // the insurer's payout wallet

const sol = async (pk) => (await connection.getBalance(pk)) / LAMPORTS_PER_SOL;

console.log('service :', service.publicKey.toBase58());
console.log('treasury:', treasury.publicKey.toBase58());

if ((await sol(service.publicKey)) < 0.5) {
  try {
    console.log('Requesting devnet airdrop…');
    const sig = await connection.requestAirdrop(service.publicKey, 1 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, 'confirmed');
  } catch (e) {
    console.log(`Airdrop failed (${e.message.split('\n')[0]}).`);
    console.log(`→ Fund it manually at https://faucet.solana.com with address ${service.publicKey.toBase58()}, then re-run.`);
  }
}
console.log('service SOL :', await sol(service.publicKey));

if ((await sol(service.publicKey)) >= 0.2 && (await sol(treasury.publicKey)) < 0.05) {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: service.publicKey, toPubkey: treasury.publicKey, lamports: 0.1 * LAMPORTS_PER_SOL }),
  );
  await sendAndConfirmTransaction(connection, tx, [service]);
}
console.log('treasury SOL:', await sol(treasury.publicKey));

const cfg = runtimeConfig();
if (!cfg.payoutMint) {
  if ((await sol(service.publicKey)) < 0.05) {
    console.log('Not enough SOL to create the payout mint yet.');
    process.exit(1);
  }
  console.log('Creating devnet test stablecoin (6 decimals)…');
  const mint = await createMint(connection, service, service.publicKey, null, 6);
  const ata = await getOrCreateAssociatedTokenAccount(connection, service, mint, treasury.publicKey);
  await mintTo(connection, service, mint, ata.address, service, 1_000_000n * 10n ** 6n);
  saveRuntimeConfig({ payoutMint: mint.toBase58(), payoutSymbol: 'tUSDC' });
  console.log('payout mint :', mint.toBase58(), '(1,000,000 minted to treasury)');
} else {
  console.log('payout mint :', cfg.payoutMint, cfg.payoutSymbol);
  // make sure the treasury has a token account for the configured mint
  await getOrCreateAssociatedTokenAccount(connection, service, new PublicKey(cfg.payoutMint), treasury.publicKey);
}

console.log('\nTreasury on Explorer:', explorerAddr(treasury.publicKey.toBase58()));
