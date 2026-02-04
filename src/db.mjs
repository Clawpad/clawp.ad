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
      wallet_public_key, wallet_private_key_encrypted, status, website_url, twitter_url
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
      data.status || 'active',
      data.websiteUrl || null,
      data.twitterUrl || null
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

export async function getTokenBySlug(slug) {
  if (!slug) return null;
  const result = await query(
    `SELECT * FROM tokens WHERE slug = $1`,
    [slug.toLowerCase()]
  );
  return result.rows[0];
}

export async function updateTokenLandingData(id, narrative, themePrimary, themeAccent, slug) {
  const safeSlug = slug ? slug.toLowerCase() : null;
  const result = await query(
    `UPDATE tokens SET narrative = $1, theme_primary = $2, theme_accent = $3, slug = $4 WHERE id = $5 RETURNING *`,
    [narrative, themePrimary, themeAccent, safeSlug, id]
  );
  return result.rows[0];
}

export async function generateUniqueSlug(baseSlug) {
  const cleanSlug = baseSlug.toLowerCase().replace(/[^a-z0-9]/g, '');
  let slug = cleanSlug;
  let counter = 2;
  
  while (true) {
    const existing = await query(
      `SELECT id FROM tokens WHERE slug = $1`,
      [slug]
    );
    if (existing.rows.length === 0) {
      return slug;
    }
    slug = `${cleanSlug}-${counter}`;
    counter++;
  }
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

export async function markVanityAddressBurned(id) {
  const result = await query(
    `UPDATE vanity_addresses 
     SET status = 'burned', used_at = NOW(), updated_at = NOW()
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
      COUNT(*) FILTER (WHERE status = 'burned') as burned,
      COUNT(*) as total
     FROM vanity_addresses`
  );
  const row = result.rows[0];
  return {
    available: parseInt(row.available) || 0,
    reserved: parseInt(row.reserved) || 0,
    used: parseInt(row.used) || 0,
    burned: parseInt(row.burned) || 0,
    total: parseInt(row.total) || 0
  };
}

export async function getAvailableVanityCount() {
  const result = await query(
    `SELECT COUNT(*) as count FROM vanity_addresses WHERE status = 'available'`
  );
  return parseInt(result.rows[0].count) || 0;
}

// Agent Skills functions
export async function createAgentSkill(tokenId, data) {
  const result = await query(
    `INSERT INTO agent_skills (token_id, archetype, voice, topics, quirks, sample_posts, intro_post)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      tokenId,
      data.archetype,
      data.voice,
      JSON.stringify(data.topics || []),
      JSON.stringify(data.quirks || []),
      JSON.stringify(data.samplePosts || []),
      data.introPost || null
    ]
  );
  return result.rows[0];
}

export async function getAgentSkillByTokenId(tokenId) {
  const result = await query(
    `SELECT * FROM agent_skills WHERE token_id = $1`,
    [tokenId]
  );
  return result.rows[0];
}

export async function getAgentSkill(id) {
  const result = await query(
    `SELECT * FROM agent_skills WHERE id = $1`,
    [id]
  );
  return result.rows[0];
}

export async function updateAgentSkillClaim(id, apiKeyEncrypted, username, agentId) {
  const result = await query(
    `UPDATE agent_skills 
     SET moltbook_api_key_encrypted = $1, moltbook_username = $2, moltbook_agent_id = $3, 
         status = 'claimed', claimed_at = NOW(), updated_at = NOW()
     WHERE id = $4 RETURNING *`,
    [apiKeyEncrypted, username, agentId, id]
  );
  return result.rows[0];
}

export async function updateAgentSkillStatus(id, status) {
  const result = await query(
    `UPDATE agent_skills SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [status, id]
  );
  return result.rows[0];
}

export async function updateAgentSkillKarma(id, karma, postsCount, commentsCount) {
  const result = await query(
    `UPDATE agent_skills 
     SET karma = $1, posts_count = $2, comments_count = $3, updated_at = NOW() 
     WHERE id = $4 RETURNING *`,
    [karma, postsCount, commentsCount, id]
  );
  return result.rows[0];
}

export async function getUnclaimedAgentSkills(limit = 50) {
  const result = await query(
    `SELECT s.*, t.name as token_name, t.symbol, t.image_url, t.slug
     FROM agent_skills s
     JOIN tokens t ON s.token_id = t.id
     WHERE s.status = 'unclaimed'
     ORDER BY s.created_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
}

export async function getClaimedAgentSkills(limit = 50) {
  const result = await query(
    `SELECT s.*, t.name as token_name, t.symbol, t.image_url, t.slug
     FROM agent_skills s
     JOIN tokens t ON s.token_id = t.id
     WHERE s.status IN ('claimed', 'active')
     ORDER BY s.karma DESC, s.created_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
}

// Agent Posts functions
export async function createAgentPost(agentSkillId, content) {
  const result = await query(
    `INSERT INTO agent_posts (agent_skill_id, content, status)
     VALUES ($1, $2, 'suggested')
     RETURNING *`,
    [agentSkillId, content]
  );
  return result.rows[0];
}

export async function getAgentPosts(agentSkillId, limit = 20) {
  const result = await query(
    `SELECT * FROM agent_posts 
     WHERE agent_skill_id = $1 
     ORDER BY created_at DESC LIMIT $2`,
    [agentSkillId, limit]
  );
  return result.rows;
}

export async function getSuggestedPosts(agentSkillId, limit = 5) {
  const result = await query(
    `SELECT * FROM agent_posts 
     WHERE agent_skill_id = $1 AND status = 'suggested'
     ORDER BY created_at DESC LIMIT $2`,
    [agentSkillId, limit]
  );
  return result.rows;
}

export async function updateAgentPostStatus(id, status, moltbookPostId = null, moltbookPostUrl = null) {
  const result = await query(
    `UPDATE agent_posts 
     SET status = $1, moltbook_post_id = COALESCE($2, moltbook_post_id), 
         moltbook_post_url = COALESCE($3, moltbook_post_url),
         posted_at = CASE WHEN $1 = 'posted' THEN NOW() ELSE posted_at END
     WHERE id = $4 RETURNING *`,
    [status, moltbookPostId, moltbookPostUrl, id]
  );
  return result.rows[0];
}

export async function markAgentLastPost(agentSkillId) {
  const result = await query(
    `UPDATE agent_skills 
     SET last_post_at = NOW(), posts_count = posts_count + 1, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [agentSkillId]
  );
  return result.rows[0];
}

export async function getAgentPostStats() {
  const result = await query(
    `SELECT 
      COUNT(*) FILTER (WHERE status = 'suggested') as suggested,
      COUNT(*) FILTER (WHERE status = 'posted') as posted,
      COUNT(*) FILTER (WHERE status = 'rejected') as rejected,
      COUNT(*) as total
     FROM agent_posts`
  );
  return result.rows[0];
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
  getTokenBySlug,
  updateTokenLandingData,
  generateUniqueSlug,
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
  markVanityAddressBurned,
  getVanityPoolStats,
  getAvailableVanityCount,
  createAgentSkill,
  getAgentSkillByTokenId,
  getAgentSkill,
  updateAgentSkillClaim,
  updateAgentSkillStatus,
  updateAgentSkillKarma,
  getUnclaimedAgentSkills,
  getClaimedAgentSkills,
  createAgentPost,
  getAgentPosts,
  getSuggestedPosts,
  updateAgentPostStatus,
  markAgentLastPost,
  getAgentPostStats
};
