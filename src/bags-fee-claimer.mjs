import { BagsSDK } from './bags-sdk.mjs';
import * as db from './db.mjs';
import * as solana from './solana.mjs';
import { decrypt } from './crypto.mjs';

const bagsSDK = new BagsSDK();

function getRandomInterval(minMinutes, maxMinutes) {
  const min = minMinutes * 60 * 1000;
  const max = maxMinutes * 60 * 1000;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function claimFeesForToken(token) {
  try {
    if (!token.wallet_private_key_encrypted || !token.wallet_public_key) {
      console.log(`[bags-fee-claimer] Token ${token.id} missing wallet info, skipping`);
      return null;
    }

    const positions = await bagsSDK.getAllClaimablePositions(token.wallet_public_key);
    
    if (!positions || positions.length === 0) {
      console.log(`[bags-fee-claimer] No claimable fees for token ${token.id}`);
      return null;
    }

    let totalClaimed = 0;

    for (const position of positions) {
      if (position.claimable_amount <= 0) continue;

      try {
        const privateKey = decrypt(token.wallet_private_key_encrypted);
        const claimTx = await solana.signClaimTransaction(
          privateKey,
          position.token_mint,
          position.claimable_amount
        );

        const result = await bagsSDK.claimFees(
          token.wallet_public_key,
          position.token_mint,
          claimTx
        );

        if (result.success) {
          totalClaimed += position.claimable_amount;
          console.log(`[bags-fee-claimer] Claimed ${position.claimable_amount} SOL for token ${token.id}`);
        }
      } catch (claimErr) {
        console.error(`[bags-fee-claimer] Failed to claim for position:`, claimErr.message);
      }
    }

    return totalClaimed > 0 ? totalClaimed : null;
  } catch (err) {
    console.error(`[bags-fee-claimer] Error processing token ${token.id}:`, err.message);
    return null;
  }
}

async function runBagsFeeClaimer() {
  console.log('[bags-fee-claimer] Starting fee claim cycle...');
  
  try {
    const bagsfmTokens = await db.query(
      `SELECT * FROM tokens WHERE venue = 'bags.fm' AND status = 'active'`
    );

    if (!bagsfmTokens.rows || bagsfmTokens.rows.length === 0) {
      console.log('[bags-fee-claimer] No active bags.fm tokens found');
      return;
    }

    console.log(`[bags-fee-claimer] Found ${bagsfmTokens.rows.length} bags.fm tokens to check`);

    for (const token of bagsfmTokens.rows) {
      const claimed = await claimFeesForToken(token);
      
      if (claimed) {
        await db.recordBuybackBurn({
          tokenId: token.id,
          solSpent: claimed * 0.6,
          tokensBurned: 0,
          txSignature: 'bags-fee-claim',
          burnTxSignature: null
        });
      }

      await new Promise(r => setTimeout(r, 1000));
    }

    console.log('[bags-fee-claimer] Fee claim cycle complete');
  } catch (err) {
    console.error('[bags-fee-claimer] Error in fee claim cycle:', err.message);
  }

  const nextInterval = getRandomInterval(3, 10);
  console.log(`[bags-fee-claimer] Next check in ${Math.round(nextInterval / 60000)} minutes`);
  setTimeout(runBagsFeeClaimer, nextInterval);
}

export function startBagsFeeClaimer() {
  console.log('[bags-fee-claimer] Initializing...');
  
  const initialDelay = getRandomInterval(1, 3);
  console.log(`[bags-fee-claimer] First check in ${Math.round(initialDelay / 60000)} minutes`);
  
  setTimeout(runBagsFeeClaimer, initialDelay);
}

export default { startBagsFeeClaimer };
