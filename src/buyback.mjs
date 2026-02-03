import { getTokensForBuyback, createBurn } from './db.mjs';
import { getBalance, getTokenBalance, keypairFromSecretKey, signAndSendTransaction, burnTokens } from './solana.mjs';
import { buyTokenTransaction } from './pumpportal.mjs';
import { decrypt } from './crypto.mjs';

const MIN_BALANCE_FOR_BUYBACK = 0.01;
const BUYBACK_RESERVE = 0.01;
const BUYBACK_PERCENTAGE = 0.60; // 60% of fees used for buyback, 40% accumulates
const MAX_RETRIES = 3;

let isRunning = false;

async function withRetry(fn, maxRetries = MAX_RETRIES, label = 'Operation') {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      console.warn(`[Buyback] ${label} attempt ${attempt}/${maxRetries} failed: ${error.message}`);
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

export async function runBuybackCycle() {
  if (isRunning) {
    console.log('[Buyback] Cycle already running, skipping');
    return;
  }
  
  isRunning = true;
  console.log('[Buyback] Starting buyback cycle...');
  
  try {
    const tokens = await getTokensForBuyback();
    console.log(`[Buyback] Checking ${tokens.length} tokens for buyback`);
    
    for (const token of tokens) {
      try {
        await processTokenBuyback(token);
      } catch (error) {
        console.error(`[Buyback] Error processing token ${token.mint_address}:`, error.message);
      }
    }
  } catch (error) {
    console.error('[Buyback] Cycle error:', error.message);
  } finally {
    isRunning = false;
    console.log('[Buyback] Cycle complete');
  }
}

async function processTokenBuyback(token) {
  if (!token.wallet_private_key_encrypted) {
    return;
  }
  
  const secretKey = decrypt(token.wallet_private_key_encrypted);
  const keypair = keypairFromSecretKey(secretKey);
  
  const existingTokenBalance = await getTokenBalance(token.wallet_public_key, token.mint_address);
  if (existingTokenBalance > 0) {
    console.log(`[Buyback] Found ${existingTokenBalance} ${token.symbol} tokens to burn from previous buyback`);
    try {
      const burnSignature = await withRetry(
        () => burnTokens(keypair, token.mint_address, existingTokenBalance),
        MAX_RETRIES,
        `Burn ${token.symbol}`
      );
      console.log(`[Buyback] Burned ${existingTokenBalance} ${token.symbol}, tx: ${burnSignature}`);
      
      await createBurn(token.id, 0, existingTokenBalance, burnSignature);
    } catch (burnError) {
      console.error(`[Buyback] Failed to burn existing tokens: ${burnError.message}`);
    }
  }
  
  const balance = await getBalance(token.wallet_public_key);
  console.log(`[Buyback] Token ${token.symbol}: wallet balance = ${balance} SOL`);
  
  if (balance < MIN_BALANCE_FOR_BUYBACK) {
    return;
  }
  
  const availableFees = balance - BUYBACK_RESERVE;
  const buybackAmount = availableFees * BUYBACK_PERCENTAGE; // Use 60% of fees for buyback
  
  if (buybackAmount <= 0.001) {
    console.log(`[Buyback] Buyback amount too small (${buybackAmount} SOL), skipping`);
    return;
  }
  
  console.log(`[Buyback] Executing buyback: ${buybackAmount.toFixed(4)} SOL (60% of ${availableFees.toFixed(4)} SOL fees) for ${token.symbol}`);
  
  const buySignature = await withRetry(async () => {
    const txBytes = await buyTokenTransaction({
      publicKey: token.wallet_public_key,
      mintAddress: token.mint_address,
      solAmount: buybackAmount,
      slippage: 15,
      priorityFee: 0.001
    });
    return await signAndSendTransaction(txBytes, [keypair]);
  }, MAX_RETRIES, `Buy ${token.symbol}`);
  
  console.log(`[Buyback] Buy tx: ${buySignature}`);
  
  await new Promise(r => setTimeout(r, 3000));
  
  const tokenBalance = await withRetry(
    () => getTokenBalance(token.wallet_public_key, token.mint_address),
    MAX_RETRIES,
    'Get token balance'
  );
  console.log(`[Buyback] Token balance after buy: ${tokenBalance}`);
  
  if (tokenBalance <= 0) {
    console.log(`[Buyback] No tokens to burn for ${token.symbol}`);
    return;
  }
  
  const burnSignature = await withRetry(
    () => burnTokens(keypair, token.mint_address, tokenBalance),
    MAX_RETRIES,
    `Burn ${token.symbol}`
  );
  console.log(`[Buyback] Burn tx: ${burnSignature}`);
  
  await createBurn(token.id, buybackAmount, tokenBalance, burnSignature);
  console.log(`[Buyback] Recorded burn for ${token.symbol}: ${tokenBalance} tokens`);
}

function getRandomInterval() {
  const minMs = 60000;  // 1 minute
  const maxMs = 300000; // 5 minutes
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

function scheduleNextCycle() {
  const interval = getRandomInterval();
  console.log(`[Buyback] Next cycle in ${Math.round(interval / 1000)}s`);
  setTimeout(async () => {
    await runBuybackCycle();
    scheduleNextCycle();
  }, interval);
}

export function startBuybackScheduler() {
  console.log(`[Buyback] Starting scheduler (random 1-5 min intervals)`);
  
  setTimeout(() => {
    runBuybackCycle();
    scheduleNextCycle();
  }, 10000);
}

export default {
  runBuybackCycle,
  startBuybackScheduler
};
