import * as db from '../db.mjs';
import { getTopSolanaTokens, getTokenPrice } from './dexscreener.mjs';
import { buyToken, logTransaction } from './trader.mjs';
import { addPosition, getOpenPositions } from './position-monitor.mjs';

const BUY_AMOUNT_SOL = 0.05;
const MAX_OPEN_POSITIONS = 5;
const AUTO_TRADE_MIN_MINUTES = 60;
const AUTO_TRADE_MAX_MINUTES = 180;

let agentSecretKey = null;
let running = false;
let tweetFn = null;

export function setTweetFunction(fn) {
  tweetFn = fn;
}

export function setAgentKey(secretKey) {
  agentSecretKey = secretKey;
}

async function getDailySpend() {
  const result = await db.query(
    `SELECT COALESCE(SUM(amount_sol), 0) as total FROM agent_transactions 
     WHERE action = 'buy' AND status = 'success' AND created_at > NOW() - INTERVAL '24 hours'`
  );
  return parseFloat(result.rows[0].total);
}

export async function runAutoTradeCycle() {
  if (!agentSecretKey) {
    console.warn('[SolAgent] No agent key, skipping auto-trade');
    return;
  }

  try {
    const openPositions = await getOpenPositions();
    if (openPositions.length >= MAX_OPEN_POSITIONS) {
      console.log(`[SolAgent] Max open positions (${MAX_OPEN_POSITIONS}) reached. Skipping buy.`);
      return;
    }

    const dailySpend = await getDailySpend();
    const dailyLimit = 1.0;
    if (dailySpend >= dailyLimit) {
      console.log(`[SolAgent] Daily limit reached (${dailySpend.toFixed(3)}/${dailyLimit} SOL). Skipping.`);
      return;
    }

    const topTokens = await getTopSolanaTokens(10);
    if (topTokens.length === 0) {
      console.log('[SolAgent] No tokens found from DexScreener. Skipping.');
      return;
    }

    const existingMints = new Set(openPositions.map(p => p.token_mint));
    const candidates = topTokens.filter(t => !existingMints.has(t.tokenAddress));

    if (candidates.length === 0) {
      console.log('[SolAgent] All top tokens already in portfolio. Skipping.');
      return;
    }

    const chosen = candidates[Math.floor(Math.random() * candidates.length)];

    console.log(`[SolAgent] Auto-buying: ${chosen.symbol} (${chosen.name}) at $${chosen.priceUsd}`);
    console.log(`[SolAgent] Liquidity: $${chosen.liquidity.toLocaleString()}, 24h Vol: $${chosen.volume24h.toLocaleString()}`);

    const result = await buyToken(agentSecretKey, chosen.tokenAddress, BUY_AMOUNT_SOL);

    const { tp, sl } = await addPosition(chosen.tokenAddress, chosen.symbol, BUY_AMOUNT_SOL, chosen.priceUsd);
    await logTransaction('buy', chosen.tokenAddress, chosen.symbol, BUY_AMOUNT_SOL, result.signature, 'success', 'auto_random');

    console.log(`[SolAgent] Bought ${chosen.symbol} for ${BUY_AMOUNT_SOL} SOL (TP: +${tp}%, SL: ${sl}%). TX: ${result.signature}`);

    if (tweetFn) {
      const tweetText = `aped into $${chosen.symbol} at $${chosen.priceUsd}, tp +${tp}%. 🦞\n\nhttps://solscan.io/tx/${result.signature}`;
      tweetFn(tweetText).catch(e => console.warn('[SolAgent] Buy tweet failed:', e.message));
    }

  } catch (err) {
    console.error('[SolAgent] Auto-trade cycle error:', err.message);
  }
}

function scheduleNextTrade() {
  const minMs = AUTO_TRADE_MIN_MINUTES * 60 * 1000;
  const maxMs = AUTO_TRADE_MAX_MINUTES * 60 * 1000;
  const interval = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  const nextMin = (interval / 60000).toFixed(0);
  console.log(`[SolAgent] Next auto-trade in ${nextMin} minutes`);

  setTimeout(async () => {
    await runAutoTradeCycle();
    scheduleNextTrade();
  }, interval);
}

export function startAutoTrader() {
  if (running) return;
  running = true;
  console.log(`[SolAgent] Auto-trader started (interval: ${AUTO_TRADE_MIN_MINUTES}-${AUTO_TRADE_MAX_MINUTES} min, ${BUY_AMOUNT_SOL} SOL per trade, max ${MAX_OPEN_POSITIONS} positions)`);
  scheduleNextTrade();
}
