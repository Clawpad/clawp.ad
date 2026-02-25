import * as solana from '../solana.mjs';
import { getTokenPrice } from './dexscreener.mjs';
import { buyToken, sellToken, logTransaction } from './trader.mjs';
import { addPosition, getOpenPositions } from './position-monitor.mjs';

const AUTHORIZED_USERNAME = 'clawpad';
const MAX_BUY_SOL = 1.0;

let agentSecretKey = null;
let agentPublicKey = null;

export function setAgentKeys(publicKey, secretKey) {
  agentPublicKey = publicKey;
  agentSecretKey = secretKey;
}

export function isAuthorized(username) {
  return username && username.toLowerCase() === AUTHORIZED_USERNAME;
}

export function parseCommand(text) {
  const clean = text.replace(/@\w+/g, '').trim().toLowerCase();

  const buyMatch = clean.match(/buy\s+([\d.]+)\s*sol\s+(?:of\s+)?([A-Za-z0-9]+)/i)
    || clean.match(/buy\s+([A-Za-z0-9]+)\s+([\d.]+)\s*sol/i);

  if (buyMatch) {
    let amount, tokenMint;
    if (buyMatch[1].match(/^[\d.]+$/)) {
      amount = parseFloat(buyMatch[1]);
      tokenMint = buyMatch[2];
    } else {
      tokenMint = buyMatch[1];
      amount = parseFloat(buyMatch[2]);
    }
    return { action: 'buy', amount, tokenMint };
  }

  const sellMatch = clean.match(/sell\s+(?:all\s+)?([A-Za-z0-9]+)(?:\s+(\d+)%)?/i);
  if (sellMatch) {
    const tokenMint = sellMatch[1];
    const percentage = sellMatch[2] ? parseInt(sellMatch[2]) : 100;
    return { action: 'sell', tokenMint, percentage };
  }

  if (clean.includes('balance') || clean.includes('wallet')) {
    return { action: 'balance' };
  }

  if (clean.includes('positions') || clean.includes('portfolio') || clean.includes('holdings')) {
    return { action: 'positions' };
  }

  return null;
}

export async function executeCommand(command) {
  if (!agentSecretKey || !agentPublicKey) {
    return 'Agent wallet not initialized yet.';
  }

  switch (command.action) {
    case 'buy':
      return await executeBuy(command);
    case 'sell':
      return await executeSell(command);
    case 'balance':
      return await executeBalance();
    case 'positions':
      return await executePositions();
    default:
      return 'Unknown command.';
  }
}

async function executeBuy(command) {
  if (!command.amount || command.amount <= 0) {
    return 'Invalid amount.';
  }
  if (command.amount > MAX_BUY_SOL) {
    return `Max buy is ${MAX_BUY_SOL} SOL per trade.`;
  }
  if (!command.tokenMint || command.tokenMint.length < 20) {
    return 'Invalid token address.';
  }

  try {
    const priceData = await getTokenPrice(command.tokenMint);
    if (!priceData) {
      return 'Token not found on DexScreener.';
    }

    const result = await buyToken(agentSecretKey, command.tokenMint, command.amount);
    await addPosition(command.tokenMint, priceData.symbol, command.amount, priceData.priceUsd);
    await logTransaction('buy', command.tokenMint, priceData.symbol, command.amount, result.signature, 'success', 'twitter_command');

    return `Bought ${command.amount} SOL of $${priceData.symbol} at $${priceData.priceUsd.toFixed(6)}. TX: https://solscan.io/tx/${result.signature}`;
  } catch (err) {
    await logTransaction('buy', command.tokenMint, '???', command.amount, null, 'failed', `twitter_command: ${err.message}`);
    return `Buy failed: ${err.message.substring(0, 100)}`;
  }
}

async function executeSell(command) {
  if (!command.tokenMint || command.tokenMint.length < 20) {
    const positions = await getOpenPositions();
    const match = positions.find(p => p.token_symbol.toLowerCase() === command.tokenMint.toLowerCase());
    if (match) {
      command.tokenMint = match.token_mint;
    } else {
      return 'Token not found in positions. Use full mint address or symbol.';
    }
  }

  try {
    const priceData = await getTokenPrice(command.tokenMint);
    const result = await sellToken(agentSecretKey, command.tokenMint, command.percentage);

    const { rows } = await (await import('../db.mjs')).query(
      `UPDATE agent_positions SET status = 'closed', exit_price_usd = $1, close_reason = 'manual_sell', closed_at = NOW() 
       WHERE token_mint = $2 AND status = 'open' RETURNING *`,
      [priceData?.priceUsd || 0, command.tokenMint]
    );

    await logTransaction('sell', command.tokenMint, priceData?.symbol || '???', result.solReceived, result.signature, 'success', 'twitter_command');

    return `Sold ${command.percentage}% of $${priceData?.symbol || '???'}. Got ${result.solReceived.toFixed(4)} SOL back. TX: https://solscan.io/tx/${result.signature}`;
  } catch (err) {
    await logTransaction('sell', command.tokenMint, '???', 0, null, 'failed', `twitter_command: ${err.message}`);
    return `Sell failed: ${err.message.substring(0, 100)}`;
  }
}

async function executeBalance() {
  try {
    const balance = await solana.getBalance(agentPublicKey);
    return `Agent wallet: ${agentPublicKey}\nSOL balance: ${balance.toFixed(4)} SOL`;
  } catch (err) {
    return `Balance check failed: ${err.message}`;
  }
}

async function executePositions() {
  try {
    const positions = await getOpenPositions();
    if (positions.length === 0) {
      return 'No open positions.';
    }

    const lines = positions.map(p => {
      const spent = parseFloat(p.sol_spent).toFixed(3);
      return `$${p.token_symbol}: ${spent} SOL (entry $${parseFloat(p.entry_price_usd).toFixed(6)})`;
    });

    return `Open positions (${positions.length}):\n${lines.join('\n')}`;
  } catch (err) {
    return `Positions check failed: ${err.message}`;
  }
}
