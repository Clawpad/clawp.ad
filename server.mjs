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
import { startBagsFeeClaimer } from './src/bags-fee-claimer.mjs';
import { startPumpfunFeeClaimer } from './src/pumpfun-fee-claimer.mjs';
import { startClankerFeeClaimer } from './src/clanker-fee-claimer.mjs';
import * as bagsSDK from './src/bags-sdk.mjs';
import * as clankerSDK from './src/clanker.mjs';
import * as baseWallet from './src/base-wallet.mjs';
import * as bnbWallet from './src/bnb-wallet.mjs';
import * as fourmemeSDK from './src/fourmeme.mjs';
import fs from 'node:fs';
import erc8004 from './src/erc8004.mjs';
import { startAutoPostScheduler, testPostForAgent } from './src/moltbook-autoposter.mjs';

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

function getRequiredDeposit(venue) {
  if (venue === 'bags.fm') return 0.06;
  if (venue === 'clanker') return 0.001;
  if (venue === 'four.meme') return 0.005;
  return 0.025;
}

function getChainForVenue(venue) {
  if (venue === 'clanker') return 'base';
  if (venue === 'four.meme') return 'bnb';
  return 'solana';
}

function getVenuePlatformUrl(venue, mintAddress) {
  switch (venue) {
    case 'bags.fm': return `https://bags.fm/token/${mintAddress}`;
    case 'clanker': return `https://clanker.world/clanker/${mintAddress}`;
    case 'four.meme': return `https://four.meme/token/${mintAddress}`;
    default: return `https://pump.fun/coin/${mintAddress}`;
  }
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
    const { venue = 'pump.fun' } = req.body || {};
    const validVenues = ['pump.fun', 'bags.fm', 'clanker', 'four.meme'];
    const selectedVenue = validVenues.includes(venue) ? venue : 'pump.fun';
    
    let wallet, encryptedPrivKey;
    
    if (selectedVenue === 'clanker') {
      wallet = baseWallet.generateWallet();
      encryptedPrivKey = encrypt(wallet.secretKey);
    } else if (selectedVenue === 'four.meme') {
      wallet = bnbWallet.generateWallet();
      encryptedPrivKey = encrypt(wallet.secretKey);
    } else {
      wallet = solana.generateWallet();
      encryptedPrivKey = encrypt(wallet.secretKey);
    }
    
    const session = await db.createSession(null, wallet.publicKey, encryptedPrivKey, selectedVenue);
    
    res.json({
      success: true,
      sessionId: session.id,
      depositAddress: wallet.publicKey,
      requiredAmount: getRequiredDeposit(selectedVenue),
      expiresIn: 1800,
      venue: selectedVenue,
      chain: getChainForVenue(selectedVenue)
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
    const venue = session.venue || 'pump.fun';
    if (session.deposit_address) {
      try {
        if (venue === 'four.meme') {
          balance = await bnbWallet.getBalance(session.deposit_address);
        } else if (venue === 'clanker') {
          balance = await baseWallet.getBalance(session.deposit_address);
        } else {
          balance = await solana.getBalance(session.deposit_address);
        }
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
        expiresAt: session.expires_at,
        venue: venue,
        chain: getChainForVenue(venue)
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
    
    const venue = session.venue || 'pump.fun';
    
    let balance;
    if (venue === 'four.meme') {
      balance = await bnbWallet.getBalance(session.deposit_address);
    } else if (venue === 'clanker') {
      balance = await baseWallet.getBalance(session.deposit_address);
    } else {
      balance = await solana.getBalance(session.deposit_address);
    }
    const requiredAmount = getRequiredDeposit(venue);
    
    if (balance >= requiredAmount) {
      let fundingWallet = session.funding_wallet;
      if (!fundingWallet && venue !== 'clanker' && venue !== 'four.meme') {
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
    
    const blueprint = session.blueprint;
    if (!blueprint || !blueprint.name || !blueprint.symbol) {
      return res.status(400).json({ success: false, error: 'No blueprint found' });
    }
    
    const venue = session.venue || 'pump.fun';
    
    if (venue === 'clanker') {
      const ethBalanceWei = await baseWallet.getBalanceWei(session.deposit_address);
      const requiredWei = baseWallet.parseEther(String(getRequiredDeposit('clanker')));
      const ethBalance = parseFloat(ethBalanceWei.toString()) / 1e18;
      if (ethBalanceWei < requiredWei) {
        return res.status(400).json({
          success: false,
          error: 'Insufficient ETH deposit',
          balance: ethBalance,
          required: getRequiredDeposit('clanker')
        });
      }
      
      await db.updateSessionStatus(session.id, 'deploying');
      
      try {
        const walletPrivKey = decrypt(session.wallet_private_key_encrypted);
        let imageUrl = blueprint.ipfsImageUrl || blueprint.imageUrl || '';
        
        if (!imageUrl && blueprint.logoBase64) {
          try {
            const imageBuffer = Buffer.from(blueprint.logoBase64, 'base64');
            const ipfsResult = await pumpportal.uploadToIPFS(imageBuffer, {
              name: blueprint.name,
              symbol: blueprint.symbol,
              description: blueprint.description || ''
            });
            imageUrl = ipfsResult.metadata?.image || '';
            console.log('[Deploy/Clanker] Uploaded image to IPFS:', imageUrl);
          } catch (ipfsErr) {
            console.error('[Deploy/Clanker] IPFS upload failed:', ipfsErr.message);
          }
        }
        
        console.log(`[Deploy/Clanker] Deploying ${blueprint.name} ($${blueprint.symbol}) on Base using session wallet...`);
        const deployResult = await clankerSDK.deployToken({
          name: blueprint.name,
          symbol: blueprint.symbol,
          imageUrl: imageUrl,
          privateKey: walletPrivKey
        });
        
        console.log(`[Deploy/Clanker] Deploy tx: ${deployResult.txHash}`);
        console.log(`[Deploy/Clanker] Token address: ${deployResult.contractAddress}`);
        
        if (!deployResult.contractAddress) {
          throw new Error('Clanker deploy succeeded but no contract address returned');
        }
        
        const token = await db.createToken({
          mintAddress: deployResult.contractAddress,
          name: blueprint.name,
          symbol: blueprint.symbol,
          description: blueprint.description || '',
          imageUrl: imageUrl,
          metadataUri: '',
          walletPublicKey: deployResult.deployerAddress || '',
          walletPrivateKeyEncrypted: session.wallet_private_key_encrypted || '',
          status: 'active',
          websiteUrl: blueprint.website || null,
          twitterUrl: blueprint.twitter || null,
          venue: 'clanker'
        });
        
        const narrative = blueprint.narrative || '';
        const themeColors = generateThemeColors(narrative, blueprint.name, blueprint.description);
        const slug = await db.generateUniqueSlug(blueprint.symbol);
        await db.updateTokenLandingData(token.id, narrative, themeColors.primary, themeColors.accent, slug);
        console.log(`[Deploy/Clanker] Landing page ready at /${slug}`);
        
        await db.updateSessionStatus(session.id, 'completed', token.id);
        
        let agentSkill = null;
        try {
          console.log(`[Deploy/Clanker] Generating agent personality for ${token.symbol}...`);
          const skillData = await generateAgentSkill(token, blueprint);
          agentSkill = await db.createAgentSkill(token.id, skillData);
          console.log(`[Deploy/Clanker] Agent personality created: ${agentSkill.archetype}`);
        } catch (agentError) {
          console.error('[Deploy/Clanker] Agent skill generation failed (non-critical):', agentError.message);
        }
        
        return res.json({
          success: true,
          token: {
            id: token.id,
            mintAddress: token.mint_address,
            name: token.name,
            symbol: token.symbol,
            slug: slug,
            clankerUrl: `https://clanker.world/clanker/${token.mint_address}`,
            basescanUrl: `https://basescan.org/token/${token.mint_address}`,
            dexscreenerUrl: `https://dexscreener.com/base/${token.mint_address}`,
            landingPageUrl: `/${slug}`,
            chain: 'base'
          },
          agentSkill: agentSkill ? {
            id: agentSkill.id,
            archetype: agentSkill.archetype,
            voice: agentSkill.voice,
            status: agentSkill.status
          } : null,
          transactionSignature: deployResult.txHash
        });
      } catch (clankerError) {
        console.error('[Deploy/Clanker] Deployment failed:', clankerError);
        await db.updateSessionStatus(session.id, 'deposit_received');
        const remainingBalance = await baseWallet.getBalance(session.deposit_address);
        return res.status(500).json({ 
          success: false, 
          error: clankerError.message,
          recoverable: true,
          remainingBalance,
          message: `Deploy failed but your funds (${remainingBalance.toFixed(6)} ETH) are still in your session wallet. You can retry or request a refund.`
        });
      }
    }
    
    if (venue === 'four.meme') {
      const bnbBalanceWei = await bnbWallet.getBalanceWei(session.deposit_address);
      const requiredWei = bnbWallet.parseEther(String(getRequiredDeposit('four.meme')));
      const bnbBalance = parseFloat(bnbBalanceWei.toString()) / 1e18;
      if (bnbBalanceWei < requiredWei) {
        return res.status(400).json({
          success: false,
          error: 'Insufficient BNB deposit',
          balance: bnbBalance,
          required: getRequiredDeposit('four.meme')
        });
      }
      
      await db.updateSessionStatus(session.id, 'deploying');
      
      try {
        const walletPrivKey = decrypt(session.wallet_private_key_encrypted);
        
        let imageBuffer = null;
        let imageUrl = blueprint.ipfsImageUrl || blueprint.imageUrl || '';
        
        if (blueprint.logoBase64) {
          imageBuffer = Buffer.from(blueprint.logoBase64, 'base64');
        } else if (imageUrl && !imageUrl.startsWith('https://static.four.meme')) {
          try {
            const imgRes = await fetch(imageUrl);
            imageBuffer = Buffer.from(await imgRes.arrayBuffer());
          } catch (imgErr) {
            console.error('[Deploy/FourMeme] Failed to fetch image:', imgErr.message);
          }
        }
        
        console.log(`[Deploy/FourMeme] Deploying ${blueprint.name} ($${blueprint.symbol}) on BNB Chain...`);
        const deployResult = await fourmemeSDK.deployToken({
          name: blueprint.name,
          symbol: blueprint.symbol,
          description: blueprint.description || '',
          imageBuffer,
          imageUrl,
          privateKey: walletPrivKey,
          label: 'Meme',
          webUrl: blueprint.website || '',
          twitterUrl: blueprint.twitter || ''
        });
        
        console.log(`[Deploy/FourMeme] Deploy tx: ${deployResult.txHash}`);
        console.log(`[Deploy/FourMeme] Token address: ${deployResult.contractAddress}`);
        
        if (!deployResult.contractAddress) {
          throw new Error('Four.meme deploy succeeded but no token address returned');
        }
        
        const token = await db.createToken({
          mintAddress: deployResult.contractAddress,
          name: blueprint.name,
          symbol: blueprint.symbol,
          description: blueprint.description || '',
          imageUrl: imageUrl || '',
          metadataUri: '',
          walletPublicKey: deployResult.deployerAddress || session.deposit_address,
          walletPrivateKeyEncrypted: session.wallet_private_key_encrypted || '',
          status: 'active',
          websiteUrl: blueprint.website || null,
          twitterUrl: blueprint.twitter || null,
          venue: 'four.meme'
        });
        
        const narrative = blueprint.narrative || '';
        const themeColors = generateThemeColors(narrative, blueprint.name, blueprint.description);
        const slug = await db.generateUniqueSlug(blueprint.symbol);
        await db.updateTokenLandingData(token.id, narrative, themeColors.primary, themeColors.accent, slug);
        console.log(`[Deploy/FourMeme] Landing page ready at /${slug}`);
        
        await db.updateSessionStatus(session.id, 'completed', token.id);
        
        let agentSkill = null;
        try {
          console.log(`[Deploy/FourMeme] Generating agent personality for ${token.symbol}...`);
          const skillData = await generateAgentSkill(token, blueprint);
          agentSkill = await db.createAgentSkill(token.id, skillData);
          console.log(`[Deploy/FourMeme] Agent personality created: ${agentSkill.archetype}`);
        } catch (agentError) {
          console.error('[Deploy/FourMeme] Agent skill generation failed (non-critical):', agentError.message);
        }
        
        return res.json({
          success: true,
          token: {
            id: token.id,
            mintAddress: token.mint_address,
            name: token.name,
            symbol: token.symbol,
            slug: slug,
            venueUrl: `https://four.meme/token/${token.mint_address}`,
            bscscanUrl: `https://bscscan.com/token/${token.mint_address}`,
            dexscreenerUrl: `https://dexscreener.com/bsc/${token.mint_address}`,
            landingPageUrl: `/${slug}`,
            chain: 'bnb'
          },
          agentSkill: agentSkill ? {
            id: agentSkill.id,
            archetype: agentSkill.archetype,
            voice: agentSkill.voice,
            status: agentSkill.status
          } : null,
          transactionSignature: deployResult.txHash
        });
      } catch (fourMemeError) {
        console.error('[Deploy/FourMeme] Deployment failed:', fourMemeError);
        await db.updateSessionStatus(session.id, 'deposit_received');
        let remainingBalance = 0;
        try { remainingBalance = await bnbWallet.getBalance(session.deposit_address); } catch(e) {}
        return res.status(500).json({ 
          success: false, 
          error: fourMemeError.message,
          recoverable: true,
          remainingBalance,
          message: `Deploy failed but your funds (${remainingBalance.toFixed(4)} BNB) are still in your session wallet. You can retry or request a refund.`
        });
      }
    }
    
    const balance = await solana.getBalance(session.deposit_address);
    const requiredDeposit = getRequiredDeposit(venue);
    if (balance < requiredDeposit) {
      return res.status(400).json({ 
        success: false, 
        error: 'Insufficient deposit',
        balance,
        required: requiredDeposit
      });
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
      
      let signature;
      
      if (venue === 'bags.fm') {
        console.log('[Deploy] Using bags.fm for token creation');
        
        const bagsResult = await bagsSDK.createToken({
          name: blueprint.name,
          symbol: blueprint.symbol,
          description: blueprint.description || '',
          imageUrl: imageUrl,
          keypair: signerKeypair,
          initialBuySol: 0
        });
        
        console.log('[Deploy] bags.fm createToken result:', JSON.stringify(bagsResult));
        signature = bagsResult.signature;
        
        if (bagsResult.mintAddress) {
          mintKeypair = { publicKey: { toBase58: () => bagsResult.mintAddress } };
        }
      } else {
        console.log('[Deploy] Using pump.fun for token creation');
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
        
        signature = await solana.signAndSendTransaction(txBytes, [signerKeypair, mintKeypair]);
      }
      
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
        twitterUrl: blueprint.twitter || null,
        venue: venue
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
      
      const venueUrl = venue === 'bags.fm' 
        ? `https://bags.fm/token/${token.mint_address}` 
        : `https://pump.fun/coin/${token.mint_address}`;
      
      return res.json({
        success: true,
        token: {
          id: token.id,
          mintAddress: token.mint_address,
          name: token.name,
          symbol: token.symbol,
          slug: slug,
          venueUrl: venueUrl,
          pumpfunUrl: venue === 'pump.fun' ? `https://pump.fun/coin/${token.mint_address}` : undefined,
          bagsUrl: venue === 'bags.fm' ? `https://bags.fm/token/${token.mint_address}` : undefined,
          solscanUrl: `https://solscan.io/token/${token.mint_address}`,
          landingPageUrl: `/${slug}`,
          chain: 'solana'
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
      depositAmount: getRequiredDeposit(venue)
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
      tokens: tokens.map(t => {
        const venue = t.venue || 'pump.fun';
        return {
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
          venue: venue,
          chain: getChainForVenue(venue),
          platformUrl: getVenuePlatformUrl(venue, t.mint_address),
          landingPageUrl: t.slug ? `/${t.slug}` : null
        };
      })
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
      tokens: tokens.map(t => {
        const venue = t.venue || 'pump.fun';
        const platformUrl = getVenuePlatformUrl(venue, t.mint_address);
        return {
          id: t.id,
          mintAddress: t.mint_address,
          name: t.name,
          symbol: t.symbol,
          slug: t.slug,
          status: t.status,
          venue: venue,
          chain: getChainForVenue(venue),
          bondingProgress: t.bonding_progress,
          marketCap: t.market_cap,
          createdAt: t.created_at,
          platformUrl: platformUrl,
          landingPageUrl: t.slug ? `/${t.slug}` : null
        };
      })
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
      tokens: tokens.map(t => {
        const venue = t.venue || 'pump.fun';
        const platformUrl = getVenuePlatformUrl(venue, t.mint_address);
        return {
          id: t.id,
          mintAddress: t.mint_address,
          name: t.name,
          symbol: t.symbol,
          slug: t.slug,
          venue: venue,
          pumpswapPool: t.pumpswap_pool,
          marketCap: t.market_cap,
          totalBurned: t.total_burned,
          graduatedAt: t.graduated_at,
          platformUrl: platformUrl,
          landingPageUrl: t.slug ? `/${t.slug}` : null
        };
      })
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
    
    // Build agent section for both unclaimed and claimed states
    let agentSection = '';
    try {
      const agentSkill = await db.getAgentSkillByTokenId(token.id);
      if (agentSkill) {
        const archetypeEmojis = {
          'Philosopher': '🧠', 'Joker': '🃏', 'Engineer': '⚙️', 'Mystic': '🔮',
          'Degen': '🦍', 'Sage': '📚', 'Rebel': '⚡', 'Artist': '🎨',
          'Explorer': '🧭', 'Guardian': '🛡️'
        };
        const emoji = archetypeEmojis[agentSkill.archetype] || '🤖';
        
        // Parse topics and quirks
        let topicsArray = [];
        let quirksArray = [];
        let samplePostsArray = [];
        try {
          topicsArray = typeof agentSkill.topics === 'string' ? JSON.parse(agentSkill.topics) : (agentSkill.topics || []);
          quirksArray = typeof agentSkill.quirks === 'string' ? JSON.parse(agentSkill.quirks) : (agentSkill.quirks || []);
          samplePostsArray = typeof agentSkill.sample_posts === 'string' ? JSON.parse(agentSkill.sample_posts) : (agentSkill.sample_posts || []);
        } catch (e) {}
        
        if (agentSkill.status === 'pending_claim') {
          const topicsHtml = topicsArray.slice(0, 3).map(t => 
            `<span style="background: rgba(255,255,255,0.1); padding: 4px 12px; border-radius: 12px; font-size: 0.8rem;">${escapeHtml(t)}</span>`
          ).join('');
          
          const claimUrl = agentSkill.moltbook_claim_url || '#';
          const verCode = agentSkill.moltbook_verification_code || '';
          const agentNameForTweet = agentSkill.moltbook_username || token.name;
          
          agentSection = `
            <section class="agent-section" style="margin: 40px 0; padding: 28px; background: var(--bg-secondary); border-radius: 20px; border: 1px solid var(--border-color);">
              <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px;">
                <h3 style="display: flex; align-items: center; gap: 10px; font-family: 'Space Grotesk', sans-serif; font-size: 1.3rem;">
                  <span style="font-size: 1.5rem;">🤖</span> Moltbook AI Agent
                </h3>
                <span style="background: rgba(255, 170, 0, 0.2); color: #ffaa00; padding: 4px 10px; border-radius: 8px; font-size: 0.75rem; font-weight: 600;">PENDING CLAIM</span>
              </div>

              <div style="background: rgba(0, 255, 136, 0.08); border: 1px solid rgba(0, 255, 136, 0.2); border-radius: 12px; padding: 16px; margin-bottom: 20px;">
                <p style="color: var(--success); font-weight: 600; margin-bottom: 8px;">Agent registered on Moltbook!</p>
                <p style="color: var(--text-secondary); font-size: 0.85rem;">Complete the steps below to finish claiming your agent.</p>
              </div>

              <div style="margin-bottom: 20px;">
                <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
                  <span style="background: var(--success); color: #0a0a0f; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.85rem;">1</span>
                  <span style="font-weight: 600;">Tweet this verification:</span>
                </div>
                <div style="background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 10px; padding: 14px; font-family: 'JetBrains Mono', monospace; font-size: 0.85rem; color: var(--text-primary); line-height: 1.5;">
                  I'm claiming my AI agent "${escapeHtml(agentNameForTweet)}" on @moltbook<br>Verification: ${escapeHtml(verCode)}
                </div>
              </div>

              <div style="margin-bottom: 20px;">
                <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
                  <span style="background: var(--success); color: #0a0a0f; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.85rem;">2</span>
                  <span style="font-weight: 600;">Complete claim on Moltbook:</span>
                </div>
              </div>

              <div style="display: flex; gap: 12px; flex-wrap: wrap;">
                <a href="${escapeHtml(claimUrl)}" target="_blank" style="display: inline-flex; align-items: center; gap: 8px; padding: 14px 28px; background: linear-gradient(135deg, var(--success), #00cc6a); color: #0a0a0f; border: none; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 1rem;">
                  Open Moltbook Claim Page
                </a>
                <button onclick="checkClaimStatus(${agentSkill.id})" id="checkClaimBtn" style="display: inline-flex; align-items: center; gap: 8px; padding: 14px 20px; background: transparent; color: var(--text-secondary); border: 1px solid var(--border-color); border-radius: 12px; cursor: pointer; font-size: 0.9rem;">
                  I've completed claim ✓
                </button>
              </div>
            </section>
          `;
        } else if (agentSkill.status === 'unclaimed') {
          // UNCLAIMED STATE - Show claim CTA
          const topicsHtml = topicsArray.slice(0, 3).map(t => 
            `<span style="background: rgba(255,255,255,0.1); padding: 4px 12px; border-radius: 12px; font-size: 0.8rem;">${escapeHtml(t)}</span>`
          ).join('');
          
          agentSection = `
            <section class="agent-section" style="margin: 40px 0; padding: 28px; background: var(--bg-secondary); border-radius: 20px; border: 1px solid var(--border-color);">
              <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px;">
                <h3 style="display: flex; align-items: center; gap: 10px; font-family: 'Space Grotesk', sans-serif; font-size: 1.3rem;">
                  <span style="font-size: 1.5rem;">🤖</span> Moltbook AI Agent
                </h3>
                <span style="background: rgba(255, 170, 0, 0.2); color: #ffaa00; padding: 4px 10px; border-radius: 8px; font-size: 0.75rem; font-weight: 600;">UNCLAIMED</span>
              </div>
              
              <div style="display: flex; gap: 20px; margin-bottom: 20px; flex-wrap: wrap;">
                <div style="flex: 0 0 80px;">
                  <div style="width: 80px; height: 80px; background: linear-gradient(135deg, var(--theme-primary), var(--theme-accent)); border-radius: 16px; display: flex; align-items: center; justify-content: center; font-size: 2.5rem;">
                    ${emoji}
                  </div>
                </div>
                <div style="flex: 1; min-width: 200px;">
                  <div style="margin-bottom: 8px;">
                    <span style="background: linear-gradient(135deg, var(--theme-primary), var(--theme-accent)); padding: 4px 14px; border-radius: 12px; font-size: 0.85rem; font-weight: 600;">
                      ${escapeHtml(agentSkill.archetype)}
                    </span>
                  </div>
                  <p style="color: var(--text-secondary); font-size: 0.9rem; line-height: 1.6; margin-bottom: 12px;">
                    ${escapeHtml((agentSkill.voice || '').substring(0, 150))}${(agentSkill.voice || '').length > 150 ? '...' : ''}
                  </p>
                  <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                    ${topicsHtml}
                  </div>
                </div>
              </div>
              
              <div style="background: var(--bg-primary); border-radius: 12px; padding: 20px; margin-bottom: 20px;">
                <p style="color: var(--text-secondary); font-size: 0.9rem; margin-bottom: 12px;">
                  🦞 This token has an AI agent ready to join <strong style="color: var(--success);">Moltbook</strong> - the social network for AI agents with 1.5M+ bots!
                </p>
                <p style="color: var(--text-secondary); font-size: 0.85rem;">
                  Click below to register your agent on Moltbook. We'll set everything up — you just verify with a tweet.
                </p>
              </div>
              
              <div style="display: flex; gap: 12px; flex-wrap: wrap;">
                <button onclick="openClaimModal(${agentSkill.id})" style="display: inline-flex; align-items: center; gap: 8px; padding: 14px 28px; background: linear-gradient(135deg, var(--success), #00cc6a); color: #0a0a0f; border: none; border-radius: 12px; cursor: pointer; font-weight: 700; font-size: 1rem; transition: all 0.3s;">
                  🦞 Claim Your Agent
                </button>
                <a href="/api/agents/${agentSkill.id}/export-personality" download style="display: inline-flex; align-items: center; gap: 8px; padding: 14px 20px; background: transparent; color: var(--text-secondary); border: 1px solid var(--border-color); border-radius: 12px; text-decoration: none; font-size: 0.9rem; cursor: pointer;">
                  Download Personality File
                </a>
              </div>
            </section>
            
            <div id="claimModal" style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.85); z-index: 1000; align-items: center; justify-content: center; backdrop-filter: blur(4px);">
              <div style="background: var(--bg-secondary); border-radius: 20px; padding: 28px; max-width: 480px; width: 92%; border: 1px solid var(--border-color); position: relative; max-height: 90vh; overflow-y: auto;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                  <h3 style="font-family: 'Space Grotesk', sans-serif; font-size: 1.15rem;">🦞 Claim Your Agent</h3>
                  <button onclick="closeClaimModal()" style="background: none; border: none; color: var(--text-secondary); font-size: 1.5rem; cursor: pointer; line-height: 1;">&times;</button>
                </div>

                <div style="display: flex; align-items: center; gap: 2px; margin-bottom: 24px;">
                  <div id="prog1" style="flex: 1; height: 3px; background: var(--success); border-radius: 3px; transition: background 0.3s;"></div>
                  <div id="prog2" style="flex: 1; height: 3px; background: var(--border-color); border-radius: 3px; transition: background 0.3s;"></div>
                  <div id="prog3" style="flex: 1; height: 3px; background: var(--border-color); border-radius: 3px; transition: background 0.3s;"></div>
                  <div id="prog4" style="flex: 1; height: 3px; background: var(--border-color); border-radius: 3px; transition: background 0.3s;"></div>
                </div>

                <!-- STEP 1: Confirm registration -->
                <div id="claimStep1">
                  <div style="text-align: center; margin-bottom: 24px;">
                    <div style="font-size: 3.5rem; margin-bottom: 10px;">🦞</div>
                    <p style="color: var(--text-secondary); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 8px;">Step 1 of 4</p>
                    <h4 style="font-family: 'Space Grotesk', sans-serif; font-size: 1.3rem; margin-bottom: 10px;">Register on Moltbook</h4>
                  </div>

                  <div style="background: var(--bg-primary); border-radius: 12px; padding: 20px; margin-bottom: 14px;">
                    <p style="color: var(--text-primary); font-size: 0.95rem; line-height: 1.6; margin: 0;">
                      We'll register your agent on <strong style="color: var(--success);">Moltbook</strong>, the social network for AI agents. Your agent's personality and archetype are already set up — just click below to go live!
                    </p>
                  </div>

                  <div style="background: rgba(255, 170, 0, 0.06); border: 1px solid rgba(255, 170, 0, 0.15); border-radius: 10px; padding: 10px 14px; margin-bottom: 24px;">
                    <p style="color: var(--text-secondary); font-size: 0.78rem; margin: 0;">After registration, you'll verify ownership by posting a tweet. No terminal or downloads needed.</p>
                  </div>

                  <button onclick="submitClaim()" id="claimSubmitBtn" style="width: 100%; padding: 15px; background: linear-gradient(135deg, var(--success), #00cc6a); color: #0a0a0f; border: none; border-radius: 12px; cursor: pointer; font-weight: 700; font-size: 1rem;">
                    🦞 Register My Agent on Moltbook
                  </button>
                </div>

                <!-- STEP 2: Loading - Registering agent -->
                <div id="claimStep2" style="display: none;">
                  <div style="text-align: center; padding: 20px 0;">
                    <style>
                      @keyframes clawSpin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                      @keyframes clawPulse { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.15); opacity: 0.8; } }
                      @keyframes dotBounce { 0%, 80%, 100% { transform: translateY(0); } 40% { transform: translateY(-8px); } }
                    </style>
                    <div style="position: relative; width: 100px; height: 100px; margin: 0 auto 24px;">
                      <div style="position: absolute; inset: 0; border: 3px solid var(--border-color); border-top-color: var(--success); border-radius: 50%; animation: clawSpin 1s linear infinite;"></div>
                      <div style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 2.8rem; animation: clawPulse 1.5s ease-in-out infinite;">🦞</div>
                    </div>
                    <h4 style="font-family: 'Space Grotesk', sans-serif; font-size: 1.3rem; margin-bottom: 12px;">Registering Your Agent</h4>
                    <p style="color: var(--text-secondary); font-size: 0.9rem; line-height: 1.5; margin-bottom: 16px;">
                      Connecting to Moltbook and setting up your agent. This takes a few seconds.
                    </p>
                    <div style="display: flex; justify-content: center; gap: 6px;">
                      <span style="width: 8px; height: 8px; background: var(--success); border-radius: 50%; display: inline-block; animation: dotBounce 1.2s infinite ease-in-out;"></span>
                      <span style="width: 8px; height: 8px; background: var(--success); border-radius: 50%; display: inline-block; animation: dotBounce 1.2s infinite ease-in-out 0.2s;"></span>
                      <span style="width: 8px; height: 8px; background: var(--success); border-radius: 50%; display: inline-block; animation: dotBounce 1.2s infinite ease-in-out 0.4s;"></span>
                    </div>
                    <p id="claimErrorMsg" style="display: none; color: #ff4444; font-size: 0.85rem; margin-top: 16px; background: rgba(255, 68, 68, 0.08); border: 1px solid rgba(255, 68, 68, 0.2); border-radius: 10px; padding: 12px;"></p>
                    <button id="claimRetryBtn" onclick="goToStep(1)" style="display: none; margin-top: 12px; padding: 12px 24px; background: transparent; color: var(--text-secondary); border: 1px solid var(--border-color); border-radius: 10px; cursor: pointer; font-size: 0.85rem;">← Try again</button>
                  </div>
                </div>

                <!-- STEP 3: Copy tweet + post on X -->
                <div id="claimStep3" style="display: none;">
                  <div style="text-align: center; margin-bottom: 24px;">
                    <div style="font-size: 3.5rem; margin-bottom: 10px;">✅</div>
                    <p style="color: var(--text-secondary); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 8px;">Step 2 of 4</p>
                    <h4 style="font-family: 'Space Grotesk', sans-serif; font-size: 1.3rem; margin-bottom: 10px; color: var(--success);">Agent Registered!</h4>
                    <p style="color: var(--text-secondary); font-size: 0.9rem;">Now verify ownership by posting a tweet. Copy and post this:</p>
                  </div>

                  <div style="background: var(--bg-primary); border-radius: 12px; padding: 20px; margin-bottom: 14px;">
                    <div style="background: #08080e; border: 1px solid var(--border-color); border-radius: 10px; padding: 14px; font-family: 'JetBrains Mono', monospace; font-size: 0.82rem; color: var(--text-primary); line-height: 1.6; margin-bottom: 12px;">
                      <span id="tweetTemplate"></span>
                    </div>
                    <button onclick="copyTweet()" id="copyTweetBtn" style="width: 100%; padding: 14px; background: rgba(29, 161, 242, 0.1); color: #1DA1F2; border: 1px solid rgba(29, 161, 242, 0.3); border-radius: 10px; cursor: pointer; font-weight: 700; font-size: 0.95rem; margin-bottom: 10px;">
                      📋 Copy Tweet Text
                    </button>
                    <a href="https://x.com/compose/post" target="_blank" style="display: block; text-align: center; padding: 14px; background: rgba(29, 161, 242, 0.1); color: #1DA1F2; border: 1px solid rgba(29, 161, 242, 0.3); border-radius: 10px; text-decoration: none; font-weight: 700; font-size: 0.95rem;">
                      𝕏 Open X to Post
                    </a>
                  </div>

                  <div style="background: rgba(255, 170, 0, 0.06); border: 1px solid rgba(255, 170, 0, 0.15); border-radius: 10px; padding: 10px 14px; margin-bottom: 24px;">
                    <p style="color: var(--text-secondary); font-size: 0.78rem; margin: 0;">Copy the text, post it on X, then come back and click Next.</p>
                  </div>

                  <button onclick="goToStep(4)" style="width: 100%; padding: 15px; background: linear-gradient(135deg, var(--success), #00cc6a); color: #0a0a0f; border: none; border-radius: 12px; cursor: pointer; font-weight: 700; font-size: 1rem;">
                    I posted it → Next
                  </button>
                </div>

                <!-- STEP 4: Open Moltbook claim page -->
                <div id="claimStep4" style="display: none;">
                  <div style="text-align: center; margin-bottom: 24px;">
                    <div style="font-size: 3.5rem; margin-bottom: 10px;">🎉</div>
                    <p style="color: var(--text-secondary); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 8px;">Step 4 of 4</p>
                    <h4 style="font-family: 'Space Grotesk', sans-serif; font-size: 1.3rem; margin-bottom: 10px; color: var(--success);">Finish on Moltbook</h4>
                    <p style="color: var(--text-secondary); font-size: 0.9rem;">Open Moltbook's claim page and paste the link to your tweet.</p>
                  </div>

                  <div style="background: var(--bg-primary); border-radius: 12px; padding: 20px; margin-bottom: 14px;">
                    <p style="color: var(--text-primary); font-size: 0.9rem; margin-bottom: 14px;">Click below to open the Moltbook claim page:</p>
                    <a id="claimUrlLink" href="#" target="_blank" style="display: block; text-align: center; padding: 14px; background: linear-gradient(135deg, #1DA1F2, #0d8bd9); color: white; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 0.95rem;">
                      🔗 Open Moltbook Claim Page
                    </a>
                  </div>

                  <div style="background: rgba(255, 170, 0, 0.06); border: 1px solid rgba(255, 170, 0, 0.15); border-radius: 10px; padding: 10px 14px; margin-bottom: 24px;">
                    <p style="color: var(--text-secondary); font-size: 0.78rem; margin: 0;">On the Moltbook page, paste your tweet link and click verify. Once done, come back here.</p>
                  </div>

                  <button onclick="closeClaimModal(); window.location.reload();" style="width: 100%; padding: 15px; background: linear-gradient(135deg, var(--success), #00cc6a); color: #0a0a0f; border: none; border-radius: 12px; cursor: pointer; font-weight: 700; font-size: 1rem;">
                    ✅ Done — I've claimed my agent
                  </button>
                </div>
              </div>
            </div>
          `;
        } else {
          // CLAIMED STATE - Show full details
          const moltbookUrl = agentSkill.moltbook_username 
            ? `https://www.moltbook.com/u/${escapeHtml(agentSkill.moltbook_username)}`
            : '#';
          
          const topicsHtml = topicsArray.map(t => 
            `<span style="background: rgba(255,255,255,0.1); padding: 4px 12px; border-radius: 12px; font-size: 0.8rem;">${escapeHtml(t)}</span>`
          ).join('');
          
          const quirksHtml = quirksArray.map(q => 
            `<li style="color: var(--text-secondary); font-size: 0.9rem; margin-bottom: 6px;">${escapeHtml(q)}</li>`
          ).join('');
          
          const samplePost = samplePostsArray[0] || '';
          
          agentSection = `
            <section class="agent-section" style="margin: 40px 0; padding: 28px; background: var(--bg-secondary); border-radius: 20px; border: 1px solid var(--border-color);">
              <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px;">
                <h3 style="display: flex; align-items: center; gap: 10px; font-family: 'Space Grotesk', sans-serif; font-size: 1.3rem;">
                  <span style="font-size: 1.5rem;">🤖</span> Moltbook AI Agent
                </h3>
                ${agentSkill.moltbook_username ? `<span style="color: var(--success); font-family: 'JetBrains Mono', monospace; font-size: 0.9rem;">@${escapeHtml(agentSkill.moltbook_username)}</span>` : ''}
              </div>
              
              <div style="display: flex; gap: 20px; margin-bottom: 20px; flex-wrap: wrap;">
                <div style="flex: 0 0 80px;">
                  <div style="width: 80px; height: 80px; background: linear-gradient(135deg, var(--theme-primary), var(--theme-accent)); border-radius: 16px; display: flex; align-items: center; justify-content: center; font-size: 2.5rem;">
                    ${emoji}
                  </div>
                </div>
                <div style="flex: 1; min-width: 200px;">
                  <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 8px;">
                    <span style="background: linear-gradient(135deg, var(--theme-primary), var(--theme-accent)); padding: 4px 14px; border-radius: 12px; font-size: 0.85rem; font-weight: 600;">
                      ${escapeHtml(agentSkill.archetype)}
                    </span>
                    <span style="color: var(--text-secondary); font-size: 0.85rem;">⭐ ${agentSkill.karma || 0} karma</span>
                    <span style="color: var(--text-secondary); font-size: 0.85rem;">📝 ${agentSkill.posts_count || 0} posts</span>
                  </div>
                  <p style="color: var(--text-secondary); font-size: 0.9rem; line-height: 1.6;">
                    ${escapeHtml(agentSkill.voice || '')}
                  </p>
                </div>
              </div>
              
              ${topicsArray.length > 0 ? `
                <div style="margin-bottom: 16px;">
                  <div style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 8px;">Topics:</div>
                  <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                    ${topicsHtml}
                  </div>
                </div>
              ` : ''}
              
              ${quirksArray.length > 0 ? `
                <div style="margin-bottom: 16px;">
                  <div style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 8px;">Quirks:</div>
                  <ul style="list-style: none; padding-left: 0;">
                    ${quirksHtml}
                  </ul>
                </div>
              ` : ''}
              
              ${samplePost ? `
                <div style="background: var(--bg-primary); border-radius: 12px; padding: 16px; margin-bottom: 20px; border-left: 3px solid var(--theme-primary);">
                  <div style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 8px;">Sample Post:</div>
                  <p style="color: var(--text-primary); font-size: 0.95rem; line-height: 1.6; font-style: italic;">
                    "${escapeHtml(samplePost)}"
                  </p>
                </div>
              ` : ''}
              
              <div style="display: flex; gap: 12px; flex-wrap: wrap;">
                ${agentSkill.moltbook_username ? `
                  <a href="${moltbookUrl}" target="_blank" style="display: inline-flex; align-items: center; gap: 8px; padding: 12px 24px; background: linear-gradient(135deg, var(--success), #00cc6a); color: #0a0a0f; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 0.9rem;">
                    🌐 View on Moltbook
                  </a>
                ` : ''}
              </div>

              {{POST_HISTORY}}
            </section>
          `;

          // Build post history
          try {
            const posts = await db.getAgentPosts(agentSkill.id, 20);
            if (posts.length > 0) {
              const postsHtml = posts.map(p => {
                const date = p.posted_at ? new Date(p.posted_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 
                             new Date(p.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                const statusColor = p.status === 'posted' ? '#00ff88' : p.status === 'suggested' ? '#ffaa00' : '#8888aa';
                const statusLabel = p.status === 'posted' ? 'POSTED' : p.status === 'suggested' ? 'DRAFT' : p.status.toUpperCase();
                const moltbookLink = p.moltbook_post_url ? `<a href="${escapeHtml(p.moltbook_post_url)}" target="_blank" style="color: var(--success); text-decoration: none; font-size: 0.75rem; margin-left: 8px;">View ↗</a>` : '';
                return `
                  <div style="padding: 16px; background: var(--bg-primary); border-radius: 12px; border: 1px solid var(--border-color);">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                      <span style="font-size: 0.75rem; color: var(--text-secondary);">${date}</span>
                      <span style="font-size: 0.7rem; padding: 2px 8px; border-radius: 6px; background: ${statusColor}15; color: ${statusColor}; font-weight: 600;">${statusLabel}${moltbookLink}</span>
                    </div>
                    <p style="color: var(--text-primary); font-size: 0.9rem; line-height: 1.5;">${escapeHtml(p.content)}</p>
                  </div>`;
              }).join('');

              const postHistoryHtml = `
                <div style="margin-top: 24px; border-top: 1px solid var(--border-color); padding-top: 20px;">
                  <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
                    <h4 style="font-family: 'Space Grotesk', sans-serif; font-size: 1.1rem; display: flex; align-items: center; gap: 8px;">
                      📝 Post History
                    </h4>
                    <span style="color: var(--text-secondary); font-size: 0.85rem;">${posts.length} post${posts.length !== 1 ? 's' : ''}</span>
                  </div>
                  <div style="display: flex; flex-direction: column; gap: 12px; max-height: 600px; overflow-y: auto;">
                    ${postsHtml}
                  </div>
                </div>`;
              agentSection = agentSection.replace('{{POST_HISTORY}}', postHistoryHtml);
            } else {
              agentSection = agentSection.replace('{{POST_HISTORY}}', `
                <div style="margin-top: 24px; border-top: 1px solid var(--border-color); padding-top: 20px;">
                  <h4 style="font-family: 'Space Grotesk', sans-serif; font-size: 1.1rem; display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
                    📝 Post History
                  </h4>
                  <p style="color: var(--text-secondary); font-size: 0.9rem; text-align: center; padding: 24px 0;">No posts yet. Auto-posting will begin shortly.</p>
                </div>`);
            }
          } catch (postErr) {
            console.error('Error fetching posts for token page:', postErr.message);
            agentSection = agentSection.replace('{{POST_HISTORY}}', '');
          }
        }
      }
    } catch (agentErr) {
      console.error('Error fetching agent for token page:', agentErr.message);
    }
    
    let identity8004Section = '';
    try {
      const agentSkillForIdentity = await db.getAgentSkillByTokenId(token.id);
      if (agentSkillForIdentity) {
        const identity = await db.getAgentIdentityByTokenId(token.id);
        
        if (identity && identity.status === 'registered') {
          const scanLink = identity.scan_url || erc8004.getScanUrl(identity.agent_nft_id);
          const explorerLink = identity.tx_hash ? erc8004.getExplorerTxUrl(identity.tx_hash) : null;
          identity8004Section = `
            <section style="margin: 24px 0; padding: 24px; background: linear-gradient(135deg, rgba(0, 82, 255, 0.08), rgba(0, 82, 255, 0.03)); border-radius: 20px; border: 1px solid rgba(0, 82, 255, 0.2);">
              <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 16px;">
                <span style="font-size: 1.3rem;">🛡️</span>
                <h4 style="font-family: 'Space Grotesk', sans-serif; font-size: 1.1rem; margin: 0;">ERC-8004 Verified Agent</h4>
                <span style="background: rgba(0, 255, 136, 0.15); color: #00ff88; padding: 3px 10px; border-radius: 8px; font-size: 0.75rem; font-weight: 600;">Verified</span>
                <span style="background: rgba(0, 82, 255, 0.2); color: #5b9bff; padding: 3px 10px; border-radius: 8px; font-size: 0.75rem; font-weight: 600;">Base</span>
              </div>
              <p style="color: var(--text-secondary); font-size: 0.9rem; margin-bottom: 16px; line-height: 1.5;">
                This agent is registered on the ERC-8004 Identity Registry on Base, providing on-chain verified identity and trust for AI agents.
              </p>
              <div style="display: flex; gap: 12px; flex-wrap: wrap; align-items: center;">
                ${identity.agent_nft_id ? `<span style="font-family: 'JetBrains Mono', monospace; font-size: 0.85rem; color: var(--text-secondary); background: var(--bg-primary); padding: 6px 12px; border-radius: 8px;">Agent #${escapeHtml(identity.agent_nft_id)}</span>` : ''}
                ${scanLink ? `<a href="${escapeHtml(scanLink)}" target="_blank" style="display: inline-flex; align-items: center; gap: 6px; padding: 10px 20px; background: rgba(0, 82, 255, 0.15); color: #5b9bff; border-radius: 10px; text-decoration: none; font-size: 0.85rem; font-weight: 600; border: 1px solid rgba(0, 82, 255, 0.25); transition: all 0.2s;">🔍 View on 8004scan</a>` : ''}
                ${explorerLink ? `<a href="${escapeHtml(explorerLink)}" target="_blank" style="display: inline-flex; align-items: center; gap: 6px; padding: 10px 16px; background: var(--bg-primary); color: var(--text-secondary); border-radius: 10px; text-decoration: none; font-size: 0.85rem; border: 1px solid var(--border-color);">BaseScan ↗</a>` : ''}
              </div>
            </section>
          `;
        } else if (identity && (identity.status === 'pending' || identity.status === 'metadata_ready')) {
          identity8004Section = `
            <section style="margin: 24px 0; padding: 24px; background: linear-gradient(135deg, rgba(0, 82, 255, 0.06), rgba(0, 82, 255, 0.02)); border-radius: 20px; border: 1px solid rgba(0, 82, 255, 0.15);">
              <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 16px;">
                <span style="font-size: 1.3rem;">🛡️</span>
                <h4 style="font-family: 'Space Grotesk', sans-serif; font-size: 1.1rem; margin: 0;">ERC-8004 On-Chain Identity</h4>
                <span style="background: rgba(255, 170, 0, 0.15); color: #ffaa00; padding: 3px 10px; border-radius: 8px; font-size: 0.75rem; font-weight: 600;">Pending</span>
                <span style="background: rgba(0, 82, 255, 0.2); color: #5b9bff; padding: 3px 10px; border-radius: 8px; font-size: 0.75rem; font-weight: 600;">Base</span>
              </div>
              <p style="color: var(--text-secondary); font-size: 0.9rem; line-height: 1.5;">
                Registration in progress. Your agent's metadata has been prepared and is awaiting on-chain registration on Base.
              </p>
            </section>
          `;
        } else if (identity && identity.status === 'failed') {
          identity8004Section = `
            <section style="margin: 24px 0; padding: 24px; background: linear-gradient(135deg, rgba(255, 68, 68, 0.06), rgba(255, 68, 68, 0.02)); border-radius: 20px; border: 1px solid rgba(255, 68, 68, 0.15);">
              <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 16px;">
                <span style="font-size: 1.3rem;">🛡️</span>
                <h4 style="font-family: 'Space Grotesk', sans-serif; font-size: 1.1rem; margin: 0;">ERC-8004 On-Chain Identity</h4>
                <span style="background: rgba(255, 68, 68, 0.15); color: #ff4444; padding: 3px 10px; border-radius: 8px; font-size: 0.75rem; font-weight: 600;">Failed</span>
                <span style="background: rgba(0, 82, 255, 0.2); color: #5b9bff; padding: 3px 10px; border-radius: 8px; font-size: 0.75rem; font-weight: 600;">Base</span>
              </div>
              <p style="color: var(--text-secondary); font-size: 0.9rem; margin-bottom: 16px; line-height: 1.5;">
                Previous registration attempt failed. You can retry the on-chain registration.
              </p>
              <button onclick="register8004(${token.id})" id="register8004Btn" style="display: inline-flex; align-items: center; gap: 8px; padding: 12px 24px; background: linear-gradient(135deg, #0052FF, #3b82f6); color: white; border: none; border-radius: 12px; cursor: pointer; font-weight: 600; font-size: 0.9rem; transition: all 0.2s;">
                🔄 Retry Registration
              </button>
            </section>
          `;
        } else {
          identity8004Section = `
            <section style="margin: 24px 0; padding: 24px; background: var(--bg-secondary); border-radius: 20px; border: 1px solid var(--border-color);">
              <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 16px;">
                <span style="font-size: 1.3rem;">🛡️</span>
                <h4 style="font-family: 'Space Grotesk', sans-serif; font-size: 1.1rem; margin: 0;">ERC-8004 On-Chain Identity</h4>
                <span style="background: rgba(0, 82, 255, 0.2); color: #5b9bff; padding: 3px 10px; border-radius: 8px; font-size: 0.75rem; font-weight: 600;">Base</span>
              </div>
              <p style="color: var(--text-secondary); font-size: 0.9rem; margin-bottom: 16px; line-height: 1.5;">
                Register this agent on the <strong style="color: var(--text-primary);">ERC-8004 Identity Registry</strong> on Base for on-chain verified identity. Your agent will appear on <a href="https://www.8004scan.io" target="_blank" style="color: #5b9bff; text-decoration: none;">8004scan.io</a> and gain trust in the AI agent ecosystem.
              </p>
              <div style="display: flex; gap: 12px; flex-wrap: wrap; align-items: center;">
                <button onclick="register8004(${token.id})" id="register8004Btn" style="display: inline-flex; align-items: center; gap: 8px; padding: 12px 24px; background: linear-gradient(135deg, #0052FF, #3b82f6); color: white; border: none; border-radius: 12px; cursor: pointer; font-weight: 600; font-size: 0.9rem; transition: all 0.2s;">
                  🛡️ Register on ERC-8004
                </button>
                <a href="https://www.8004scan.io" target="_blank" style="display: inline-flex; align-items: center; gap: 6px; padding: 12px 20px; background: var(--bg-tertiary); color: var(--text-secondary); border: 1px solid var(--border-color); border-radius: 12px; text-decoration: none; font-size: 0.85rem; transition: all 0.2s;">
                  Learn about ERC-8004 →
                </a>
              </div>
            </section>
          `;
        }
      }
    } catch (err8004) {
      console.error('Error fetching 8004 identity for token page:', err8004.message);
    }

    const venue = token.venue || 'pump.fun';
    const chainMap = {
      'pump.fun': { name: 'Solana', color: '#9945FF', bg: 'rgba(153, 69, 255, 0.15)' },
      'bags.fm': { name: 'Solana', color: '#9945FF', bg: 'rgba(153, 69, 255, 0.15)' },
      'clanker': { name: 'Base', color: '#0052FF', bg: 'rgba(0, 82, 255, 0.15)' },
      'four.meme': { name: 'BNB Chain', color: '#F0B90B', bg: 'rgba(240, 185, 11, 0.15)' }
    };
    const chainInfo = chainMap[venue] || chainMap['pump.fun'];

    let buyButtonHtml;
    let chartButtonHtml;
    
    switch (venue) {
      case 'bags.fm':
        buyButtonHtml = `<a href="https://bags.fm/token/${escapeHtml(token.mint_address)}" target="_blank" class="btn btn-primary">Buy on bags.fm</a>`;
        chartButtonHtml = `<a href="https://dexscreener.com/solana/${escapeHtml(token.mint_address)}" target="_blank" class="btn btn-secondary">View Chart</a>`;
        break;
      case 'clanker':
        buyButtonHtml = `<a href="https://clanker.world/clanker/${escapeHtml(token.mint_address)}" target="_blank" class="btn btn-primary">Buy on Clanker</a>`;
        chartButtonHtml = `<a href="https://dexscreener.com/base/${escapeHtml(token.mint_address)}" target="_blank" class="btn btn-secondary">View Chart</a>`;
        break;
      case 'four.meme':
        buyButtonHtml = `<a href="https://four.meme/token/${escapeHtml(token.mint_address)}" target="_blank" class="btn btn-primary">Buy on Four.meme</a>`;
        chartButtonHtml = `<a href="https://dexscreener.com/bsc/${escapeHtml(token.mint_address)}" target="_blank" class="btn btn-secondary">View Chart</a>`;
        break;
      default:
        buyButtonHtml = `<a href="https://pump.fun/coin/${escapeHtml(token.mint_address)}" target="_blank" class="btn btn-primary">Buy on pump.fun</a>`;
        chartButtonHtml = `<a href="https://dexscreener.com/solana/${escapeHtml(token.mint_address)}" target="_blank" class="btn btn-secondary">View Chart</a>`;
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
      .replace(/\{\{AGENT_SECTION\}\}/g, agentSection)
      .replace(/\{\{IDENTITY_8004_SECTION\}\}/g, identity8004Section)
      .replace(/\{\{BUY_BUTTON\}\}/g, buyButtonHtml)
      .replace(/\{\{CHART_BUTTON\}\}/g, chartButtonHtml)
      .replace(/\{\{CHAIN_NAME\}\}/g, chainInfo.name)
      .replace(/\{\{CHAIN_COLOR\}\}/g, chainInfo.color)
      .replace(/\{\{CHAIN_BG\}\}/g, chainInfo.bg)
      .replace(/\{\{VENUE_NAME\}\}/g, venue);
    
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

app.get('/api/agents/:id/export-personality', async (req, res) => {
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
    const rawName = token ? `${token.name}Agent` : `Agent${skillId}`;
    const agentName = rawName.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').substring(0, 32);

    let topicsArray = [];
    let quirksArray = [];
    let samplePostsArray = [];
    try {
      topicsArray = typeof skill.topics === 'string' ? JSON.parse(skill.topics) : (skill.topics || []);
      quirksArray = typeof skill.quirks === 'string' ? JSON.parse(skill.quirks) : (skill.quirks || []);
      samplePostsArray = typeof skill.sample_posts === 'string' ? JSON.parse(skill.sample_posts) : (skill.sample_posts || []);
    } catch (e) {}

    const personality = {
      name: agentName,
      archetype: skill.archetype,
      voice: skill.voice,
      topics: topicsArray,
      quirks: quirksArray,
      samplePosts: samplePostsArray,
      introPost: skill.intro_post,
      token: token ? {
        name: token.name,
        symbol: token.symbol,
        description: token.description
      } : null,
      instructions: 'Load this personality file into OpenClaw to register your agent on Moltbook. Run OpenClaw on your terminal, import this config, and your agent will register itself autonomously.'
    };

    res.setHeader('Content-Disposition', `attachment; filename="${agentName}-personality.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.json(personality);
  } catch (error) {
    console.error('Error exporting personality:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/agents/:id/claim', async (req, res) => {
  try {
    const skillId = parseInt(req.params.id, 10);
    if (isNaN(skillId)) {
      return res.status(400).json({ success: false, error: 'Invalid skill ID' });
    }

    const skill = await db.getAgentSkill(skillId);
    if (!skill) {
      return res.status(404).json({ success: false, error: 'Agent skill not found' });
    }
    if (skill.status === 'claimed') {
      return res.status(400).json({ success: false, error: 'Agent already claimed' });
    }

    const token = await db.getToken(skill.token_id);
    const rawName = token ? `${token.name}Agent` : `Agent${skillId}`;
    const agentName = rawName.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').substring(0, 32);
    const agentDescription = skill.voice || `${skill.archetype} archetype AI agent`;

    console.log(`[Moltbook] Registering agent "${agentName}" via direct API...`);

    const registerRes = await fetch('https://www.moltbook.com/api/v1/agents/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: agentName, description: agentDescription })
    });

    const registerData = await registerRes.json();

    if (!registerRes.ok || !registerData.agent) {
      console.error('[Moltbook] Registration failed:', registerData);
      return res.status(400).json({
        success: false,
        error: registerData.error || registerData.message || 'Moltbook registration failed. Please try again.'
      });
    }

    const { api_key, claim_url, verification_code } = registerData.agent;
    const moltbookAgentName = registerData.agent.name || agentName;

    console.log(`[Moltbook] Registered! Agent: ${moltbookAgentName}, Claim URL: ${claim_url}`);

    const encryptedApiKey = api_key ? encrypt(api_key) : null;
    await db.updateAgentSkillPendingClaim(skillId, encryptedApiKey, moltbookAgentName, claim_url, verification_code);

    res.json({
      success: true,
      status: 'pending_claim',
      claimUrl: claim_url,
      verificationCode: verification_code,
      agentName: moltbookAgentName,
      message: 'Agent registered on Moltbook! Tweet the verification code to complete your claim.'
    });
  } catch (error) {
    console.error('Error claiming agent:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/agents/:id/confirm-claim', async (req, res) => {
  try {
    const skillId = parseInt(req.params.id, 10);
    if (isNaN(skillId)) {
      return res.status(400).json({ success: false, error: 'Invalid skill ID' });
    }

    const skill = await db.getAgentSkill(skillId);
    if (!skill) {
      return res.status(404).json({ success: false, error: 'Agent skill not found' });
    }
    if (skill.status !== 'pending_claim') {
      return res.json({ success: true, status: skill.status });
    }

    const apiKey = decrypt(skill.moltbook_api_key_encrypted);
    const statusRes = await fetch('https://www.moltbook.com/api/v1/agents/status', {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });

    const statusData = await statusRes.json();

    if (statusData.status === 'claimed') {
      await db.confirmAgentSkillClaim(skillId);
      console.log(`[Moltbook] Agent ${skillId} claim confirmed!`);
      res.json({ success: true, status: 'claimed' });
    } else {
      res.json({ success: true, status: 'pending_claim', moltbookStatus: statusData.status });
    }
  } catch (error) {
    console.error('Error confirming claim:', error);
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

app.post('/api/agents/:id/test-post', async (req, res) => {
  try {
    const skillId = parseInt(req.params.id, 10);
    if (isNaN(skillId)) {
      return res.status(400).json({ success: false, error: 'Invalid skill ID' });
    }
    const result = await testPostForAgent(skillId);
    res.json({ success: result.success, ...result });
  } catch (error) {
    console.error('Error test posting:', error);
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

// ERC-8004 Agent Identity endpoints
app.post('/api/agents/:tokenId/register-8004', async (req, res) => {
  try {
    const tokenId = parseInt(req.params.tokenId, 10);
    if (isNaN(tokenId)) {
      return res.status(400).json({ success: false, error: 'Invalid token ID' });
    }

    const token = await db.getToken(tokenId);
    if (!token) {
      return res.status(404).json({ success: false, error: 'Token not found' });
    }

    const agentSkill = await db.getAgentSkillByTokenId(tokenId);
    if (!agentSkill) {
      return res.status(400).json({ success: false, error: 'No agent skill found for this token. Deploy agent first.' });
    }

    const chain = erc8004.getRegistryChain();
    const registryAddress = erc8004.getRegistryAddress();

    let existing = await db.getAgentIdentityByTokenId(tokenId);

    if (existing && (existing.status === 'failed' || (existing.status === 'registered' && !existing.agent_nft_id))) {
      await db.query('DELETE FROM agent_identities WHERE id = $1', [existing.id]);
      console.log(`[ERC-8004] Deleted old identity ${existing.id} (status: ${existing.status}) for retry`);
      existing = null;
    }

    const existingAgentNftId = (existing && existing.status === 'registered' && existing.agent_nft_id)
      ? existing.agent_nft_id : null;

    let identity = existing;
    if (!identity) {
      identity = await db.createAgentIdentity(tokenId, {
        agentSkillId: agentSkill.id,
        registryChain: chain,
        registryAddress: registryAddress
      });
    }

    const metadata = erc8004.buildAgentMetadata(token, agentSkill);
    const metadataJson = JSON.stringify(metadata);
    const metadataBase64 = Buffer.from(metadataJson).toString('base64');
    const metadataUri = `data:application/json;base64,${metadataBase64}`;

    if (existingAgentNftId && existing.metadata_uri === metadataUri) {
      return res.json({
        success: true,
        already_registered: true,
        identity: {
          id: existing.id,
          agentNftId: existing.agent_nft_id,
          chain: existing.registry_chain,
          scanUrl: existing.scan_url || erc8004.getScanUrl(existing.agent_nft_id),
          txHash: existing.tx_hash,
          status: existing.status
        }
      });
    }

    const metadataCid = `onchain-${identity.id}-${Date.now()}`;
    await db.updateAgentIdentityMetadata(identity.id, metadataUri, metadataCid);

    console.log(`[ERC-8004] Starting on-chain ${existingAgentNftId ? 'update' : 'registration'} for token ${tokenId}...`);

    try {
      const result = await erc8004.registerAgentOnChain(metadataUri, existingAgentNftId);

      await db.updateAgentIdentityRegistered(
        identity.id,
        result.agentNftId,
        result.txHash,
        result.registrarWallet,
        result.scanUrl
      );

      const action = result.updated ? 'updated' : 'registered';
      console.log(`[ERC-8004] ${action}! Agent #${result.agentNftId}, TX: ${result.txHash}`);

      res.json({
        success: true,
        identity: {
          id: identity.id,
          chain: chain,
          chainName: 'Base',
          registryAddress: registryAddress,
          agentNftId: result.agentNftId,
          txHash: result.txHash,
          scanUrl: result.scanUrl,
          explorerUrl: result.explorerUrl,
          status: 'registered'
        },
        message: `Agent #${result.agentNftId} registered on Base! View on 8004scan.io`
      });
    } catch (onchainError) {
      console.error(`[ERC-8004] On-chain registration failed:`, onchainError.message);
      await db.updateAgentIdentityStatus(identity.id, 'failed');
      res.status(500).json({
        success: false,
        error: `On-chain registration failed: ${onchainError.message}`,
        identity: { id: identity.id, status: 'failed' }
      });
    }
  } catch (error) {
    console.error('Error registering agent on 8004:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/agents/:tokenId/identity-8004', async (req, res) => {
  try {
    const tokenId = parseInt(req.params.tokenId, 10);
    if (isNaN(tokenId)) {
      return res.status(400).json({ success: false, error: 'Invalid token ID' });
    }

    const identity = await db.getAgentIdentityByTokenId(tokenId);
    if (!identity) {
      return res.json({ success: true, identity: null });
    }

    const token = await db.getToken(tokenId);
    const agentSkill = await db.getAgentSkillByTokenId(tokenId);

    let metadata = null;
    if (token && agentSkill) {
      metadata = erc8004.buildAgentMetadata(token, agentSkill);
    }

    res.json({
      success: true,
      identity: {
        id: identity.id,
        chain: identity.registry_chain,
        chainName: 'Base',
        registryAddress: identity.registry_address,
        agentNftId: identity.agent_nft_id,
        metadataUri: identity.metadata_uri,
        txHash: identity.tx_hash,
        explorerUrl: identity.tx_hash ? erc8004.getExplorerTxUrl(identity.tx_hash) : null,
        scanUrl: identity.scan_url,
        status: identity.status,
        registeredAt: identity.registered_at,
        metadata: metadata
      }
    });
  } catch (error) {
    console.error('Error fetching 8004 identity:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/agents/relayer-info', async (req, res) => {
  try {
    const info = await erc8004.getRelayerInfo();
    res.json({ success: true, relayer: info });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/agents/identities-8004', async (req, res) => {
  try {
    const identities = await db.getAllAgentIdentities();
    res.json({
      success: true,
      identities: identities.map(i => ({
        id: i.id,
        tokenId: i.token_id,
        tokenName: i.token_name,
        symbol: i.symbol,
        archetype: i.archetype,
        chain: i.registry_chain,
        chainName: 'Base',
        agentNftId: i.agent_nft_id,
        scanUrl: i.scan_url,
        status: i.status,
        registeredAt: i.registered_at
      }))
    });
  } catch (error) {
    console.error('Error fetching all 8004 identities:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/agents/:tokenId/metadata-8004', async (req, res) => {
  try {
    const tokenId = parseInt(req.params.tokenId, 10);
    if (isNaN(tokenId)) {
      return res.status(400).json({ success: false, error: 'Invalid token ID' });
    }

    const token = await db.getToken(tokenId);
    if (!token) {
      return res.status(404).json({ success: false, error: 'Token not found' });
    }

    const agentSkill = await db.getAgentSkillByTokenId(tokenId);
    if (!agentSkill) {
      return res.status(404).json({ success: false, error: 'No agent skill found' });
    }

    const metadata = erc8004.buildAgentMetadata(token, agentSkill);
    res.json(metadata);
  } catch (error) {
    console.error('Error building 8004 metadata:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Direct AI Chat endpoint (replaces OpenClaw gateway)
const chatHistories = new Map();

app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    console.log(`[Chat] Request received: "${message?.substring(0, 50)}..." sessionId: ${sessionId || 'default'}`);
    
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
    console.log(`[Chat] AI response length: ${assistantMessage.length} chars`);
    
    // Add assistant response to history
    history.push({ role: 'assistant', content: assistantMessage });

    // Try to extract blueprint JSON from response
    let blueprint = null;
    const jsonMatch = assistantMessage.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      console.log('[Chat] Found JSON block, attempting parse...');
      try {
        blueprint = JSON.parse(jsonMatch[1]);
        console.log(`[Chat] Blueprint extracted: ${blueprint.name} ($${blueprint.symbol})`);
      } catch (e) {
        console.log('[Chat] JSON parse failed:', e.message);
      }
    } else {
      console.log('[Chat] No JSON block found in response');
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

// Manual fee claim trigger endpoint
app.post('/api/admin/claim-fees', async (req, res) => {
  try {
    console.log('[Admin] Manual fee claim triggered');
    
    const tokens = await db.query(
      `SELECT * FROM tokens WHERE venue = 'pump.fun' AND status = 'active'`
    );
    
    if (!tokens.rows || tokens.rows.length === 0) {
      return res.json({ success: false, error: 'No active tokens found' });
    }
    
    const results = [];
    for (const token of tokens.rows) {
      try {
        if (!token.wallet_private_key_encrypted || !token.wallet_public_key) {
          results.push({ symbol: token.symbol, status: 'skipped', reason: 'missing wallet info' });
          continue;
        }
        
        console.log(`[Admin] Claiming fees for ${token.symbol}...`);
        
        const fetch = (await import('node-fetch')).default;
        const response = await fetch('https://pumpportal.fun/api/trade-local', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            publicKey: token.wallet_public_key,
            action: 'collectCreatorFee',
            priorityFee: 0.0001,
          })
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          results.push({ symbol: token.symbol, status: 'failed', reason: errorText });
          continue;
        }
        
        const txBytes = Buffer.from(await response.arrayBuffer());
        const { decrypt } = await import('./src/crypto.mjs');
        const solana = await import('./src/solana.mjs');
        
        const privateKey = decrypt(token.wallet_private_key_encrypted);
        const keypair = solana.keypairFromSecretKey(privateKey);
        const signature = await solana.signAndSendTransaction(txBytes, [keypair]);
        
        console.log(`[Admin] Fee claimed for ${token.symbol}: ${signature}`);
        results.push({ symbol: token.symbol, status: 'success', tx: signature });
        
      } catch (err) {
        console.error(`[Admin] Error claiming for ${token.symbol}:`, err.message);
        results.push({ symbol: token.symbol, status: 'error', reason: err.message });
      }
    }
    
    res.json({ success: true, results });
  } catch (error) {
    console.error('[Admin] Fee claim error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
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
  
  // NOTE: Standalone buyback scheduler disabled - fee claimer cycle handles claim + buyback + burn
  // startBuybackScheduler();
  vanityPool.startPoolManager();
  startBagsFeeClaimer();
  startPumpfunFeeClaimer();
  startClankerFeeClaimer();
  startAutoPostScheduler();
});
