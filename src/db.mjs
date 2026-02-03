import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function query(text, params) {
  const result = await pool.query(text, params);
  return result;
}

export async function createSession(blueprint, depositAddress, walletPrivateKeyEncrypted = null) {
  const result = await query(
    `INSERT INTO sessions (blueprint, deposit_address, wallet_private_key_encrypted, status)
     VALUES ($1, $2, $3, 'pending')
     RETURNING *`,
    [JSON.stringify(blueprint), depositAddress, walletPrivateKeyEncrypted]
  );
  return result.rows[0];
}

export async function getSession(id) {
  const result = await query(
    `SELECT * FROM sessions WHERE id = $1`,
    [id]
  );
  return result.rows[0];
}

export async function updateSessionStatus(id, status, tokenId = null, errorMessage = null) {
  const result = await query(
    `UPDATE sessions SET status = $1, token_id = $2, error_message = COALESCE($4, error_message) WHERE id = $3 RETURNING *`,
    [status, tokenId, id, errorMessage]
  );
  return result.rows[0];
}

export async function softDeleteSession(id) {
  const result = await query(
    `UPDATE sessions SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [id]
  );
  return result.rows[0];
}

export async function updateSessionDeposit(id, amount, fundingWallet = null) {
  const result = await query(
    `UPDATE sessions SET deposit_amount = $1, status = 'funded', funding_wallet = COALESCE($3, funding_wallet) WHERE id = $2 RETURNING *`,
    [amount, id, fundingWallet]
  );
  return result.rows[0];
}

export async function createToken(data) {
  const result = await query(
    `INSERT INTO tokens (
      mint_address, name, symbol, description, image_url, metadata_uri,
      wallet_public_key, wallet_private_key_encrypted, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *`,
    [
      data.mintAddress,
      data.name,
      data.symbol,
      data.description,
      data.imageUrl,
      data.metadataUri,
      data.walletPublicKey,
      data.walletPrivateKeyEncrypted,
      data.status || 'active'
    ]
  );
  return result.rows[0];
}

export async function getToken(id) {
  const result = await query(
    `SELECT * FROM tokens WHERE id = $1`,
    [id]
  );
  return result.rows[0];
}

export async function getTokenByMint(mintAddress) {
  const result = await query(
    `SELECT * FROM tokens WHERE mint_address = $1`,
    [mintAddress]
  );
  return result.rows[0];
}

export async function getActiveTokens(limit = 50) {
  const result = await query(
    `SELECT * FROM tokens WHERE status = 'active' ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
}

export async function getGraduatedTokens(limit = 50) {
  const result = await query(
    `SELECT * FROM tokens WHERE status = 'graduated' ORDER BY graduated_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
}

export async function getAllTokens() {
  const result = await query(`SELECT * FROM tokens ORDER BY created_at DESC`);
  return result.rows;
}

export async function getRecentTokens(limit = 5) {
  const result = await query(
    `SELECT * FROM tokens WHERE status IN ('active', 'graduated') ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
}

export async function updateTokenStatus(id, status, pumpswapPool = null) {
  let sql;
  let params;
  
  if (status === 'graduated') {
    sql = `UPDATE tokens SET status = $1, pumpswap_pool = $2, graduated_at = NOW() WHERE id = $3 RETURNING *`;
    params = [status, pumpswapPool, id];
  } else {
    sql = `UPDATE tokens SET status = $1, pumpswap_pool = $2 WHERE id = $3 RETURNING *`;
    params = [status, pumpswapPool, id];
  }
  
  const result = await query(sql, params);
  return result.rows[0];
}

export async function updateTokenMarketData(id, marketCap, bondingProgress) {
  const result = await query(
    `UPDATE tokens SET market_cap = $1, bonding_progress = $2 WHERE id = $3 RETURNING *`,
    [marketCap, bondingProgress, id]
  );
  return result.rows[0];
}

export async function updateTokenFees(id, feesCollected) {
  const result = await query(
    `UPDATE tokens SET total_fees_collected = total_fees_collected + $1 WHERE id = $2 RETURNING *`,
    [feesCollected, id]
  );
  return result.rows[0];
}

export async function createBurn(tokenId, solSpent, tokensBurned, txSignature) {
  const result = await query(
    `INSERT INTO burns (token_id, sol_spent, tokens_burned, tx_signature)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [tokenId, solSpent, tokensBurned, txSignature]
  );
  await query(
    `UPDATE tokens SET total_burned = total_burned + $1 WHERE id = $2`,
    [tokensBurned, tokenId]
  );
  return result.rows[0];
}

export async function getBurnsByToken(tokenId) {
  const result = await query(
    `SELECT * FROM burns WHERE token_id = $1 ORDER BY created_at DESC`,
    [tokenId]
  );
  return result.rows;
}

export async function getRecentBurns(limit = 10) {
  const result = await query(
    `SELECT b.*, t.name, t.symbol FROM burns b
     JOIN tokens t ON b.token_id = t.id
     ORDER BY b.created_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
}

export async function getBurnStats() {
  const result = await query(
    `SELECT 
      COALESCE(SUM(sol_spent), 0) as total_sol_spent,
      COALESCE(SUM(tokens_burned), 0) as total_tokens_burned,
      COUNT(*) as total_burns
     FROM burns`
  );
  return result.rows[0];
}

export async function getPendingSessions() {
  const result = await query(
    `SELECT * FROM sessions WHERE status = 'pending' AND expires_at > NOW()`
  );
  return result.rows;
}

export async function getTokensForBuyback(limit = 100) {
  const result = await query(
    `SELECT * FROM tokens WHERE status IN ('active', 'graduated') LIMIT $1`,
    [limit]
  );
  return result.rows;
}

export async function addVanityAddress(publicKey, secretKeyEncrypted, attempts = null, elapsedSeconds = null) {
  const result = await query(
    `INSERT INTO vanity_addresses (public_key, secret_key_encrypted, attempts, elapsed_seconds)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [publicKey, secretKeyEncrypted, attempts, elapsedSeconds]
  );
  return result.rows[0];
}

export async function reserveVanityAddress(sessionId = null) {
  const result = await query(
    `UPDATE vanity_addresses 
     SET status = 'reserved', reserved_at = NOW(), session_id = $1, updated_at = NOW()
     WHERE id = (
       SELECT id FROM vanity_addresses 
       WHERE status = 'available' 
       ORDER BY created_at 
       LIMIT 1 
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [sessionId]
  );
  return result.rows[0] || null;
}

export async function markVanityAddressUsed(id, tokenId) {
  const result = await query(
    `UPDATE vanity_addresses 
     SET status = 'used', used_at = NOW(), token_id = $2, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, tokenId]
  );
  return result.rows[0];
}

export async function releaseVanityAddress(id) {
  const result = await query(
    `UPDATE vanity_addresses 
     SET status = 'available', reserved_at = NULL, session_id = NULL, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id]
  );
  return result.rows[0];
}

export async function getVanityPoolStats() {
  const result = await query(
    `SELECT 
      COUNT(*) FILTER (WHERE status = 'available') as available,
      COUNT(*) FILTER (WHERE status = 'reserved') as reserved,
      COUNT(*) FILTER (WHERE status = 'used') as used,
      COUNT(*) as total
     FROM vanity_addresses`
  );
  const row = result.rows[0];
  return {
    available: parseInt(row.available) || 0,
    reserved: parseInt(row.reserved) || 0,
    used: parseInt(row.used) || 0,
    total: parseInt(row.total) || 0
  };
}

export async function getAvailableVanityCount() {
  const result = await query(
    `SELECT COUNT(*) as count FROM vanity_addresses WHERE status = 'available'`
  );
  return parseInt(result.rows[0].count) || 0;
}

export default {
  query,
  createSession,
  getSession,
  updateSessionStatus,
  softDeleteSession,
  updateSessionDeposit,
  createToken,
  getToken,
  getTokenByMint,
  getActiveTokens,
  getGraduatedTokens,
  getAllTokens,
  getRecentTokens,
  updateTokenStatus,
  updateTokenMarketData,
  updateTokenFees,
  createBurn,
  getBurnsByToken,
  getRecentBurns,
  getBurnStats,
  getPendingSessions,
  getTokensForBuyback,
  addVanityAddress,
  reserveVanityAddress,
  markVanityAddressUsed,
  releaseVanityAddress,
  getVanityPoolStats,
  getAvailableVanityCount
};
