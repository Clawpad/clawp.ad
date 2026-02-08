import * as fourmemeSDK from './fourmeme.mjs';
import * as db from './db.mjs';
import * as bnbWallet from './bnb-wallet.mjs';
import { decrypt } from './crypto.mjs';
import crypto from 'crypto';

const CREATOR_SHARE = 0.30;
const BUYBACK_SHARE = 0.50;
const TREASURY_SHARE = 0.15;
const GAS_RESERVE_SHARE = 0.05;
const MIN_CLAIM_AMOUNT = 0.0005;

const TREASURY_WALLET = process.env.CLAWP_TREASURY_BNB;

function getRandomInterval(minMinutes, maxMinutes) {
  const min = minMinutes * 60 * 1000;
  const max = maxMinutes * 60 * 1000;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function claimAndDistributeForToken(token) {
  try {
    if (!token.wallet_private_key_encrypted || !token.wallet_public_key) {
      console.log(`[FourMemeCycle] Token ${token.id} missing wallet info, skipping`);
      return;
    }

    const claimable = await fourmemeSDK.getClaimableTaxFees(token.mint_address, token.wallet_public_key);

    if (claimable < MIN_CLAIM_AMOUNT) {
      console.log(`[FourMemeCycle] ${token.symbol}: No significant tax fees (${claimable.toFixed(8)} claimable)`);
      return;
    }

    console.log(`[FourMemeCycle] ${token.symbol}: ${claimable.toFixed(8)} quote tokens claimable`);

    const privateKey = decrypt(token.wallet_private_key_encrypted);

    const balanceBefore = await bnbWallet.getBalance(token.wallet_public_key);

    const claimResult = await fourmemeSDK.claimTaxFees(token.mint_address, privateKey);

    if (!claimResult) {
      console.log(`[FourMemeCycle] ${token.symbol}: Claim returned null`);
      return;
    }

    console.log(`[FourMemeCycle] ${token.symbol}: Claimed ${claimResult.amount.toFixed(8)} tokens, tx: ${claimResult.txHash}`);

    await new Promise(r => setTimeout(r, 3000));

    const balanceAfter = await bnbWallet.getBalance(token.wallet_public_key);
    const netReceived = Math.max(0, balanceAfter - balanceBefore);

    if (netReceived < 0.0001) {
      console.log(`[FourMemeCycle] ${token.symbol}: Net BNB received too small (${netReceived.toFixed(8)}), skipping distribution`);
      return;
    }

    console.log(`[FourMemeCycle] ${token.symbol}: Net BNB received: ${netReceived.toFixed(8)} BNB`);

    const cycleId = crypto.randomUUID();
    const distRecord = {
      tokenId: token.id,
      cycleId,
      totalClaimed: netReceived,
      creatorAmount: netReceived * CREATOR_SHARE,
      buybackAmount: netReceived * BUYBACK_SHARE,
      treasuryAmount: netReceived * TREASURY_SHARE,
      gasReserveAmount: netReceived * GAS_RESERVE_SHARE,
      chain: 'bnb',
      status: 'pending',
      claimTxHash: claimResult.txHash
    };

    console.log(`[FourMemeCycle] Fee split for ${token.symbol}: creator=${distRecord.creatorAmount.toFixed(8)}, buyback=${distRecord.buybackAmount.toFixed(8)}, treasury=${distRecord.treasuryAmount.toFixed(8)}, gas=${distRecord.gasReserveAmount.toFixed(8)} BNB`);

    if (token.creator_wallet && distRecord.creatorAmount >= 0.0005) {
      try {
        const result = await bnbWallet.transferBNB(privateKey, token.creator_wallet, distRecord.creatorAmount);
        distRecord.creatorTxHash = result.txHash;
        console.log(`[FourMemeCycle] Creator share sent: ${distRecord.creatorAmount.toFixed(8)} BNB → ${token.creator_wallet}, tx: ${result.txHash}`);
        await new Promise(r => setTimeout(r, 2000));
      } catch (err) {
        console.error(`[FourMemeCycle] Creator transfer failed for ${token.symbol}:`, err.message);
      }
    } else if (!token.creator_wallet) {
      console.log(`[FourMemeCycle] No creator wallet set for ${token.symbol}, creator share stays in session wallet`);
    }

    if (TREASURY_WALLET && distRecord.treasuryAmount >= 0.0005) {
      try {
        const result = await bnbWallet.transferBNB(privateKey, TREASURY_WALLET, distRecord.treasuryAmount);
        distRecord.treasuryTxHash = result.txHash;
        console.log(`[FourMemeCycle] Treasury share sent: ${distRecord.treasuryAmount.toFixed(8)} BNB → treasury, tx: ${result.txHash}`);
        await new Promise(r => setTimeout(r, 2000));
      } catch (err) {
        console.error(`[FourMemeCycle] Treasury transfer failed for ${token.symbol}:`, err.message);
      }
    }

    if (distRecord.buybackAmount >= 0.001) {
      console.log(`[FourMemeCycle] Buyback: ${distRecord.buybackAmount.toFixed(8)} BNB reserved for ${token.symbol} (PancakeSwap buyback & burn pending implementation)`);
    } else {
      console.log(`[FourMemeCycle] Buyback amount too small (${distRecord.buybackAmount.toFixed(8)} BNB), skipping`);
    }

    distRecord.status = 'completed';
    await db.createFeeDistribution(distRecord);
    await db.updateTokenFees(token.id, netReceived);
    console.log(`[FourMemeCycle] Distribution recorded for ${token.symbol}`);

  } catch (err) {
    console.error(`[FourMemeCycle] Error processing ${token.symbol}:`, err.message);
  }
}

async function runFourMemeClaimCycle() {
  console.log('[FourMemeCycle] ========== Starting Four.meme tax claim & distribute cycle ==========');

  try {
    const tokens = await db.query(
      `SELECT * FROM tokens WHERE venue = 'four.meme' AND status IN ('active', 'graduated')`
    );

    if (!tokens.rows || tokens.rows.length === 0) {
      console.log('[FourMemeCycle] No active/graduated Four.meme tokens found');
    } else {
      console.log(`[FourMemeCycle] Processing ${tokens.rows.length} Four.meme token(s)`);

      for (const token of tokens.rows) {
        console.log(`[FourMemeCycle] --- Processing ${token.symbol} (${token.mint_address}) ---`);
        await claimAndDistributeForToken(token);
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    console.log('[FourMemeCycle] ========== Cycle complete ==========');
  } catch (err) {
    console.error('[FourMemeCycle] Error in cycle:', err.message);
  }

  const nextInterval = getRandomInterval(2, 10);
  console.log(`[FourMemeCycle] Next cycle in ${Math.round(nextInterval / 60000)} minutes`);
  setTimeout(runFourMemeClaimCycle, nextInterval);
}

export function startFourMemeFeeClaimer() {
  console.log('[FourMemeCycle] Initializing Four.meme tax fee distribution system (30/50/15/5 split)...');
  if (!TREASURY_WALLET) {
    console.warn('[FourMemeCycle] WARNING: CLAWP_TREASURY_BNB not set, treasury share will stay in session wallet');
  }

  const initialDelay = getRandomInterval(1, 3);
  console.log(`[FourMemeCycle] First cycle in ${Math.round(initialDelay / 60000)} minutes`);

  setTimeout(runFourMemeClaimCycle, initialDelay);
}

export default { startFourMemeFeeClaimer };
