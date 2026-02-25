import * as db from '../db.mjs';
import { getOrCreateAgentWallet } from './wallet.mjs';
import { setAgentKey as setMonitorKey, setTweetFunction as setMonitorTweetFn, startPositionMonitor } from './position-monitor.mjs';
import { setAgentKey as setTraderKey, setTweetFunction as setTraderTweetFn, startAutoTrader } from './auto-trader.mjs';
import { setAgentKeys, isAuthorized, parseCommand, executeCommand } from './command-handler.mjs';

let initialized = false;
let agentPublicKey = null;

async function ensureTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS agent_wallets (
      id SERIAL PRIMARY KEY,
      name VARCHAR(50) NOT NULL,
      public_key VARCHAR(100) NOT NULL,
      encrypted_private_key TEXT NOT NULL,
      chain VARCHAR(20) NOT NULL DEFAULT 'solana',
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(name, chain)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS agent_positions (
      id SERIAL PRIMARY KEY,
      token_mint VARCHAR(100) NOT NULL,
      token_symbol VARCHAR(20) NOT NULL,
      sol_spent NUMERIC(20, 8) NOT NULL,
      entry_price_usd NUMERIC(30, 12) NOT NULL,
      exit_price_usd NUMERIC(30, 12),
      pnl_pct NUMERIC(10, 2),
      take_profit_pct NUMERIC(5, 2) DEFAULT 20,
      status VARCHAR(20) NOT NULL DEFAULT 'open',
      close_reason VARCHAR(100),
      created_at TIMESTAMP DEFAULT NOW(),
      closed_at TIMESTAMP
    )
  `);

  await db.query(`ALTER TABLE agent_positions ADD COLUMN IF NOT EXISTS take_profit_pct NUMERIC(5, 2) DEFAULT 20`);
  await db.query(`ALTER TABLE agent_positions ADD COLUMN IF NOT EXISTS stop_loss_pct NUMERIC(5, 2) DEFAULT -15`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS agent_transactions (
      id SERIAL PRIMARY KEY,
      action VARCHAR(20) NOT NULL,
      token_mint VARCHAR(100),
      token_symbol VARCHAR(20),
      amount_sol NUMERIC(20, 8),
      tx_signature VARCHAR(120),
      status VARCHAR(20) NOT NULL,
      triggered_by TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  console.log('[SolAgent] Database tables ready');
}

export async function initSolanaAgent() {
  console.log('[SolAgent] initSolanaAgent() called, initialized=' + initialized);
  if (initialized) return;

  const isDev = process.env.REPLIT_DEV_DOMAIN && !process.env.REPLIT_DEPLOYMENT;
  if (isDev) {
    console.log('[SolAgent] Skipping Solana agent in development.');
    return;
  }

  try {
    console.log('[SolAgent] Creating database tables...');
    await ensureTables();

    console.log('[SolAgent] Getting or creating agent wallet...');
    const wallet = await getOrCreateAgentWallet();
    agentPublicKey = wallet.publicKey;
    console.log(`[SolAgent] Wallet ready: ${wallet.publicKey}`);

    setMonitorKey(wallet.secretKey);
    setTraderKey(wallet.secretKey);
    setAgentKeys(wallet.publicKey, wallet.secretKey);

    startPositionMonitor();
    startAutoTrader();

    initialized = true;
    console.log(`[SolAgent] Solana trading agent initialized. Wallet: ${wallet.publicKey}`);
  } catch (err) {
    console.error('[SolAgent] Initialization error:', err.message, err.stack);
  }
}

export function getAgentPublicKey() {
  return agentPublicKey;
}

export function setTweetFunction(fn) {
  setMonitorTweetFn(fn);
  setTraderTweetFn(fn);
}

export { isAuthorized, parseCommand, executeCommand };
