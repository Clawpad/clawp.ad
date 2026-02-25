import * as db from '../db.mjs';
import { getTokenPrice } from './dexscreener.mjs';
import { sellToken, logTransaction } from './trader.mjs';

const TP_MIN_PCT = 10;
const TP_MAX_PCT = 30;
const SL_MIN_PCT = 15;
const SL_MAX_PCT = 20;
const CHECK_INTERVAL_MS = 2 * 60 * 1000;

let agentSecretKey = null;
let monitoring = false;
let tweetFn = null;

function randomTP() {
  return Math.floor(Math.random() * (TP_MAX_PCT - TP_MIN_PCT + 1)) + TP_MIN_PCT;
}

function randomSL() {
  return -(Math.floor(Math.random() * (SL_MAX_PCT - SL_MIN_PCT + 1)) + SL_MIN_PCT);
}

export function setTweetFunction(fn) {
  tweetFn = fn;
}

export function setAgentKey(secretKey) {
  agentSecretKey = secretKey;
}

export async function addPosition(tokenMint, tokenSymbol, solSpent, entryPriceUsd) {
  const tp = randomTP();
  const sl = randomSL();
  await db.query(
    `INSERT INTO agent_positions (token_mint, token_symbol, sol_spent, entry_price_usd, take_profit_pct, stop_loss_pct, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', NOW())`,
    [tokenMint, tokenSymbol, solSpent, entryPriceUsd, tp, sl]
  );
  console.log(`[SolAgent] Position opened: ${tokenSymbol} at $${entryPriceUsd} (${solSpent} SOL, TP: +${tp}%, SL: ${sl}%)`);
  return { tp, sl };
}

export async function getOpenPositions() {
  const result = await db.query(
    `SELECT * FROM agent_positions WHERE status = 'open' ORDER BY created_at ASC`
  );
  return result.rows;
}

export async function checkAndSellPositions() {
  if (!agentSecretKey) {
    console.warn('[SolAgent] No agent key set, skipping position check');
    return;
  }

  const positions = await getOpenPositions();
  if (positions.length === 0) return;

  for (const pos of positions) {
    try {
      const priceData = await getTokenPrice(pos.token_mint);
      if (!priceData || !priceData.priceUsd) continue;

      const currentPrice = priceData.priceUsd;
      const entryPrice = parseFloat(pos.entry_price_usd);
      const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
      const posTP = parseFloat(pos.take_profit_pct) || 20;
      const posSL = parseFloat(pos.stop_loss_pct) || -15;

      let shouldSell = false;
      let reason = '';

      if (pnlPct >= posTP) {
        shouldSell = true;
        reason = `take_profit (+${pnlPct.toFixed(1)}%, target was +${posTP}%)`;
      } else if (pnlPct <= posSL) {
        shouldSell = true;
        reason = `stop_loss (${pnlPct.toFixed(1)}%, limit was ${posSL}%)`;
      }

      if (shouldSell) {
        console.log(`[SolAgent] Auto-selling ${pos.token_symbol}: ${reason}`);

        try {
          const result = await sellToken(agentSecretKey, pos.token_mint, 100);

          await db.query(
            `UPDATE agent_positions SET status = 'closed', exit_price_usd = $1, pnl_pct = $2, close_reason = $3, closed_at = NOW() WHERE id = $4`,
            [currentPrice, pnlPct, reason, pos.id]
          );

          await logTransaction('sell', pos.token_mint, pos.token_symbol, result.solReceived, result.signature, 'success', `auto_${reason}`);

          console.log(`[SolAgent] Sold ${pos.token_symbol}: ${reason}, received ${result.solReceived.toFixed(4)} SOL, TX: ${result.signature}`);

          if (tweetFn) {
            const pnlSign = pnlPct >= 0 ? '+' : '';
            const emoji = pnlPct >= 0 ? '🦞' : '💀';
            const vibe = pnlPct >= 0 ? 'claws eating good' : 'live to claw another day';
            const tweetText = `sold $${pos.token_symbol} ${pnlSign}${pnlPct.toFixed(1)}%, ${vibe}. ${emoji}\n\nhttps://solscan.io/tx/${result.signature}`;
            tweetFn(tweetText).catch(e => console.warn('[SolAgent] Sell tweet failed:', e.message));
          }
        } catch (sellErr) {
          console.error(`[SolAgent] Auto-sell failed for ${pos.token_symbol}:`, sellErr.message);
          await logTransaction('sell', pos.token_mint, pos.token_symbol, 0, null, 'failed', `auto_${reason}: ${sellErr.message}`);
        }
      } else {
        console.log(`[SolAgent] ${pos.token_symbol}: PNL ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% (entry $${entryPrice.toFixed(6)}, now $${currentPrice.toFixed(6)}, TP: +${posTP}%)`);
      }
    } catch (err) {
      console.error(`[SolAgent] Position check error for ${pos.token_symbol}:`, err.message);
    }
  }
}

export function startPositionMonitor() {
  if (monitoring) return;
  monitoring = true;
  console.log(`[SolAgent] Position monitor started (check every ${CHECK_INTERVAL_MS / 1000}s, TP: +${TP_MIN_PCT}-${TP_MAX_PCT}% random, SL: -${SL_MIN_PCT} to -${SL_MAX_PCT}% random)`);

  setInterval(async () => {
    try {
      await checkAndSellPositions();
    } catch (err) {
      console.error('[SolAgent] Position monitor error:', err.message);
    }
  }, CHECK_INTERVAL_MS);
}
