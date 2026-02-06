import * as bagsSDK from './bags-sdk.mjs';
import * as db from './db.mjs';
import * as solana from './solana.mjs';
import { decrypt } from './crypto.mjs';
import { buyTokenWithSol } from './jupiter.mjs';

const BUYBACK_PERCENTAGE = 0.60;
const MIN_BALANCE_FOR_BUYBACK = 0.01;

function getRandomInterval(minMinutes, maxMinutes) {
  const min = minMinutes * 60 * 1000;
  const max = maxMinutes * 60 * 1000;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function claimFeesForToken(token) {
  try {
    if (!token.wallet_private_key_encrypted || !token.wallet_public_key) {
      console.log(`[bags-cycle] Token ${token.id} missing wallet info, skipping`);
      return { claimed: false, claimedAmount: 0 };
    }

    const balanceBefore = await solana.getBalance(token.wallet_public_key);
    console.log(`[bags-cycle] Step 1: Claiming fees for ${token.symbol}... (balance before: ${balanceBefore.toFixed(6)} SOL)`);

    const privateKey = decrypt(token.wallet_private_key_encrypted);
    const keypair = solana.keypairFromSecretKey(privateKey);

    const claimResult = await bagsSDK.claimFees(keypair, token.mint_address);

    if (!claimResult) {
      console.log(`[bags-cycle] No claimable fees or claim failed for ${token.symbol}`);
      return { claimed: false, claimedAmount: 0 };
    }

    console.log(`[bags-cycle] Claim tx: ${claimResult}`);

    await new Promise(r => setTimeout(r, 3000));
    const balanceAfter = await solana.getBalance(token.wallet_public_key);
    const claimedAmount = Math.max(0, balanceAfter - balanceBefore);
    console.log(`[bags-cycle] Fees claimed: ${claimedAmount.toFixed(6)} SOL (balance after: ${balanceAfter.toFixed(6)} SOL)`);
    
    return { claimed: true, claimedAmount, balance: balanceAfter };
  } catch (err) {
    console.error(`[bags-cycle] Error claiming for ${token.symbol}:`, err.message);
    return { claimed: false, claimedAmount: 0 };
  }
}

async function buybackAndBurnForToken(token, claimedAmount) {
  try {
    const privateKey = decrypt(token.wallet_private_key_encrypted);
    const keypair = solana.keypairFromSecretKey(privateKey);

    const balance = await solana.getBalance(token.wallet_public_key);
    
    if (balance < MIN_BALANCE_FOR_BUYBACK) {
      console.log(`[bags-cycle] Balance ${balance.toFixed(6)} SOL below minimum, skipping buyback`);
      return false;
    }

    if (claimedAmount <= 0) {
      console.log(`[bags-cycle] No fees claimed this cycle, skipping buyback`);
      return false;
    }

    const buybackAmount = claimedAmount * BUYBACK_PERCENTAGE;
    const keepAmount = claimedAmount * (1 - BUYBACK_PERCENTAGE);

    if (buybackAmount < 0.005) {
      console.log(`[bags-cycle] Buyback amount ${buybackAmount.toFixed(6)} SOL too small, skipping`);
      console.log(`[bags-cycle] Keeping 100% of claimed fees in wallet`);
      return false;
    }
    
    console.log(`[bags-cycle] Step 3: Buyback ${buybackAmount.toFixed(6)} SOL (60% of claimed ${claimedAmount.toFixed(6)}) for ${token.symbol}`);
    console.log(`[bags-cycle] Keeping ${keepAmount.toFixed(6)} SOL (40%) in wallet`);
    
    const txFeeReserve = 0.005;
    if (balance < buybackAmount + txFeeReserve) {
      console.log(`[bags-cycle] Insufficient balance for buyback + fees, skipping`);
      return false;
    }
    
    let jupiterResult;
    try {
      jupiterResult = await buyTokenWithSol(keypair, token.mint_address, buybackAmount, 150);
      console.log(`[bags-cycle] Buy tx: ${jupiterResult.signature}`);
    } catch (swapErr) {
      console.error(`[bags-cycle] Jupiter swap failed:`, swapErr.message);
      console.log(`[bags-cycle] Keeping all claimed fees in wallet due to swap failure`);
      return false;
    }
    
    await new Promise(r => setTimeout(r, 3000));
    
    const tokenBalance = await solana.getTokenBalance(token.wallet_public_key, token.mint_address);
    console.log(`[bags-cycle] Step 4: Burning ${tokenBalance} ${token.symbol} tokens...`);
    
    if (tokenBalance > 0) {
      const burnSignature = await solana.burnTokens(keypair, token.mint_address, tokenBalance);
      console.log(`[bags-cycle] Burn tx: ${burnSignature}`);
      
      await db.createBurn(token.id, buybackAmount, tokenBalance, burnSignature);
      console.log(`[bags-cycle] Recorded burn: ${tokenBalance} tokens for ${buybackAmount.toFixed(6)} SOL`);
    }
    
    return true;
    
  } catch (err) {
    console.error(`[bags-cycle] Buyback/burn error for ${token.symbol}:`, err.message);
    return false;
  }
}

async function runBagsClaimBuybackBurnCycle() {
  console.log('[bags-cycle] ========== Starting Claim → Buyback → Burn cycle ==========');
  
  try {
    const tokens = await db.getActiveTokensByVenue('bags.fm');
    
    if (!tokens || tokens.length === 0) {
      console.log('[bags-cycle] No active bags.fm tokens found');
      return;
    }
    
    console.log(`[bags-cycle] Processing ${tokens.length} bags.fm token(s)`);
    
    for (const token of tokens) {
      try {
        console.log(`[bags-cycle] --- Processing ${token.symbol} ---`);
        
        const { claimed, claimedAmount } = await claimFeesForToken(token);
        
        if (claimed && claimedAmount > 0) {
          await buybackAndBurnForToken(token, claimedAmount);
        } else {
          console.log(`[bags-cycle] No new fees claimed for ${token.symbol}, skipping buyback (40% accumulates in wallet)`);
        }
        
      } catch (tokenErr) {
        console.error(`[bags-cycle] Error processing ${token.symbol}:`, tokenErr.message);
      }
    }
    
  } catch (err) {
    console.error('[bags-cycle] Cycle error:', err.message);
  }
  
  console.log('[bags-cycle] ========== Cycle complete ==========');
}

export function startBagsFeeClaimer() {
  console.log('[bags-cycle] Initializing Claim → Buyback → Burn system for bags.fm...');
  
  const firstInterval = getRandomInterval(1, 3);
  console.log(`[bags-cycle] First cycle in ${Math.round(firstInterval / 60000)} minutes`);
  
  setTimeout(async function cycle() {
    await runBagsClaimBuybackBurnCycle();
    
    const nextInterval = getRandomInterval(2, 10);
    console.log(`[bags-cycle] Next cycle in ${Math.round(nextInterval / 60000)} minutes`);
    setTimeout(cycle, nextInterval);
  }, firstInterval);
}

export default { startBagsFeeClaimer };
