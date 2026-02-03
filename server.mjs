import express from 'express';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import db from './src/db.mjs';
import { encrypt, decrypt } from './src/crypto.mjs';
import solana from './src/solana.mjs';
import pumpportal from './src/pumpportal.mjs';
import { startBuybackScheduler } from './src/buyback.mjs';
import vanityPool from './src/vanity-pool.mjs';
import fs from 'node:fs';

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

const anthropic = new Anthropic({
  apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
});

// Load CLAWP system prompt
const CLAWP_SYSTEM_PROMPT = fs.readFileSync('./skills/clawp/prompt.txt', 'utf-8');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 5000;

const app = express();
const server = createServer(app);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUUID(str) {
  if (UUID_REGEX.test(str)) return true;
  const num = parseInt(str, 10);
  return !isNaN(num) && num > 0 && String(num) === str;
}

function sanitizeText(str, maxLength = 500) {
  if (typeof str !== 'string') return '';
  return str.slice(0, maxLength).replace(/[<>]/g, '');
}

app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  if (!req.path.match(/\.(png|jpg|jpeg|gif|svg|ico|webp)$/i)) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d',
  setHeaders: (res, filePath) => {
    if (filePath.match(/\.(png|jpg|jpeg|gif|svg|ico|webp)$/i)) {
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    }
  }
}));

app.post('/api/session/create', async (req, res) => {
  try {
    const wallet = solana.generateWallet();
    const encryptedPrivKey = encrypt(wallet.secretKey);
    
    const session = await db.createSession(null, wallet.publicKey, encryptedPrivKey);
    
    res.json({
      success: true,
      sessionId: session.id,
      depositAddress: wallet.publicKey,
      requiredAmount: 0.025,
      expiresIn: 1800
    });
  } catch (error) {
    console.error('Error creating session:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/session/:id', async (req, res) => {
  try {
    if (!isValidUUID(req.params.id)) {
      return res.status(400).json({ success: false, error: 'Invalid session ID' });
    }
    const session = await db.getSession(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }
    
    let balance = 0;
    if (session.deposit_address) {
      try {
        balance = await solana.getBalance(session.deposit_address);
      } catch (e) {
        console.error('Error getting balance:', e.message);
      }
    }
    
    res.json({
      success: true,
      session: {
        id: session.id,
        status: session.status,
        depositAddress: session.deposit_address,
        depositAmount: session.deposit_amount,
        blueprint: session.blueprint,
        tokenId: session.token_id,
        createdAt: session.created_at,
        expiresAt: session.expires_at
      },
      currentBalance: balance
    });
  } catch (error) {
    console.error('Error getting session:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/session/:id/blueprint', async (req, res) => {
  try {
    if (!isValidUUID(req.params.id)) {
      return res.status(400).json({ success: false, error: 'Invalid session ID' });
    }
    const session = await db.getSession(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }
    
    const { blueprint } = req.body;
    if (!blueprint || !blueprint.name || !blueprint.symbol) {
      return res.status(400).json({ success: false, error: 'Invalid blueprint' });
    }
    
    const sanitizedBlueprint = {
      ...blueprint,
      name: sanitizeText(blueprint.name, 50),
      symbol: sanitizeText(blueprint.symbol, 10).toUpperCase(),
      description: sanitizeText(blueprint.description, 500)
    };
    
    await db.query(
      `UPDATE sessions SET blueprint = $1 WHERE id = $2`,
      [JSON.stringify(sanitizedBlueprint), session.id]
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving blueprint:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/submit-blueprint', async (req, res) => {
  try {
    const { blueprint } = req.body;
    
    if (!blueprint || !blueprint.name || !blueprint.symbol) {
      return res.status(400).json({ success: false, error: 'Blueprint with name and symbol required' });
    }
    
    console.log(`[Blueprint] Received: ${blueprint.name} ($${blueprint.symbol})`);
    
    // Return blueprint immediately, logos will be fetched separately
    const processedBlueprint = {
      ...blueprint,
      logos: [], // Empty, will be fetched via /api/generate-logos
      selectedLogo: null,
      buybackPlan: {
        mode: 'continuous',
        trigger: 'creator_fees_inflow',
        execution: 'automatic',
        percentage: 60
      }
    };
    
    res.json({
      success: true,
      blueprint: processedBlueprint,
      chatMessage: `Blueprint ready! Generating logo options...`
    });
  } catch (error) {
    console.error('[Blueprint] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/generate-logos', async (req, res) => {
  try {
    const { blueprint, styles } = req.body;
    
    if (!blueprint || !blueprint.name || !blueprint.symbol) {
      return res.status(400).json({ success: false, error: 'Blueprint with name and symbol required' });
    }
    
    const logoStyles = styles || [
      { style: 'Minimal', description: 'Clean minimalist design with simple shapes' },
      { style: 'Mascot', description: 'Cute mascot character design' },
      { style: 'Abstract', description: 'Bold abstract geometric design' }
    ];
    
    const generateLogoPrompt = (style) => {
      const basePrompt = `Create a cryptocurrency token logo for "${blueprint.name}" (${blueprint.symbol}). 
Theme: ${blueprint.description || blueprint.narrative || 'modern crypto token'}.
Style: ${style.description}.
Requirements: Square format, centered design, simple and iconic, suitable for small sizes, no text or letters, solid background color.`;
      return basePrompt;
    };
    
    const logoPromises = logoStyles.map(async (style, index) => {
      try {
        const response = await openai.images.generate({
          model: 'gpt-image-1',
          prompt: generateLogoPrompt(style),
          size: '1024x1024',
          n: 1
        });
        
        const imageData = response.data[0];
        return {
          id: index + 1,
          style: style.style,
          description: style.description,
          b64_json: imageData.b64_json,
          url: imageData.url
        };
      } catch (err) {
        console.error(`Error generating ${style.style} logo:`, err.message);
        return {
          id: index + 1,
          style: style.style,
          description: style.description,
          error: err.message
        };
      }
    });
    
    const logos = await Promise.all(logoPromises);
    const successfulLogos = logos.filter(l => !l.error);
    
    res.json({
      success: successfulLogos.length > 0,
      logos: logos,
      generated: successfulLogos.length,
      total: logoStyles.length
    });
  } catch (error) {
    console.error('Error generating logos:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/session/:id/select-logo', async (req, res) => {
  try {
    const sessionId = req.params.id;
    const { logoData } = req.body;
    
    if (!logoData) {
      return res.status(400).json({ success: false, error: 'Logo data required' });
    }
    
    const session = await db.getSession(sessionId);
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }
    
    const blueprint = session.blueprint || {};
    blueprint.selectedLogo = logoData;
    blueprint.imageUrl = logoData.startsWith('data:') ? logoData : `data:image/png;base64,${logoData}`;
    
    await db.query(
      `UPDATE sessions SET blueprint = $1 WHERE id = $2`,
      [JSON.stringify(blueprint), sessionId]
    );
    
    console.log(`[Logo] Selected logo saved for session ${sessionId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving selected logo:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/session/:id/check-deposit', async (req, res) => {
  try {
    if (!isValidUUID(req.params.id)) {
      return res.status(400).json({ success: false, error: 'Invalid session ID' });
    }
    const session = await db.getSession(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }
    
    const balance = await solana.getBalance(session.deposit_address);
    const requiredAmount = 0.025;
    
    if (balance >= requiredAmount) {
      let fundingWallet = session.funding_wallet;
      if (!fundingWallet) {
        fundingWallet = await solana.getRecentDepositSender(session.deposit_address);
        console.log(`[Deposit] Detected funding wallet: ${fundingWallet}`);
      }
      await db.updateSessionDeposit(session.id, balance, fundingWallet);
      res.json({ 
        success: true, 
        funded: true, 
        balance,
        fundingWallet,
        message: 'Deposit received!' 
      });
    } else {
      res.json({ 
        success: true, 
        funded: false, 
        balance,
        required: requiredAmount,
        remaining: requiredAmount - balance
      });
    }
  } catch (error) {
    console.error('Error checking deposit:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/session/:id/deploy', async (req, res) => {
  try {
    if (!isValidUUID(req.params.id)) {
      return res.status(400).json({ success: false, error: 'Invalid session ID' });
    }
    const session = await db.getSession(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }
    
    if (session.status === 'completed') {
      return res.status(400).json({ success: false, error: 'Token already deployed' });
    }
    
    const balance = await solana.getBalance(session.deposit_address);
    if (balance < 0.025) {
      return res.status(400).json({ 
        success: false, 
        error: 'Insufficient deposit',
        balance,
        required: 0.025
      });
    }
    
    const blueprint = session.blueprint;
    if (!blueprint || !blueprint.name || !blueprint.symbol) {
      return res.status(400).json({ success: false, error: 'No blueprint found' });
    }
    
    await db.updateSessionStatus(session.id, 'deploying');
    
    if (!session.wallet_private_key_encrypted) {
      return res.status(400).json({ success: false, error: 'Session wallet not found' });
    }
    
    const signerSecretKey = decrypt(session.wallet_private_key_encrypted);
    const signerKeypair = solana.keypairFromSecretKey(signerSecretKey);
    
    console.log('[Deploy] Reserving pre-generated CLAW mint address from pool...');
    const reservedAddress = await db.reserveVanityAddress(session.id);
    
    if (!reservedAddress) {
      console.log('[Deploy] No addresses available in pool, triggering generation...');
      vanityPool.triggerGeneration();
      return res.status(503).json({ 
        success: false, 
        error: 'No CLAW addresses available. Please try again in a few minutes.',
        retryAfter: 60
      });
    }
    
    let deploymentSucceeded = false;
    
    try {
      const mintSecretKey = decrypt(reservedAddress.secret_key_encrypted);
      const mintKeypair = solana.keypairFromHexSecretKey(mintSecretKey);
      console.log(`[Deploy] Using pre-generated mint address: ${reservedAddress.public_key}`);
      
      let metadataUri = blueprint.metadataUri;
      
      if (!metadataUri && (blueprint.logoBase64 || blueprint.imageUrl)) {
        try {
          let imageBuffer;
          
          if (blueprint.logoBase64) {
            console.log('[Deploy] Using logoBase64 from blueprint');
            imageBuffer = Buffer.from(blueprint.logoBase64, 'base64');
          } else if (blueprint.imageUrl) {
            if (blueprint.imageUrl.startsWith('data:')) {
              console.log('[Deploy] Extracting base64 from data URI');
              const base64Data = blueprint.imageUrl.split(',')[1];
              imageBuffer = Buffer.from(base64Data, 'base64');
            } else {
              console.log('[Deploy] Fetching image from URL');
              const fetch = (await import('node-fetch')).default;
              const imageResponse = await fetch(blueprint.imageUrl);
              imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
            }
          }
          
          if (imageBuffer) {
            const ipfsResult = await pumpportal.uploadToIPFS(imageBuffer, {
              name: blueprint.name,
              symbol: blueprint.symbol,
              description: blueprint.description || '',
              twitter: blueprint.twitter || '',
              telegram: blueprint.telegram || '',
              website: blueprint.website || ''
            });
            
            metadataUri = ipfsResult.metadataUri;
            console.log('[Deploy] IPFS upload result:', JSON.stringify(ipfsResult));
            
            if (metadataUri) {
              try {
                const fetch = (await import('node-fetch')).default;
                const metaResponse = await fetch(metadataUri);
                const metaJson = await metaResponse.json();
                if (metaJson.image) {
                  blueprint.ipfsImageUrl = metaJson.image;
                  console.log('[Deploy] Got image URL from metadata:', metaJson.image);
                }
              } catch (metaErr) {
                console.error('[Deploy] Failed to fetch metadata:', metaErr.message);
              }
            }
          }
        } catch (ipfsError) {
          console.error('IPFS upload error:', ipfsError);
        }
      }
      
      if (!metadataUri) {
        metadataUri = `https://pump.fun/api/ipfs/placeholder/${blueprint.symbol}`;
      }
      
      const txBytes = await pumpportal.createTokenTransaction({
        publicKey: signerKeypair.publicKey.toBase58(),
        name: blueprint.name,
        symbol: blueprint.symbol,
        metadataUri: metadataUri,
        mintPublicKey: mintKeypair.publicKey.toBase58(),
        initialBuyAmount: 0,
        slippage: 10,
        priorityFee: 0.0005
      });
      
      const signature = await solana.signAndSendTransaction(txBytes, [signerKeypair, mintKeypair]);
      
      const token = await db.createToken({
        mintAddress: mintKeypair.publicKey.toBase58(),
        name: blueprint.name,
        symbol: blueprint.symbol,
        description: blueprint.description || '',
        imageUrl: blueprint.ipfsImageUrl || '',
        metadataUri: metadataUri,
        walletPublicKey: signerKeypair.publicKey.toBase58(),
        walletPrivateKeyEncrypted: session.wallet_private_key_encrypted,
        status: 'active'
      });
      
      await db.markVanityAddressUsed(reservedAddress.id, token.id);
      console.log(`[Deploy] Marked vanity address ${reservedAddress.public_key} as used`);
      deploymentSucceeded = true;
      
      await db.updateSessionStatus(session.id, 'completed', token.id);
      
      pumpportal.subscribeToToken(token.mint_address);
      
      vanityPool.triggerGeneration();
      
      res.json({
        success: true,
        token: {
          id: token.id,
          mintAddress: token.mint_address,
          name: token.name,
          symbol: token.symbol,
          pumpfunUrl: `https://pump.fun/coin/${token.mint_address}`,
          solscanUrl: `https://solscan.io/token/${token.mint_address}`
        },
        transactionSignature: signature
      });
      
    } catch (deployError) {
      console.error('Error during deployment:', deployError);
      
      if (!deploymentSucceeded) {
        try {
          await db.releaseVanityAddress(reservedAddress.id);
          console.log(`[Deploy] Released vanity address ${reservedAddress.public_key} back to pool`);
        } catch (releaseErr) {
          console.error('Error releasing vanity address:', releaseErr);
        }
      }
      
      throw deployError;
    }
    
  } catch (error) {
    console.error('Error deploying token:', error);
    
    try {
      await db.updateSessionStatus(req.params.id, 'failed', null, error.message);
    } catch (e) {}
    
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/session/:id/refund', async (req, res) => {
  try {
    if (!isValidUUID(req.params.id)) {
      return res.status(400).json({ success: false, error: 'Invalid session ID' });
    }
    
    const session = await db.getSession(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }
    
    let { destinationWallet } = req.body;
    if (!destinationWallet) {
      destinationWallet = session.funding_wallet;
    }
    if (!destinationWallet || !solana.isValidSolanaAddress(destinationWallet)) {
      return res.status(400).json({ success: false, error: 'No funding wallet found. Please provide destinationWallet.' });
    }
    
    if (session.status === 'completed') {
      return res.status(400).json({ success: false, error: 'Cannot refund completed session' });
    }
    
    if (!session.wallet_private_key_encrypted) {
      return res.status(400).json({ success: false, error: 'No wallet associated with this session' });
    }
    
    const balance = await solana.getBalance(session.deposit_address);
    if (balance <= 0) {
      return res.status(400).json({ success: false, error: 'No funds to refund', balance: 0 });
    }
    
    const txFee = 0.000005;
    const refundAmount = balance - txFee;
    
    if (refundAmount <= 0) {
      return res.status(400).json({ success: false, error: 'Balance too low to cover transaction fee', balance });
    }
    
    const secretKey = decrypt(session.wallet_private_key_encrypted);
    const keypair = solana.keypairFromSecretKey(secretKey);
    
    const signature = await solana.transferSOL(keypair, destinationWallet, refundAmount);
    
    await db.updateSessionStatus(session.id, 'refunded');
    
    console.log(`[Refund] Session ${session.id}: ${refundAmount} SOL sent to ${destinationWallet}, tx: ${signature}`);
    
    res.json({
      success: true,
      refundedAmount: refundAmount,
      destinationWallet,
      transactionSignature: signature,
      solscanUrl: `https://solscan.io/tx/${signature}`
    });
    
  } catch (error) {
    console.error('Error processing refund:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/pool/status', async (req, res) => {
  try {
    const status = await vanityPool.getPoolStatus();
    res.json({ success: true, pool: status });
  } catch (error) {
    console.error('Error getting pool status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/pool/generate', async (req, res) => {
  try {
    vanityPool.triggerGeneration();
    res.json({ success: true, message: 'Generation triggered' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/tokens', async (req, res) => {
  try {
    const status = req.query.status || 'all';
    let tokens;
    
    if (status === 'active') {
      tokens = await db.getActiveTokens(50);
    } else if (status === 'graduated') {
      tokens = await db.getGraduatedTokens(50);
    } else {
      tokens = await db.getRecentTokens(50);
    }
    
    res.json({
      success: true,
      tokens: tokens.map(t => ({
        id: t.id,
        mintAddress: t.mint_address,
        name: t.name,
        symbol: t.symbol,
        description: t.description,
        imageUrl: t.image_url,
        status: t.status,
        bondingProgress: t.bonding_progress,
        marketCap: t.market_cap,
        totalBurned: t.total_burned,
        createdAt: t.created_at,
        graduatedAt: t.graduated_at,
        pumpfunUrl: `https://pump.fun/coin/${t.mint_address}`
      }))
    });
  } catch (error) {
    console.error('Error getting tokens:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/tokens/recent', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 5;
    const tokens = await db.getRecentTokens(limit);
    
    res.json({
      success: true,
      tokens: tokens.map(t => ({
        id: t.id,
        mintAddress: t.mint_address,
        name: t.name,
        symbol: t.symbol,
        status: t.status,
        bondingProgress: t.bonding_progress,
        marketCap: t.market_cap,
        createdAt: t.created_at,
        pumpfunUrl: `https://pump.fun/coin/${t.mint_address}`
      }))
    });
  } catch (error) {
    console.error('Error getting recent tokens:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/tokens/graduated', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 5;
    const tokens = await db.getGraduatedTokens(limit);
    
    res.json({
      success: true,
      tokens: tokens.map(t => ({
        id: t.id,
        mintAddress: t.mint_address,
        name: t.name,
        symbol: t.symbol,
        pumpswapPool: t.pumpswap_pool,
        marketCap: t.market_cap,
        totalBurned: t.total_burned,
        graduatedAt: t.graduated_at,
        pumpfunUrl: `https://pump.fun/coin/${t.mint_address}`
      }))
    });
  } catch (error) {
    console.error('Error getting graduated tokens:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/burns', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const burns = await db.getRecentBurns(limit);
    const stats = await db.getBurnStats();
    
    res.json({
      success: true,
      stats: {
        totalSolSpent: stats.total_sol_spent,
        totalTokensBurned: stats.total_tokens_burned,
        totalBurns: stats.total_burns
      },
      burns: burns.map(b => ({
        id: b.id,
        tokenName: b.name,
        tokenSymbol: b.symbol,
        solSpent: b.sol_spent,
        tokensBurned: b.tokens_burned,
        txSignature: b.tx_signature,
        createdAt: b.created_at,
        solscanUrl: `https://solscan.io/tx/${b.tx_signature}`
      }))
    });
  } catch (error) {
    console.error('Error getting burns:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const tokens = await db.getAllTokens();
    const burnStats = await db.getBurnStats();
    const poolStatus = await db.getVanityPoolStats();
    
    const totalLaunches = tokens.length;
    const activeCount = tokens.filter(t => t.status === 'active').length;
    const graduatedCount = tokens.filter(t => t.status === 'graduated').length;
    const totalBurned = tokens.reduce((sum, t) => sum + parseFloat(t.total_burned || 0), 0);
    
    res.json({
      success: true,
      stats: {
        totalLaunches,
        active: activeCount,
        graduated: graduatedCount,
        totalTokensBurned: totalBurned,
        clawAddressesReady: poolStatus?.available || 0,
        burnStats: {
          totalSolSpent: burnStats.total_sol_spent || 0,
          totalTokensBurned: burnStats.total_tokens_burned || 0,
          totalBurns: burnStats.total_burns || 0
        }
      }
    });
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.get('/docs', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'docs.html'));
});

app.get('/tokens', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tokens.html'));
});

app.get('/features', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'features.html'));
});

app.get('/openclaw', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'openclaw.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Direct AI Chat endpoint (replaces OpenClaw gateway)
const chatHistories = new Map();

app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }

    // Get or create chat history for this session
    const chatKey = sessionId || 'default';
    if (!chatHistories.has(chatKey)) {
      chatHistories.set(chatKey, []);
    }
    const history = chatHistories.get(chatKey);
    
    // Add user message to history
    history.push({ role: 'user', content: message });
    
    // Keep last 20 messages to avoid token limits
    if (history.length > 20) {
      history.splice(0, history.length - 20);
    }

    // Call Claude API (using Replit AI Integrations)
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 4096,
      system: CLAWP_SYSTEM_PROMPT,
      messages: history
    });

    const assistantMessage = response.content[0].text;
    
    // Add assistant response to history
    history.push({ role: 'assistant', content: assistantMessage });

    // Try to extract blueprint JSON from response
    let blueprint = null;
    const jsonMatch = assistantMessage.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      try {
        blueprint = JSON.parse(jsonMatch[1]);
      } catch (e) {
        // Not valid JSON, ignore
      }
    }

    res.json({
      success: true,
      message: assistantMessage,
      blueprint: blueprint
    });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Clear chat history endpoint
app.post('/api/chat/clear', (req, res) => {
  const { sessionId } = req.body;
  const chatKey = sessionId || 'default';
  chatHistories.delete(chatKey);
  res.json({ success: true });
});

pumpportal.connectWebSocket((message) => {
  if (message.txType === 'migration') {
    handleMigration(message);
  }
});

async function handleMigration(message) {
  try {
    const token = await db.getTokenByMint(message.mint);
    if (token) {
      await db.updateTokenStatus(token.id, 'graduated', message.pool || null);
      console.log(`[Migration] Token ${token.symbol} graduated to PumpSwap`);
    }
  } catch (error) {
    console.error('Error handling migration:', error);
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`CLAWP Agent running on http://0.0.0.0:${PORT}`);
  console.log(`AI Chat: Direct Claude API (no gateway)`);
  console.log(`API endpoints ready`);
  
  startBuybackScheduler();
  vanityPool.startPoolManager();
});
