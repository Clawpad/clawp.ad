import { VersionedTransaction } from '@solana/web3.js';
import * as solana from '../solana.mjs';
import * as jupiter from '../jupiter.mjs';
import * as db from '../db.mjs';
import { keypairFromSecret } from './wallet.mjs';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

export async function buyToken(secretKey, tokenMint, solAmount, slippageBps = 300) {
  const keypair = keypairFromSecret(secretKey);
  const publicKey = keypair.publicKey.toBase58();

  const balance = await solana.getBalance(publicKey);
  if (balance < solAmount + 0.01) {
    throw new Error(`Insufficient SOL. Have ${balance.toFixed(4)}, need ${(solAmount + 0.01).toFixed(4)}`);
  }

  console.log(`[SolAgent] Buying ${solAmount} SOL of ${tokenMint}...`);

  const amountLamports = Math.floor(solAmount * 1e9);
  const quote = await jupiter.getSwapQuote(SOL_MINT, tokenMint, amountLamports, slippageBps);

  if (!quote || !quote.outAmount) {
    throw new Error('No quote available for this token');
  }

  const swapResponse = await jupiter.getSwapTransaction(quote, publicKey);
  const swapTxBuf = Buffer.from(swapResponse.swapTransaction, 'base64');
  const transaction = VersionedTransaction.deserialize(swapTxBuf);

  transaction.sign([keypair]);

  const connection = solana.getConnection();
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    maxRetries: 3
  });

  console.log(`[SolAgent] Buy TX sent: ${signature}`);

  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed'
  );
  console.log(`[SolAgent] Buy confirmed`);

  return {
    signature,
    expectedTokens: quote.outAmount,
    priceImpact: quote.priceImpactPct,
    solSpent: solAmount,
  };
}

export async function sellToken(secretKey, tokenMint, percentage = 100, slippageBps = 300) {
  const keypair = keypairFromSecret(secretKey);
  const publicKey = keypair.publicKey.toBase58();

  const tokenData = await solana.getTokenBalanceRaw(publicKey, tokenMint);
  if (!tokenData || !tokenData.raw || tokenData.raw === '0') {
    throw new Error(`No token balance for ${tokenMint}`);
  }

  const rawAmount = BigInt(tokenData.raw);
  const sellAmountRaw = (rawAmount * BigInt(percentage)) / 100n;
  if (sellAmountRaw <= 0n) {
    throw new Error('Sell amount too small');
  }

  console.log(`[SolAgent] Selling ${percentage}% of ${tokenMint} (${sellAmountRaw.toString()} raw, ${tokenData.uiAmount} ui)...`);

  const quote = await jupiter.getSwapQuote(tokenMint, SOL_MINT, sellAmountRaw.toString(), slippageBps);

  if (!quote || !quote.outAmount) {
    throw new Error('No sell quote available');
  }

  const swapResponse = await jupiter.getSwapTransaction(quote, publicKey);
  const swapTxBuf = Buffer.from(swapResponse.swapTransaction, 'base64');
  const transaction = VersionedTransaction.deserialize(swapTxBuf);

  transaction.sign([keypair]);

  const connection = solana.getConnection();
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    maxRetries: 3
  });

  console.log(`[SolAgent] Sell TX sent: ${signature}`);

  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed'
  );
  console.log(`[SolAgent] Sell confirmed`);

  const solReceived = parseInt(quote.outAmount) / 1e9;

  return {
    signature,
    tokensSold: sellAmountRaw.toString(),
    solReceived,
    priceImpact: quote.priceImpactPct,
  };
}

export async function logTransaction(action, tokenMint, tokenSymbol, amountSol, txSignature, status, triggeredBy = 'auto') {
  try {
    await db.query(
      `INSERT INTO agent_transactions (action, token_mint, token_symbol, amount_sol, tx_signature, status, triggered_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [action, tokenMint, tokenSymbol, amountSol, txSignature, status, triggeredBy]
    );
  } catch (err) {
    console.error('[SolAgent] Failed to log transaction:', err.message);
  }
}
