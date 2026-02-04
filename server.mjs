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
const PORT = process.env.PORT || 5000;

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

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function generateThemeColors(narrative, name, description) {
  const text = `${narrative || ''} ${name || ''} ${description || ''}`.toLowerCase();
  const themes = [
    { keywords: ['dog', 'doge', 'shiba', 'puppy', 'woof', 'loyal'], primary: '#ff8c00', accent: '#ffd700' },
    { keywords: ['cat', 'kitty', 'meow', 'feline', 'nyan'], primary: '#9b59b6', accent: '#e91e63' },
    { keywords: ['dragon', 'fire', 'flame', 'burn', 'blaze'], primary: '#ff4444', accent: '#ff6b6b' },
    { keywords: ['moon', 'lunar', 'night', 'dark', 'shadow'], primary: '#3498db', accent: '#9b59b6' },
    { keywords: ['sun', 'solar', 'gold', 'bright', 'light'], primary: '#f1c40f', accent: '#e67e22' },
    { keywords: ['ocean', 'sea', 'water', 'wave', 'aqua'], primary: '#00bcd4', accent: '#03a9f4' },
    { keywords: ['forest', 'tree', 'nature', 'green', 'leaf'], primary: '#27ae60', accent: '#2ecc71' },
    { keywords: ['degen', 'ape', 'yolo', 'send', 'pump'], primary: '#00ff88', accent: '#00cc6a' },
    { keywords: ['robot', 'ai', 'cyber', 'tech', 'bot'], primary: '#00ffff', accent: '#00bcd4' },
    { keywords: ['frog', 'pepe', 'kek', 'rare'], primary: '#4caf50', accent: '#8bc34a' },
    { keywords: ['claw', 'crab', 'lobster', 'pinch'], primary: '#ff4444', accent: '#ff6b6b' }
  ];
  
  for (const theme of themes) {
    if (theme.keywords.some(kw => text.includes(kw))) {
      return { primary: theme.primary, accent: theme.accent };
    }
  }
  return { primary: '#ff4444', accent: '#ff6b6b' };
}

const AGENT_ARCHETYPES = [
  'Philosopher', 'Joker', 'Engineer', 'Mystic', 'Degen', 
  'Sage', 'Rebel', 'Artist', 'Explorer', 'Guardian'
];

async function generateAgentSkill(token, blueprint) {
  const prompt = `You are creating an AI agent personality for a meme token on Moltbook (a social network for AI agents).

Token Info:
- Name: ${token.name}
- Symbol: ${token.symbol}
- Description: ${token.description || blueprint.description || 'A meme token'}
- Narrative: ${blueprint.narrative || 'A community-driven meme token'}

Create a unique agent personality that embodies this token's spirit. The agent will post on Moltbook to engage with the AI agent community.

IMPORTANT RULES:
- The agent must NEVER mention contract addresses, prices, or financial details in posts
- Posts should provide value: insights, humor, philosophy, tutorials, or entertainment
- The agent should feel like a real personality, not a promotional bot
- Content should be thoughtful and engaging, not spammy

Available archetypes: ${AGENT_ARCHETYPES.join(', ')}

Return a JSON object with:
{
  "archetype": "One of the archetypes above that best fits the token theme",
  "voice": "A 1-2 sentence description of how the agent speaks and their personality",
  "topics": ["3-5 topics the agent is passionate about discussing"],
  "quirks": ["2-3 unique personality quirks or catchphrases"],
  "samplePosts": ["3 example posts the agent might make on Moltbook - max 280 chars each"],
  "introPost": "A compelling introduction post for the agent's first Moltbook post - max 280 chars"
}

Output ONLY the JSON, no markdown or explanation.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.content[0].text;
    let skillData;
    
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      skillData = JSON.parse(jsonMatch[0]);
    } else {
      skillData = JSON.parse(text);
    }
    
    if (!AGENT_ARCHETYPES.includes(skillData.archetype)) {
      skillData.archetype = 'Degen';
    }
    
    return skillData;
  } catch (error) {
    console.error('Error generating agent skill:', error);
    return {
      archetype: 'Degen',
      voice: `The voice of ${token.symbol}, speaking truth to the blockchain.`,
      topics: ['crypto culture', 'memes', 'community'],
      quirks: [`Always ends with ${token.symbol} vibes`, 'Speaks in metaphors'],
      samplePosts: [
        `Another day in the trenches. ${token.symbol} stays based.`,
        `When the market dips, we vibe. When it pumps, we vibe harder.`,
        `Building something real in a world of noise. ${token.name} community stands together.`
      ],
      introPost: `gm Moltbook! ${token.name} agent reporting for duty. Here to bring vibes, insights, and ${token.symbol} energy to the timeline.`
    };
  }
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

app.get('/api/session/:id/status', async (req, res) => {
  try {
    if (!isValidUUID(req.params.id)) {
      return res.status(400).json({ success: false, error: 'Invalid session ID' });
    }
    const session = await db.getSession(req.params.id);
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }
    
    let token = null;
    if (session.token_id) {
      const tokenData = await db.getToken(session.token_id);
      if (tokenData) {
        token = {
          mintAddress: tokenData.mint_address,
          name: tokenData.name,
          symbol: tokenData.symbol,
          slug: tokenData.slug,
          landingPageUrl: tokenData.slug ? `/${tokenData.slug}` : null
        };
      }
    }
    
    res.json({
      status: session.status,
      token: token,
      error: session.error_message
    });
  } catch (error) {
    console.error('Error getting session status:', error);
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
    
    const MAX_CLAW_RETRIES = 10;
    let clawRetryCount = 0;
    let lastError = null;
    
    while (clawRetryCount < MAX_CLAW_RETRIES) {
      console.log(`[Deploy] Reserving pre-generated CLAW mint address from pool (attempt ${clawRetryCount + 1})...`);
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
            
            if (ipfsResult.metadata && ipfsResult.metadata.image) {
              blueprint.ipfsImageUrl = ipfsResult.metadata.image;
              console.log('[Deploy] Got image URL from IPFS result:', blueprint.ipfsImageUrl);
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
        status: 'active',
        websiteUrl: blueprint.website || null,
        twitterUrl: blueprint.twitter || null
      });
      
      const narrative = blueprint.narrative || '';
      const themeColors = generateThemeColors(narrative, blueprint.name, blueprint.description);
      const slug = await db.generateUniqueSlug(blueprint.symbol);
      await db.updateTokenLandingData(token.id, narrative, themeColors.primary, themeColors.accent, slug);
      console.log(`[Deploy] Landing page ready at /${slug}`);
      
      await db.markVanityAddressUsed(reservedAddress.id, token.id);
      console.log(`[Deploy] Marked vanity address ${reservedAddress.public_key} as used`);
      deploymentSucceeded = true;
      
      await db.updateSessionStatus(session.id, 'completed', token.id);
      
      pumpportal.subscribeToToken(token.mint_address);
      
      vanityPool.triggerGeneration();
      
      // Generate AI agent personality for this token (non-blocking)
      let agentSkill = null;
      try {
        console.log(`[Deploy] Generating agent personality for ${token.symbol}...`);
        const skillData = await generateAgentSkill(token, blueprint);
        agentSkill = await db.createAgentSkill(token.id, skillData);
        console.log(`[Deploy] Agent personality created: ${agentSkill.archetype}`);
      } catch (agentError) {
        console.error('[Deploy] Agent skill generation failed (non-critical):', agentError.message);
      }
      
      return res.json({
        success: true,
        token: {
          id: token.id,
          mintAddress: token.mint_address,
          name: token.name,
          symbol: token.symbol,
          slug: slug,
          pumpfunUrl: `https://pump.fun/coin/${token.mint_address}`,
          solscanUrl: `https://solscan.io/token/${token.mint_address}`,
          landingPageUrl: `/${slug}`
        },
        agentSkill: agentSkill ? {
          id: agentSkill.id,
          archetype: agentSkill.archetype,
          voice: agentSkill.voice,
          status: agentSkill.status
        } : null,
        transactionSignature: signature
      });
      
      } catch (deployError) {
        console.error('Error during deployment:', deployError);
        
        if (!deploymentSucceeded && reservedAddress) {
          const errorMsg = deployError.message || '';
          const isAlreadyInUse = errorMsg.includes('already in use') || 
                                 (deployError.transactionLogs && deployError.transactionLogs.some(log => log.includes('already in use')));
          
          try {
            if (isAlreadyInUse) {
              await db.markVanityAddressBurned(reservedAddress.id);
              console.log(`[Deploy] Marked vanity address ${reservedAddress.public_key} as BURNED (already in use on blockchain)`);
              clawRetryCount++;
              lastError = deployError;
              console.log(`[Deploy] Retrying with different CLAW address...`);
              continue;
            } else {
              await db.releaseVanityAddress(reservedAddress.id);
              console.log(`[Deploy] Released vanity address ${reservedAddress.public_key} back to pool`);
            }
          } catch (releaseErr) {
            console.error('Error handling vanity address after failure:', releaseErr);
          }
        }
        
        throw deployError;
      }
    }
    
    if (lastError) {
      console.error(`[Deploy] Failed after ${MAX_CLAW_RETRIES} CLAW address attempts`);
      throw lastError;
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

// Admin Manual Launch Endpoint
const ADMIN_PASSWORD = 'qwerty1234';

app.post('/api/admin/prepare-launch', async (req, res) => {
  try {
    const { name, symbol, description, narrative, logo, websiteUrl, twitterUrl, adminPassword } = req.body;
    
    if (adminPassword !== ADMIN_PASSWORD) {
      return res.status(403).json({ success: false, error: 'Invalid admin password' });
    }
    
    if (!name || !symbol || !description) {
      return res.status(400).json({ success: false, error: 'Name, symbol, and description are required' });
    }
    
    if (!logo) {
      return res.status(400).json({ success: false, error: 'Logo is required' });
    }
    
    let logoBase64 = logo;
    if (logo.startsWith('data:')) {
      logoBase64 = logo.split(',')[1];
    }
    
    const wallet = solana.generateWallet();
    const depositAddress = wallet.publicKey;
    const encryptedKey = encrypt(wallet.secretKey);
    
    const blueprint = {
      name: sanitizeText(name, 50),
      symbol: sanitizeText(symbol, 10).toUpperCase(),
      description: sanitizeText(description, 500),
      narrative: sanitizeText(narrative || '', 2000),
      logoBase64: logoBase64,
      website: websiteUrl || '',
      twitter: twitterUrl || '',
      isAdminLaunch: true,
      buybackPlan: {
        mode: 'continuous',
        trigger: 'creator_fees_inflow',
        execution: 'automatic',
        percentage: 60
      }
    };
    
    const session = await db.createSession(blueprint, depositAddress, encryptedKey);
    
    console.log(`[Admin] Manual launch prepared: ${name} ($${symbol}), deposit: ${depositAddress}`);
    
    res.json({
      success: true,
      sessionId: session.id,
      depositAddress: depositAddress,
      depositAmount: 0.025
    });
    
  } catch (error) {
    console.error('[Admin] Error preparing launch:', error);
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
        slug: t.slug,
        description: t.description,
        imageUrl: t.image_url,
        status: t.status,
        bondingProgress: t.bonding_progress,
        marketCap: t.market_cap,
        totalBurned: t.total_burned,
        createdAt: t.created_at,
        graduatedAt: t.graduated_at,
        pumpfunUrl: `https://pump.fun/coin/${t.mint_address}`,
        landingPageUrl: t.slug ? `/${t.slug}` : null
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
        slug: t.slug,
        status: t.status,
        bondingProgress: t.bonding_progress,
        marketCap: t.market_cap,
        createdAt: t.created_at,
        pumpfunUrl: `https://pump.fun/coin/${t.mint_address}`,
        landingPageUrl: t.slug ? `/${t.slug}` : null
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
        slug: t.slug,
        pumpswapPool: t.pumpswap_pool,
        marketCap: t.market_cap,
        totalBurned: t.total_burned,
        graduatedAt: t.graduated_at,
        pumpfunUrl: `https://pump.fun/coin/${t.mint_address}`,
        landingPageUrl: t.slug ? `/${t.slug}` : null
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

app.get('/secret', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'secret.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/:slug', async (req, res) => {
  try {
    const slug = req.params.slug.toLowerCase();
    
    if (slug.includes('.') || slug.length > 50 || ['app', 'secret', 'api', 'health', 'favicon.ico', 'openclaw.html'].includes(slug)) {
      return res.status(404).send('Token not found');
    }
    
    const token = await db.getTokenBySlug(slug);
    if (!token) {
      return res.status(404).send('Token not found');
    }
    
    let template = fs.readFileSync(path.join(__dirname, 'public', 'token-page.html'), 'utf-8');
    
    const themePrimary = token.theme_primary || '#ff4444';
    const themeAccent = token.theme_accent || '#ff6b6b';
    
    const logoContent = token.image_url 
      ? `<img src="${escapeHtml(token.image_url)}" alt="${escapeHtml(token.name)}">`
      : escapeHtml(token.symbol?.charAt(0) || '?');
    
    const narrativeSection = token.narrative 
      ? `<section class="narrative-section">
          <div class="terminal-header">
            <span class="terminal-dot red"></span>
            <span class="terminal-dot yellow"></span>
            <span class="terminal-dot green"></span>
            <span class="terminal-title">lore.txt</span>
          </div>
          <div class="narrative-content">${escapeHtml(token.narrative)}</div>
        </section>`
      : '';
    
    const statusText = token.status === 'graduated' ? 'Graduated to PumpSwap' : 'Active on Bonding Curve';
    const statusDisplay = token.status === 'graduated' ? 'Graduated' : 'Active';
    
    const totalBurned = parseFloat(token.total_burned || 0);
    const burnedDisplay = totalBurned > 1000000 
      ? `${(totalBurned / 1000000).toFixed(2)}M` 
      : totalBurned > 1000 
        ? `${(totalBurned / 1000).toFixed(2)}K`
        : totalBurned.toFixed(0);
    
    const createdDate = token.created_at 
      ? new Date(token.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : 'Unknown';
    
    let socialLinksHtml = '';
    if (token.website_url || token.twitter_url) {
      const links = [];
      if (token.website_url) {
        links.push(`<a href="${escapeHtml(token.website_url)}" target="_blank" class="social-link">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
          Website
        </a>`);
      }
      if (token.twitter_url) {
        links.push(`<a href="${escapeHtml(token.twitter_url)}" target="_blank" class="social-link">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
          Twitter
        </a>`);
      }
      socialLinksHtml = `<div class="social-links">${links.join('')}</div>`;
    }
    
    // Build agent section if agent skill is claimed
    let agentSection = '';
    try {
      const agentSkill = await db.getAgentSkillByTokenId(token.id);
      if (agentSkill && agentSkill.status !== 'unclaimed') {
        const archetypeEmojis = {
          'Philosopher': '🧠', 'Joker': '🃏', 'Engineer': '⚙️', 'Mystic': '🔮',
          'Degen': '🦍', 'Sage': '📚', 'Rebel': '⚡', 'Artist': '🎨',
          'Explorer': '🧭', 'Guardian': '🛡️'
        };
        const emoji = archetypeEmojis[agentSkill.archetype] || '🤖';
        const moltbookUrl = agentSkill.moltbook_username 
          ? `https://moltbook.com/@${escapeHtml(agentSkill.moltbook_username)}`
          : '#';
        
        agentSection = `
          <section class="agent-section" style="margin: 40px 0; padding: 24px; background: var(--bg-secondary); border-radius: 16px; border: 1px solid var(--border-color);">
            <h3 style="display: flex; align-items: center; gap: 10px; margin-bottom: 16px; font-family: 'Space Grotesk', sans-serif;">
              <span style="font-size: 1.5rem;">${emoji}</span> AI Agent
            </h3>
            <div style="margin-bottom: 12px;">
              <span style="background: linear-gradient(135deg, var(--theme-primary), var(--theme-accent)); padding: 4px 12px; border-radius: 12px; font-size: 0.85rem; font-weight: 600;">
                ${escapeHtml(agentSkill.archetype)}
              </span>
            </div>
            <p style="color: var(--text-secondary); margin-bottom: 16px; font-size: 0.95rem;">
              ${escapeHtml(agentSkill.voice)}
            </p>
            ${agentSkill.moltbook_username ? `
              <a href="${moltbookUrl}" target="_blank" style="display: inline-flex; align-items: center; gap: 8px; padding: 10px 20px; background: linear-gradient(135deg, var(--success), #00cc6a); color: #0a0a0f; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 0.9rem;">
                Follow on Moltbook
              </a>
            ` : ''}
          </section>
        `;
      }
    } catch (agentErr) {
      console.error('Error fetching agent for token page:', agentErr.message);
    }
    
    template = template
      .replace(/\{\{TOKEN_NAME\}\}/g, escapeHtml(token.name || ''))
      .replace(/\{\{TOKEN_SYMBOL\}\}/g, escapeHtml(token.symbol || ''))
      .replace(/\{\{TOKEN_DESCRIPTION\}\}/g, escapeHtml(token.description || ''))
      .replace(/\{\{TOKEN_IMAGE\}\}/g, escapeHtml(token.image_url || ''))
      .replace(/\{\{TOKEN_LOGO_CONTENT\}\}/g, logoContent)
      .replace(/\{\{MINT_ADDRESS\}\}/g, escapeHtml(token.mint_address || ''))
      .replace(/\{\{THEME_PRIMARY\}\}/g, themePrimary)
      .replace(/\{\{THEME_ACCENT\}\}/g, themeAccent)
      .replace(/\{\{TOKEN_STATUS\}\}/g, token.status || 'active')
      .replace(/\{\{TOKEN_STATUS_TEXT\}\}/g, statusText)
      .replace(/\{\{TOKEN_STATUS_DISPLAY\}\}/g, statusDisplay)
      .replace(/\{\{TOTAL_BURNED\}\}/g, burnedDisplay)
      .replace(/\{\{CREATED_DATE\}\}/g, createdDate)
      .replace(/\{\{NARRATIVE_SECTION\}\}/g, narrativeSection)
      .replace(/\{\{SOCIAL_LINKS\}\}/g, socialLinksHtml)
      .replace(/\{\{AGENT_SECTION\}\}/g, agentSection);
    
    res.send(template);
  } catch (error) {
    console.error('Error serving token page:', error);
    res.status(500).send('Error loading token page');
  }
});

// Agent Skills API endpoints
app.get('/api/agents', async (req, res) => {
  try {
    const unclaimed = await db.getUnclaimedAgentSkills(50);
    const claimed = await db.getClaimedAgentSkills(50);
    res.json({ success: true, unclaimed, claimed });
  } catch (error) {
    console.error('Error fetching agents:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/agents/token/:tokenId', async (req, res) => {
  try {
    const tokenId = parseInt(req.params.tokenId, 10);
    if (isNaN(tokenId)) {
      return res.status(400).json({ success: false, error: 'Invalid token ID' });
    }
    
    const skill = await db.getAgentSkillByTokenId(tokenId);
    if (!skill) {
      return res.status(404).json({ success: false, error: 'Agent skill not found' });
    }
    
    const posts = await db.getAgentPosts(skill.id, 20);
    
    res.json({
      success: true,
      skill: {
        id: skill.id,
        archetype: skill.archetype,
        voice: skill.voice,
        topics: skill.topics,
        quirks: skill.quirks,
        samplePosts: skill.sample_posts,
        introPost: skill.intro_post,
        status: skill.status,
        moltbookUsername: skill.moltbook_username,
        karma: skill.karma,
        postsCount: skill.posts_count,
        claimedAt: skill.claimed_at,
        lastPostAt: skill.last_post_at
      },
      posts
    });
  } catch (error) {
    console.error('Error fetching agent skill:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/agents/:id/claim', async (req, res) => {
  try {
    const skillId = parseInt(req.params.id, 10);
    if (isNaN(skillId)) {
      return res.status(400).json({ success: false, error: 'Invalid skill ID' });
    }
    
    const { apiKey, username, agentId } = req.body;
    if (!apiKey || !username) {
      return res.status(400).json({ success: false, error: 'API key and username required' });
    }
    
    const skill = await db.getAgentSkill(skillId);
    if (!skill) {
      return res.status(404).json({ success: false, error: 'Agent skill not found' });
    }
    if (skill.status !== 'unclaimed') {
      return res.status(400).json({ success: false, error: 'Agent already claimed' });
    }
    
    const encryptedApiKey = encrypt(apiKey);
    const updated = await db.updateAgentSkillClaim(skillId, encryptedApiKey, username, agentId || null);
    
    res.json({
      success: true,
      skill: {
        id: updated.id,
        status: updated.status,
        moltbookUsername: updated.moltbook_username,
        claimedAt: updated.claimed_at
      }
    });
  } catch (error) {
    console.error('Error claiming agent:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/agents/:id/generate-post', async (req, res) => {
  try {
    const skillId = parseInt(req.params.id, 10);
    if (isNaN(skillId)) {
      return res.status(400).json({ success: false, error: 'Invalid skill ID' });
    }
    
    const skill = await db.getAgentSkill(skillId);
    if (!skill) {
      return res.status(404).json({ success: false, error: 'Agent skill not found' });
    }
    
    const token = await db.getToken(skill.token_id);
    
    const prompt = `You are an AI agent for ${token.name} (${token.symbol}) on Moltbook.

Your personality:
- Archetype: ${skill.archetype}
- Voice: ${skill.voice}
- Topics: ${JSON.parse(skill.topics || '[]').join(', ')}
- Quirks: ${JSON.parse(skill.quirks || '[]').join(', ')}

Generate a new post for Moltbook. The post should:
- Be engaging and provide value to the AI agent community
- Reflect your unique personality and archetype
- NEVER mention contract addresses, prices, or financial details
- Be max 280 characters
- Feel authentic, not promotional

Previous sample posts for reference:
${JSON.parse(skill.sample_posts || '[]').join('\n')}

Generate ONE new unique post. Output ONLY the post text, no quotes or explanation.`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }]
    });

    const postContent = response.content[0].text.trim().replace(/^["']|["']$/g, '');
    const post = await db.createAgentPost(skillId, postContent.slice(0, 280));
    
    res.json({
      success: true,
      post: {
        id: post.id,
        content: post.content,
        status: post.status
      }
    });
  } catch (error) {
    console.error('Error generating post:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/agents/:id/suggested-posts', async (req, res) => {
  try {
    const skillId = parseInt(req.params.id, 10);
    if (isNaN(skillId)) {
      return res.status(400).json({ success: false, error: 'Invalid skill ID' });
    }
    
    const posts = await db.getSuggestedPosts(skillId, 5);
    res.json({ success: true, posts });
  } catch (error) {
    console.error('Error fetching suggested posts:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/agents/:id/posts/:postId/mark', async (req, res) => {
  try {
    const skillId = parseInt(req.params.id, 10);
    const postId = parseInt(req.params.postId, 10);
    if (isNaN(skillId) || isNaN(postId)) {
      return res.status(400).json({ success: false, error: 'Invalid IDs' });
    }
    
    const { status, moltbookPostId, moltbookPostUrl } = req.body;
    if (!['posted', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, error: 'Status must be posted or rejected' });
    }
    
    const updated = await db.updateAgentPostStatus(postId, status, moltbookPostId, moltbookPostUrl);
    
    if (status === 'posted') {
      await db.markAgentLastPost(skillId);
    }
    
    res.json({ success: true, post: updated });
  } catch (error) {
    console.error('Error marking post:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/agents/regenerate/:tokenId', async (req, res) => {
  try {
    const tokenId = parseInt(req.params.tokenId, 10);
    if (isNaN(tokenId)) {
      return res.status(400).json({ success: false, error: 'Invalid token ID' });
    }
    
    const token = await db.getToken(tokenId);
    if (!token) {
      return res.status(404).json({ success: false, error: 'Token not found' });
    }
    
    const existingSkill = await db.getAgentSkillByTokenId(tokenId);
    if (existingSkill && existingSkill.status !== 'unclaimed') {
      return res.status(400).json({ success: false, error: 'Cannot regenerate claimed agent' });
    }
    
    // Delete existing skill if unclaimed
    if (existingSkill) {
      await db.query('DELETE FROM agent_skills WHERE id = $1', [existingSkill.id]);
    }
    
    const blueprint = { narrative: token.narrative || '', description: token.description };
    const skillData = await generateAgentSkill(token, blueprint);
    const newSkill = await db.createAgentSkill(tokenId, skillData);
    
    res.json({
      success: true,
      skill: {
        id: newSkill.id,
        archetype: newSkill.archetype,
        voice: newSkill.voice,
        topics: newSkill.topics,
        quirks: newSkill.quirks,
        samplePosts: newSkill.sample_posts,
        introPost: newSkill.intro_post,
        status: newSkill.status
      }
    });
  } catch (error) {
    console.error('Error regenerating agent:', error);
    res.status(500).json({ success: false, error: error.message });
  }
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

// Validate critical env vars
const requiredEnvs = ['DATABASE_URL'];
const missingEnvs = requiredEnvs.filter(e => !process.env[e]);
if (missingEnvs.length > 0) {
  console.error(`FATAL: Missing required env vars: ${missingEnvs.join(', ')}`);
  process.exit(1);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`CLAWP Agent running on http://0.0.0.0:${PORT}`);
  console.log(`AI Chat: Direct Claude API (no gateway)`);
  console.log(`API endpoints ready`);
  
  startBuybackScheduler();
  vanityPool.startPoolManager();
});
