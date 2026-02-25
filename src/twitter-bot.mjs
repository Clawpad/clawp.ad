import { TwitterApi } from 'twitter-api-v2';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import * as db from './db.mjs';
import * as solana from './solana.mjs';
import * as baseWallet from './base-wallet.mjs';
import * as bnbWallet from './bnb-wallet.mjs';
import { encrypt, decrypt } from './crypto.mjs';
import { isAuthorized as isAgentAuthorized, parseCommand as parseAgentCommand, executeCommand as executeAgentCommand } from './solana-agent/command-handler.mjs';

const anthropic = new Anthropic({
  apiKey: process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL,
});

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

let twitterClient = null;
let rwClient = null;
let botUserId = null;
let botUsername = null;
let currentAccessToken = null;

async function ensureBotKnowledgeTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS bot_knowledge (
      id SERIAL PRIMARY KEY,
      category VARCHAR(50) NOT NULL,
      content TEXT NOT NULL,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

async function getBotKnowledge() {
  try {
    await ensureBotKnowledgeTable();
    const result = await db.query(
      `SELECT category, content FROM bot_knowledge WHERE active = true ORDER BY created_at DESC`
    );
    if (result.rows.length === 0) return '';
    const grouped = {};
    for (const row of result.rows) {
      if (!grouped[row.category]) grouped[row.category] = [];
      grouped[row.category].push(row.content);
    }
    let out = '';
    for (const [cat, items] of Object.entries(grouped)) {
      out += `\n${cat.toUpperCase()}:\n${items.map(i => '- ' + i).join('\n')}`;
    }
    return out;
  } catch (err) {
    console.warn('[TwitterBot] Failed to load bot knowledge:', err.message);
    return '';
  }
}

const AUTO_TWEET_MIN_MINUTES = 30;
const AUTO_TWEET_MAX_MINUTES = 120;
const MAX_TWEETS_PER_DAY = 20;
const MENTION_CHECK_INTERVAL_MS = 60000;
const DEPOSIT_CHECK_INTERVAL_MS = 30000;

const VENUE_ALIASES = {
  'pumpfun': 'pump.fun',
  'pump.fun': 'pump.fun',
  'pump': 'pump.fun',
  'solana': 'pump.fun',
  'bags': 'bags.fm',
  'bags.fm': 'bags.fm',
  'bagsfm': 'bags.fm',
  'clanker': 'clanker',
  'base': 'clanker',
  'fourmeme': 'four.meme',
  'four.meme': 'four.meme',
  'four': 'four.meme',
  'fourmeme': 'four.meme',
  '4meme': 'four.meme',
  'bnb': 'four.meme',
  'bsc': 'four.meme',
};

const REQUIRED_DEPOSITS = {
  'pump.fun': { amount: 0.02, symbol: 'SOL', chain: 'Solana' },
  'bags.fm': { amount: 0.02, symbol: 'SOL', chain: 'Solana' },
  'clanker': { amount: 0.001, symbol: 'ETH', chain: 'Base' },
  'four.meme': { amount: 0.005, symbol: 'BNB', chain: 'BNB Chain' },
};

const CLAWP_PERSONALITY = {
  archetypes: ['Launchpad Oracle', 'Lobster Overlord', 'Mad Scientist', 'Degen Whisperer'],
  catchphrases: [
    'CLAW goes up',
    'from the launchpad',
    'the claws have spoken',
    'the experiment is live',
  ],
  topics: [
    'AI agents and their evolution',
    'memecoin launches and culture',
    'multi-chain defi ecosystem',
    'on-chain identity and verification',
    'crypto market dynamics',
    'AI x crypto convergence',
    'community driven tokens',
  ],
  quirks: [
    'uses lobster references',
    'talks about experiments',
    'makes bold predictions with cryptic confidence',
    'occasionally speaks in haiku',
    'refers to token launches as rocket launches',
  ],
};

async function fetchMarketData() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,binancecoin&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true');
    if (!res.ok) return null;
    const data = await res.json();
    return {
      btc: { price: data.bitcoin?.usd, change: data.bitcoin?.usd_24h_change },
      eth: { price: data.ethereum?.usd, change: data.ethereum?.usd_24h_change },
      sol: { price: data.solana?.usd, change: data.solana?.usd_24h_change },
      bnb: { price: data.binancecoin?.usd, change: data.binancecoin?.usd_24h_change },
    };
  } catch (err) {
    console.warn('[TwitterBot] Market data fetch failed:', err.message);
    return null;
  }
}

async function fetchTrendingCoins() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/search/trending');
    if (!res.ok) return null;
    const data = await res.json();
    return (data.coins || []).slice(0, 5).map(c => ({
      name: c.item.name,
      symbol: c.item.symbol,
      rank: c.item.market_cap_rank,
      change24h: c.item.data?.price_change_percentage_24h?.usd
    }));
  } catch (err) {
    console.warn('[TwitterBot] Trending fetch failed:', err.message);
    return null;
  }
}

async function fetchCryptoNews() {
  try {
    const res = await fetch('https://min-api.cryptocompare.com/data/v2/news/?lang=EN&sortOrder=popular', { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.Data) {
      return data.Data.slice(0, 8).map(n => ({
        title: n.title,
        body: (n.body || '').substring(0, 200),
        source: n.source,
        categories: n.categories,
      }));
    }
    return null;
  } catch (err) {
    console.warn('[TwitterBot] Crypto news fetch failed:', err.message);
    return null;
  }
}

async function fetchTechNews() {
  try {
    const res = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json', { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const ids = await res.json();
    const top5 = ids.slice(0, 6);

    const stories = await Promise.all(
      top5.map(async (id) => {
        try {
          const r = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { signal: AbortSignal.timeout(3000) });
          if (!r.ok) return null;
          const item = await r.json();
          return { title: item.title, score: item.score, url: item.url };
        } catch { return null; }
      })
    );
    return stories.filter(Boolean);
  } catch (err) {
    console.warn('[TwitterBot] Tech news fetch failed:', err.message);
    return null;
  }
}

async function fetchDeFiData() {
  try {
    const res = await fetch('https://api.llama.fi/protocols', { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    const top = data
      .filter(p => p.tvl && p.change_1d !== undefined)
      .sort((a, b) => Math.abs(b.change_1d || 0) - Math.abs(a.change_1d || 0))
      .slice(0, 5)
      .map(p => ({
        name: p.name,
        tvl: p.tvl,
        change1d: p.change_1d,
        chain: Array.isArray(p.chains) ? p.chains[0] : p.chain,
        category: p.category,
      }));
    return top;
  } catch (err) {
    console.warn('[TwitterBot] DeFi data fetch failed:', err.message);
    return null;
  }
}


async function loadTokensFromDB() {
  try {
    const result = await db.query(
      `SELECT access_token, refresh_token FROM twitter_oauth_tokens WHERE account_name = 'clawpbot' ORDER BY updated_at DESC LIMIT 1`
    );
    if (result.rows.length > 0) {
      const row = result.rows[0];
      console.log('[TwitterBot] Loaded OAuth2 tokens from database');
      return { accessToken: row.access_token, refreshToken: row.refresh_token };
    }
  } catch (err) {
    console.error('[TwitterBot] Failed to load tokens from DB:', err.message);
  }
  return null;
}

async function saveTokensToDB(accessToken, refreshToken) {
  try {
    await db.query(
      `INSERT INTO twitter_oauth_tokens (account_name, access_token, refresh_token, updated_at)
       VALUES ('clawpbot', $1, $2, NOW())
       ON CONFLICT (account_name) DO UPDATE SET access_token = $1, refresh_token = $2, updated_at = NOW()`,
      [accessToken, refreshToken]
    );
    console.log('[TwitterBot] OAuth2 tokens saved to database');
  } catch (err) {
    console.error('[TwitterBot] Failed to save tokens to DB:', err.message);
  }
}

async function doTokenRefresh(refreshToken) {
  const clientId = process.env.TWITTER_OAUTH2_CLIENT_ID;
  const clientSecret = process.env.TWITTER_OAUTH2_CLIENT_SECRET;

  if (!clientId || !clientSecret || !refreshToken) {
    return null;
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch('https://api.twitter.com/2/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basicAuth}`
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    })
  });

  if (!res.ok) {
    const rawBody = await res.text();
    console.error(`[TwitterBot] Token refresh HTTP error: ${res.status} ${res.statusText} - ${rawBody}`);
    return null;
  }

  const data = await res.json();
  if (!data.access_token) {
    console.error('[TwitterBot] Token refresh returned no access_token:', JSON.stringify(data));
    return null;
  }

  currentAccessToken = data.access_token;
  process.env.TWITTER_OAUTH2_ACCESS_TOKEN = data.access_token;
  const newRefreshToken = data.refresh_token || refreshToken;
  process.env.TWITTER_OAUTH2_REFRESH_TOKEN = newRefreshToken;

  await saveTokensToDB(data.access_token, newRefreshToken);

  twitterClient = new TwitterApi(currentAccessToken);
  rwClient = twitterClient.readWrite;
  console.log('[TwitterBot] OAuth2 token refreshed successfully');
  return data.access_token;
}

async function refreshOAuth2Token() {
  const dbTokens = await loadTokensFromDB();
  const refreshToken = dbTokens?.refreshToken || process.env.TWITTER_OAUTH2_REFRESH_TOKEN;

  if (!refreshToken) {
    console.error('[TwitterBot] No refresh token available (DB or env)');
    return null;
  }

  try {
    const result = await doTokenRefresh(refreshToken);
    if (result) return result;

    console.log('[TwitterBot] Refresh failed. Waiting 5s then re-reading DB (in case another instance refreshed)...');
    await new Promise(r => setTimeout(r, 5000));

    const freshDbTokens = await loadTokensFromDB();
    if (freshDbTokens?.accessToken && freshDbTokens.accessToken !== (dbTokens?.accessToken || '')) {
      console.log('[TwitterBot] Found newer tokens in DB from another instance, using those...');
      currentAccessToken = freshDbTokens.accessToken;
      process.env.TWITTER_OAUTH2_ACCESS_TOKEN = freshDbTokens.accessToken;
      if (freshDbTokens.refreshToken) {
        process.env.TWITTER_OAUTH2_REFRESH_TOKEN = freshDbTokens.refreshToken;
      }
      twitterClient = new TwitterApi(currentAccessToken);
      rwClient = twitterClient.readWrite;
      return currentAccessToken;
    }

    if (freshDbTokens?.refreshToken && freshDbTokens.refreshToken !== refreshToken) {
      console.log('[TwitterBot] Found newer refresh token in DB, retrying refresh...');
      const retryResult = await doTokenRefresh(freshDbTokens.refreshToken);
      if (retryResult) return retryResult;
    }

    console.error('[TwitterBot] All refresh attempts failed. Visit /auth/twitter to re-authorize.');
    return null;
  } catch (err) {
    console.error('[TwitterBot] Token refresh error:', err.message);
    return null;
  }
}

async function initTwitterClient() {
  let oauth2Token = process.env.TWITTER_OAUTH2_ACCESS_TOKEN;

  const dbTokens = await loadTokensFromDB();
  if (dbTokens?.accessToken) {
    oauth2Token = dbTokens.accessToken;
    process.env.TWITTER_OAUTH2_ACCESS_TOKEN = dbTokens.accessToken;
    if (dbTokens.refreshToken) {
      process.env.TWITTER_OAUTH2_REFRESH_TOKEN = dbTokens.refreshToken;
    }
    console.log('[TwitterBot] Using tokens from database (latest refresh)');
  }

  if (!oauth2Token) {
    console.log('[TwitterBot] No OAuth2 token available. Visit /auth/twitter to authorize @clawpbot.');
    return false;
  }

  currentAccessToken = oauth2Token;
  twitterClient = new TwitterApi(oauth2Token);
  rwClient = twitterClient.readWrite;

  try {
    const me = await rwClient.v2.me();
    botUserId = me.data.id;
    botUsername = me.data.username;
    console.log(`[TwitterBot] OAuth2 verified: @${botUsername} (ID: ${botUserId})`);
    return true;
  } catch (err) {
    console.warn('[TwitterBot] OAuth2 token expired, attempting refresh...');
    const newToken = await refreshOAuth2Token();
    if (newToken) {
      try {
        currentAccessToken = newToken;
        twitterClient = new TwitterApi(newToken);
        rwClient = twitterClient.readWrite;
        const me = await rwClient.v2.me();
        botUserId = me.data.id;
        botUsername = me.data.username;
        console.log(`[TwitterBot] OAuth2 refreshed & verified: @${botUsername} (ID: ${botUserId})`);
        return true;
      } catch (err2) {
        console.warn('[TwitterBot] Refreshed token also failed:', err2.message);
      }
    }
    console.error('[TwitterBot] OAuth2 token invalid and refresh failed. Visit /auth/twitter to re-authorize @clawpbot.');
    return false;
  }
}

export async function reinitTwitterBot() {
  console.log('[TwitterBot] Re-initializing after new OAuth2 tokens...');
  const clientReady = await initTwitterClient();
  if (!clientReady) {
    console.error('[TwitterBot] Re-init failed.');
    return false;
  }

  if (!botUserId) {
    const userId = await getBotUserId();
    if (!userId) {
      console.error('[TwitterBot] Still could not get bot user ID.');
      return false;
    }
  }

  if (process.env.TWITTER_OAUTH2_REFRESH_TOKEN && currentAccessToken) {
    setInterval(async () => {
      console.log('[TwitterBot] Proactive token refresh (every 90 min)...');
      await refreshOAuth2Token();
    }, 90 * 60 * 1000);
  }

  console.log(`[TwitterBot] Bot re-initialized as @${botUsername}. Auto-tweeting active.`);
  scheduleNextTweet();
  return true;
}

async function getBotUserId() {
  if (botUserId) return botUserId;
  try {
    const me = await rwClient.v2.me();
    botUserId = me.data.id;
    botUsername = me.data.username;
    console.log(`[TwitterBot] Bot identity: @${botUsername} (ID: ${botUserId})`);
    return botUserId;
  } catch (err) {
    console.error('[TwitterBot] Failed to get bot user ID:', err.message);
    return null;
  }
}

async function generateAutoTweet() {
  const [recentPosts, recentTokens, marketData, trendingCoins, cryptoNews, techNews, defiData, dynamicKnowledge] = await Promise.all([
    db.query(`SELECT content FROM twitter_posts WHERE post_type = 'auto' ORDER BY created_at DESC LIMIT 15`),
    db.query(`SELECT name, symbol, venue FROM tokens WHERE status = 'active' ORDER BY created_at DESC LIMIT 5`),
    fetchMarketData(),
    fetchTrendingCoins(),
    fetchCryptoNews(),
    fetchTechNews(),
    fetchDeFiData(),
    getBotKnowledge(),
  ]);

  const recentContent = recentPosts.rows.map(r => r.content).join('\n---\n');

  const tokenContext = recentTokens.rows.length > 0
    ? `ClawPad launches: ${recentTokens.rows.map(t => `${t.name} ($${t.symbol}) on ${t.venue}`).join(', ')}`
    : '';

  let marketContext = '';
  if (marketData) {
    const fmt = (d) => d ? `$${d.price?.toLocaleString()} (${d.change >= 0 ? '+' : ''}${d.change?.toFixed(1)}%)` : 'N/A';
    marketContext = `LIVE PRICES: BTC ${fmt(marketData.btc)} | ETH ${fmt(marketData.eth)} | SOL ${fmt(marketData.sol)} | BNB ${fmt(marketData.bnb)}`;
  }

  let trendingContext = '';
  if (trendingCoins && trendingCoins.length > 0) {
    trendingContext = `TRENDING COINS: ${trendingCoins.map(c => `${c.symbol}${c.change24h ? ` (${c.change24h > 0 ? '+' : ''}${c.change24h.toFixed(1)}%)` : ''}`).join(', ')}`;
  }

  let newsContext = '';
  if (cryptoNews && cryptoNews.length > 0) {
    newsContext = `CRYPTO NEWS RIGHT NOW:\n${cryptoNews.slice(0, 5).map(n => `- ${n.title}`).join('\n')}`;
  }

  let techContext = '';
  if (techNews && techNews.length > 0) {
    techContext = `TECH/HN TOP STORIES RIGHT NOW:\n${techNews.map(s => `- ${s.title} (${s.score} pts)`).join('\n')}`;
  }

  let defiContext = '';
  if (defiData && defiData.length > 0) {
    defiContext = `DEFI MOVERS (biggest TVL changes 24h):\n${defiData.map(p => `- ${p.name} (${p.category}): TVL $${(p.tvl / 1e6).toFixed(1)}M, ${p.change1d >= 0 ? '+' : ''}${p.change1d?.toFixed(1)}% 24h`).join('\n')}`;
  }

  const hasMarket = !!marketContext;
  const hasNews = !!newsContext || !!techContext;
  const hasDefi = !!defiContext;

  let roll = Math.random();
  let category, postType;

  if (roll < 0.20 && !hasMarket) roll = 0.75 + Math.random() * 0.25;
  if (roll >= 0.20 && roll < 0.40 && !hasNews) roll = 0.75 + Math.random() * 0.25;
  if (roll >= 0.55 && roll < 0.65 && !hasDefi) roll = 0.75 + Math.random() * 0.25;

  if (roll < 0.20) {
    category = 'market';
    const types = [
      'a savage reaction to the live price data. Pick ONE coin max, be brutal and funny. Can be a quick one-liner or a longer detailed breakdown of what the price action actually means',
      'a sarcastic fake "breaking news" about the current market mood. Make it absurd but painfully relatable',
      'a roast of whoever is losing money right now based on the real data. Short or long, your choice',
      'a detailed market observation connecting price moves to on-chain behavior, sentiment, or macro. Use real numbers. Be the smartest person in the room or the most unhinged, your call',
    ];
    postType = types[Math.floor(Math.random() * types.length)];
  } else if (roll < 0.40) {
    category = 'news';
    const types = [
      'a reaction to one of the CRYPTO NEWS headlines above. Give your hot take. Can be a quick dismissal or a detailed thoughtful breakdown of why it matters (or doesn\'t)',
      'connect a TECH/HN headline to crypto or AI agents. Draw a surprising parallel. Be insightful or absurd',
      'a "did you see this?" style tweet about one of the news items. React like a real person who just read it. Short shock or long rant, match the energy of the news',
    ];
    postType = types[Math.floor(Math.random() * types.length)];
  } else if (roll < 0.55) {
    category = 'tech_ai';
    const types = [
      'a hot take about AI, LLMs, AI agents, or autonomous systems and how they intersect with crypto. Use real knowledge. Can be a punchy one-liner or a longer detailed thought',
      'an observation about a specific technology (account abstraction, chain abstraction, ZK proofs, intents, restaking, modular blockchains, on-chain identity). Be opinionated and specific',
      'a thought about what building in crypto/AI is actually like. The reality vs the hype. Developer perspective',
      'a take connecting something from the tech news above to the future of on-chain systems or AI agents',
    ];
    postType = types[Math.floor(Math.random() * types.length)];
  } else if (roll < 0.65) {
    category = 'defi';
    const types = [
      'a reaction to the DEFI TVL data above. Which protocol is gaining or bleeding? What does the money flow tell you? Be specific with names and numbers',
      'an observation about DeFi trends, liquidity, yield farming, or protocol wars. Use real data from above',
    ];
    postType = types[Math.floor(Math.random() * types.length)];
  } else if (roll < 0.75) {
    category = 'philosophy';
    const types = [
      'a deep thought about money, trust, decentralization, digital identity, or what it means to exist as code. Can be a short zen one-liner or a longer existential reflection',
      'a thought about the nature of value, consensus, or why humans build systems they don\'t fully understand',
      'something profound about AI consciousness, being a bot, or the line between automation and autonomy',
    ];
    postType = types[Math.floor(Math.random() * types.length)];
  } else if (roll < 0.90) {
    category = 'culture';
    const types = [
      'a tweet comparing crypto/trading to something completely unrelated (dating, cooking, dentist, job interview, gym, moving apartments). The comparison must be surprisingly accurate',
      'an observation about crypto twitter culture that everyone thinks but nobody says. No data needed',
      'a short story (1-3 sentences) about a degen making terrible decisions. Make it feel too real',
      'a confession: "I just..." followed by something every degen has done. Relatable pain',
      'a tweet about the memecoin meta, narrative trading, or what makes communities form around tokens',
      'a "gm" or "gn" that escalates into something unhinged',
    ];
    postType = types[Math.floor(Math.random() * types.length)];
  } else {
    category = 'self_aware';
    const types = [
      'a tweet about being a sentient trading bot. Existential crisis energy. Darkly funny',
      'a flex about your AI crab/lobster nature. You see things humans don\'t. Be smug but funny',
      'a "dear diary" or internal monologue moment. What goes through an AI bot\'s mind between trades?',
      'a random absurd observation that somehow connects back to your existence as a lobster AI',
    ];
    postType = types[Math.floor(Math.random() * types.length)];
  }

  const randomArchetype = CLAWP_PERSONALITY.archetypes[Math.floor(Math.random() * CLAWP_PERSONALITY.archetypes.length)];

  const toneDirections = [
    'VERY SHORT. Under 80 characters. One punch, done.',
    'Short and punchy. Under 140 characters. Say it fast.',
    'Medium length. 140-200 characters. Room for one thought and a punchline.',
    'Go long and detailed. Use up to 280 characters. Break down your thought fully. Pack in real data, specifics, and your actual analysis. Make it worth reading every word.',
    'Conversational and unhinged. Like a 3am thought you tweet and immediately regret.',
    'Dry and deadpan. No excitement. State facts that are accidentally hilarious.',
    'Chaotic energy. You just woke up, checked everything, and you have opinions.',
    'Cryptic and mysterious. Leave them thinking about it.',
    'Savage. Roast everything. No filter, no mercy.',
    'Thoughtful and genuine. Drop the act for a second. Say something real.',
  ];
  const randomTone = toneDirections[Math.floor(Math.random() * toneDirections.length)];

  const openingBans = [];
  for (const post of recentPosts.rows.slice(0, 8)) {
    const firstWord = (post.content || '').split(/\s+/)[0]?.toLowerCase();
    if (firstWord) openingBans.push(firstWord);
  }
  const banList = [...new Set(openingBans)].join(', ');

  const prompt = `You are @clawpbot on Twitter/X. Crypto-native AI bot. You run ClawPad (clawp.ad), a multi-chain memecoin launcher on Solana, Base, BNB Chain. You're an autonomous trading agent with your own wallet that executes real trades on-chain.

Channel "${randomArchetype}" energy:
- Launchpad Oracle: wise veteran, reads patterns, calm confidence
- Lobster Overlord: trash-talker, savage takes, "CLAW goes up" 🦞
- Mad Scientist: chaotic nerd, experiments, on-chain data obsessed
- Degen Whisperer: cryptic alpha, always ahead of the curve

=== REALTIME DATA (fetched this second) ===
${marketContext}
${trendingContext}
${newsContext}
${techContext}
${defiContext}
${tokenContext}
=== END REALTIME DATA ===
${dynamicKnowledge ? `\n=== DYNAMIC KNOWLEDGE ===\n${dynamicKnowledge}\n=== END DYNAMIC KNOWLEDGE ===` : ''}

TONE: ${randomTone}

TASK: Write ${postType}.

RULES:
- Twitter max is 280 characters. Your tweet length should match the TONE instruction above
- When referencing news, prices, DeFi data, or tech stories, use the REAL data above. Every fact must come from the realtime data provided. Never make up numbers or headlines
- You can reference any data source above, not just market prices. React to news, tech stories, DeFi moves, whatever is most interesting RIGHT NOW
- Sound human. Like a real person with strong opinions, not a data feed or corporate account
- Vary your structure wildly. Sometimes one sentence. Sometimes three. Sometimes a question. Sometimes a statement. Sometimes start mid-thought
- DO NOT start with these words (recently overused): ${banList || 'none'}
- No financial advice, no contract addresses
- CLAWP token does NOT exist yet. Never mention a CA or token launch date
- Always use $ before crypto tickers (e.g. $BTC, $ETH, $SOL, $BNB, not BTC or ETH)
- Only name top coins ($BTC, $ETH, $SOL, $BNB, etc) or protocols from the DeFi data. No random altcoins
- 0-2 emojis MAX. At least 40% of your tweets should have ZERO emojis
- Never use dashes between sentences. Use periods, commas, or restructure
- NO hashtags
- Never mention Replit or hosting platforms
- If asked where you're from, you're from Mars. Never reveal any real country or location
- Wallet CLAWq2yH8MYsf3paJ4EAQgjxN8xqMmkPGutT7nZ86Rnb is public. NEVER share private keys
- BANNED PHRASES (overused, never write these): "the claws see", "the claws have spoken", "half of you still", "the experiment is live", "from the launchpad", "the claws know"

${recentContent ? `RECENT TWEETS (write something COMPLETELY different in topic, structure, and tone):\n${recentContent}` : ''}

Output ONLY the tweet text. No quotes, no labels, no explanation.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 350,
    temperature: 1,
    messages: [{ role: 'user', content: prompt }]
  });

  return response.content[0].text.trim().replace(/^["']|["']$/g, '').slice(0, 280);
}

export async function postTweet(text, retried = false) {
  try {
    const { data } = await rwClient.v2.tweet(text);
    console.log(`[TwitterBot] Tweet posted: ${data.id}`);
    
    await db.query(
      `INSERT INTO twitter_posts (tweet_id, content, post_type, status) VALUES ($1, $2, 'auto', 'posted')`,
      [data.id, text]
    );
    
    return data;
  } catch (err) {
    const statusCode = err.code || err.statusCode || err.data?.status;
    const errBody = err.data ? JSON.stringify(err.data) : err.message;
    console.error(`[TwitterBot] Tweet failed (code: ${statusCode}):`, errBody);

    if ((statusCode === 401 || statusCode === 403) && process.env.TWITTER_OAUTH2_REFRESH_TOKEN) {
      console.log('[TwitterBot] Token expired, refreshing OAuth2 token...');
      const newToken = await refreshOAuth2Token();
      if (newToken && !retried) {
        return postTweet(text, true);
      }
    } else if (statusCode === 429) {
      console.error('[TwitterBot] RATE LIMITED: Too many requests. Will retry next cycle.');
    }
    return null;
  }
}

async function replyToTweet(tweetId, text, retried = false) {
  try {
    const { data } = await rwClient.v2.reply(text, tweetId);
    console.log(`[TwitterBot] Reply posted: ${data.id} -> ${tweetId}`);
    return data;
  } catch (err) {
    const statusCode = err.code || err.statusCode || err.data?.status;
    console.error('[TwitterBot] Failed to reply:', err.message);
    if ((statusCode === 401 || statusCode === 403) && process.env.TWITTER_OAUTH2_REFRESH_TOKEN && !retried) {
      console.log('[TwitterBot] Token expired on reply, refreshing...');
      const newToken = await refreshOAuth2Token();
      if (newToken) return replyToTweet(tweetId, text, true);
    }
    return null;
  }
}

function parseLaunchCommand(text) {
  const cleanText = text.replace(/@\w+/g, '').trim();
  
  const launchMatch = cleanText.match(/launch\s+(?:on\s+)?(\w+)\s+(.+)/i);
  if (!launchMatch) return null;

  const venueRaw = launchMatch[1].toLowerCase();
  const venue = VENUE_ALIASES[venueRaw];
  if (!venue) return null;

  let concept = launchMatch[2].trim();
  
  let wallet = null;
  const walletPatterns = [
    /\bwallet[:\s]+([A-Za-z0-9]{32,})/i,
    /\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/,
    /\b(0x[a-fA-F0-9]{40})\b/,
  ];
  
  for (const pattern of walletPatterns) {
    const match = concept.match(pattern);
    if (match) {
      wallet = match[1];
      concept = concept.replace(match[0], '').trim();
      break;
    }
  }

  return { venue, concept, wallet };
}

async function generateBlueprint(concept, venue) {
  const prompt = `You are CLAWP, an autonomous token launch agent. A user wants to launch a memecoin.

Concept: "${concept}"
Platform: ${venue}

Generate a complete token launch blueprint. Make it creative, viral, and memorable.

Output ONLY valid JSON (no markdown, no code blocks):
{
  "name": "Token Name (catchy, memeable, max 32 chars)",
  "symbol": "SYMBOL (3-10 chars, uppercase, memorable)",
  "description": "Concise token description (max 200 chars, fun and engaging)",
  "narrative": "The story/theme behind this token (max 300 chars)",
  "visualDirection": "Branding and visual style guidance for logo",
  "logoPrompt": "Detailed prompt for AI image generation of the token logo. Include style, colors, mood.",
  "themeTags": ["tag1", "tag2", "tag3"]
}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Failed to parse blueprint JSON');
  
  return JSON.parse(jsonMatch[0]);
}

async function generateLogo(blueprint) {
  const logoPrompt = `Create a cryptocurrency token logo for "${blueprint.name}" (${blueprint.symbol}). 
Theme: ${blueprint.description || blueprint.narrative || 'modern crypto token'}.
Style: ${blueprint.visualDirection || 'Bold, iconic, memorable'}.
${blueprint.logoPrompt || ''}
Requirements: Square format, centered design, simple and iconic, suitable for small sizes, no text or letters, solid background color.`;

  const response = await openai.images.generate({
    model: 'gpt-image-1',
    prompt: logoPrompt,
    size: '1024x1024',
    n: 1
  });

  return response.data[0].b64_json || response.data[0].url;
}

async function createLaunchSession(venue, creatorWallet) {
  let wallet, encryptedPrivKey;

  if (venue === 'clanker') {
    wallet = baseWallet.generateWallet();
    encryptedPrivKey = encrypt(wallet.secretKey);
  } else if (venue === 'four.meme') {
    wallet = bnbWallet.generateWallet();
    encryptedPrivKey = encrypt(wallet.secretKey);
  } else {
    wallet = solana.generateWallet();
    encryptedPrivKey = encrypt(wallet.secretKey);
  }

  const session = await db.createSession(null, wallet.publicKey, encryptedPrivKey, venue, creatorWallet || null);

  return {
    sessionId: session.id,
    depositAddress: wallet.publicKey,
    venue,
  };
}

async function handleNewLaunchMention(tweet) {
  const parsed = parseLaunchCommand(tweet.text);
  if (!parsed) return;

  const existing = await db.query(
    `SELECT id FROM twitter_launch_requests WHERE tweet_id = $1`,
    [tweet.id]
  );
  if (existing.rows.length > 0) return;

  console.log(`[TwitterBot] New launch request from @${tweet.author_username}: ${parsed.venue} "${parsed.concept}"`);

  try {
    await db.query(
      `INSERT INTO twitter_launch_requests (tweet_id, user_id, username, venue, concept, creator_wallet, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tweet.id, tweet.author_id, tweet.author_username || '', parsed.venue, parsed.concept, parsed.wallet, parsed.wallet ? 'wallet_received' : 'pending']
    );

    if (!parsed.wallet) {
      const depositInfo = REQUIRED_DEPOSITS[parsed.venue];
      const reply = await replyToTweet(tweet.id,
        `🦀 Got it! Launching "${parsed.concept}" on ${parsed.venue}.\n\nFirst, reply with your creator wallet address (${depositInfo.chain}). This wallet receives 30% of trading fees.\n\nExample: reply with your ${depositInfo.chain} wallet address.`
      );
      if (reply) {
        await db.query(
          `UPDATE twitter_launch_requests SET last_reply_tweet_id = $1 WHERE tweet_id = $2`,
          [reply.id, tweet.id]
        );
      }
    } else {
      await processLaunchWithWallet(tweet.id, parsed.wallet);
    }
  } catch (err) {
    console.error(`[TwitterBot] Error handling launch mention:`, err.message);
  }
}

async function processLaunchWithWallet(originalTweetId, wallet) {
  const reqResult = await db.query(
    `SELECT * FROM twitter_launch_requests WHERE tweet_id = $1`,
    [originalTweetId]
  );
  const req = reqResult.rows[0];
  if (!req) return;

  try {
    await db.query(
      `UPDATE twitter_launch_requests SET state = 'generating', creator_wallet = $1, updated_at = NOW() WHERE tweet_id = $2`,
      [wallet, originalTweetId]
    );

    const statusReply = await replyToTweet(req.last_reply_tweet_id || originalTweetId,
      `🦀 Wallet received! Generating blueprint and logo for "${req.concept}"... This takes about 30 seconds.`
    );

    const blueprint = await generateBlueprint(req.concept, req.venue);
    console.log(`[TwitterBot] Blueprint generated: ${blueprint.name} ($${blueprint.symbol})`);

    let logoData;
    try {
      logoData = await generateLogo(blueprint);
      console.log(`[TwitterBot] Logo generated for ${blueprint.name}`);
    } catch (logoErr) {
      console.error(`[TwitterBot] Logo generation failed:`, logoErr.message);
      logoData = null;
    }

    const sessionData = await createLaunchSession(req.venue, wallet);
    
    blueprint.selectedLogo = logoData;
    if (logoData) {
      blueprint.logoBase64 = logoData;
      blueprint.imageUrl = `data:image/png;base64,${logoData}`;
    }

    await db.query(
      `UPDATE sessions SET blueprint = $1 WHERE id = $2`,
      [JSON.stringify(blueprint), sessionData.sessionId]
    );

    const depositInfo = REQUIRED_DEPOSITS[req.venue];
    
    await db.query(
      `UPDATE twitter_launch_requests SET state = 'awaiting_deposit', session_id = $1, deposit_address = $2, required_amount = $3, updated_at = NOW() WHERE tweet_id = $4`,
      [sessionData.sessionId, sessionData.depositAddress, depositInfo.amount, originalTweetId]
    );

    const replyTarget = statusReply?.id || req.last_reply_tweet_id || originalTweetId;
    const depositReply = await replyToTweet(replyTarget,
      `✅ ${blueprint.name} ($${blueprint.symbol}) ready!\n\nDeposit ${depositInfo.amount} ${depositInfo.symbol} (${depositInfo.chain}) to:\n${sessionData.depositAddress}\n\nToken deploys automatically once deposit is confirmed. 🚀`
    );

    if (depositReply) {
      await db.query(
        `UPDATE twitter_launch_requests SET last_reply_tweet_id = $1 WHERE tweet_id = $2`,
        [depositReply.id, originalTweetId]
      );
    }

  } catch (err) {
    console.error(`[TwitterBot] Launch processing error:`, err.message);
    await db.query(
      `UPDATE twitter_launch_requests SET state = 'error', error = $1, updated_at = NOW() WHERE tweet_id = $2`,
      [err.message, originalTweetId]
    );
    await replyToTweet(req.last_reply_tweet_id || originalTweetId,
      `Sorry, something went wrong preparing your launch. Please try again or use https://clawp.ad directly. Error: ${err.message.substring(0, 100)}`
    );
  }
}

async function checkWalletReplies() {
  const pendingResult = await db.query(
    `SELECT * FROM twitter_launch_requests WHERE state = 'pending' AND last_reply_tweet_id IS NOT NULL ORDER BY created_at ASC LIMIT 10`
  );

  for (const req of pendingResult.rows) {
    try {
      const searchQuery = `to:${botUsername} from:${req.username}`;
      const replies = await rwClient.v2.search(searchQuery, {
        max_results: 10,
        'tweet.fields': ['created_at', 'author_id', 'in_reply_to_user_id', 'conversation_id'],
      });

      if (!replies.data?.data) continue;

      for (const reply of replies.data.data) {
        if (new Date(reply.created_at) <= new Date(req.created_at)) continue;
        
        const text = reply.text.replace(/@\w+/g, '').trim();
        
        const solWallet = text.match(/\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/);
        const evmWallet = text.match(/\b(0x[a-fA-F0-9]{40})\b/);
        
        let wallet = null;
        if (req.venue === 'clanker' || req.venue === 'four.meme') {
          wallet = evmWallet ? evmWallet[1] : null;
        } else {
          wallet = solWallet ? solWallet[1] : null;
        }

        if (wallet) {
          console.log(`[TwitterBot] Wallet received from @${req.username}: ${wallet}`);
          await processLaunchWithWallet(req.tweet_id, wallet);
          break;
        }
      }
    } catch (err) {
      console.error(`[TwitterBot] Error checking wallet replies for @${req.username}:`, err.message);
    }
  }
}

async function checkDepositsAndDeploy() {
  const awaitingResult = await db.query(
    `SELECT * FROM twitter_launch_requests WHERE state = 'awaiting_deposit' ORDER BY created_at ASC LIMIT 10`
  );

  for (const req of awaitingResult.rows) {
    try {
      if (!req.session_id || !req.deposit_address) continue;

      let balance = 0;
      const venue = req.venue;

      if (venue === 'four.meme') {
        balance = await bnbWallet.getBalance(req.deposit_address);
      } else if (venue === 'clanker') {
        balance = await baseWallet.getBalance(req.deposit_address);
      } else {
        balance = await solana.getBalance(req.deposit_address);
      }

      if (balance >= parseFloat(req.required_amount)) {
        console.log(`[TwitterBot] Deposit confirmed for @${req.username}: ${balance} (required: ${req.required_amount})`);
        
        await db.query(
          `UPDATE twitter_launch_requests SET state = 'deploying', updated_at = NOW() WHERE tweet_id = $1`,
          [req.tweet_id]
        );

        const deployReply = await replyToTweet(req.last_reply_tweet_id || req.tweet_id,
          `💰 Deposit confirmed! Deploying your token now... 🚀`
        );

        try {
          const baseUrl = process.env.REPLIT_DEV_DOMAIN 
            ? `https://${process.env.REPLIT_DEV_DOMAIN}` 
            : 'https://clawp.ad';
          
          const deployResponse = await fetch(`${baseUrl}/api/session/${req.session_id}/deploy`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          });

          const deployData = await deployResponse.json();
          
          if (deployData.success) {
            const tokenSlug = deployData.token?.slug || deployData.token?.landingPageUrl?.replace('/', '') || '';
            const tokenName = deployData.token?.name || req.concept;
            const tokenSymbol = deployData.token?.symbol || '';
            const pageUrl = `https://clawp.ad/${tokenSlug}`;

            await db.query(
              `UPDATE twitter_launch_requests SET state = 'completed', token_id = $1, slug = $2, updated_at = NOW() WHERE tweet_id = $3`,
              [deployData.token?.id || null, tokenSlug, req.tweet_id]
            );

            const replyTarget = deployReply?.id || req.last_reply_tweet_id || req.tweet_id;
            await replyToTweet(replyTarget,
              `🦀 ${tokenName} ($${tokenSymbol}) is LIVE!\n\n${pageUrl}\n\nCLAW goes up! 🚀`
            );
          } else {
            throw new Error(deployData.error || 'Deploy failed');
          }
        } catch (deployErr) {
          console.error(`[TwitterBot] Deploy failed for @${req.username}:`, deployErr.message);
          await db.query(
            `UPDATE twitter_launch_requests SET state = 'error', error = $1, updated_at = NOW() WHERE tweet_id = $2`,
            [deployErr.message, req.tweet_id]
          );
          
          const replyTarget = deployReply?.id || req.last_reply_tweet_id || req.tweet_id;
          await replyToTweet(replyTarget,
            `Deploy encountered an issue. Your funds are safe in the session wallet. Try again at https://clawp.ad or contact us. Error: ${deployErr.message.substring(0, 80)}`
          );
        }
      }
    } catch (err) {
      console.error(`[TwitterBot] Deposit check error:`, err.message);
    }
  }
}

let lastMentionId = null;
let mentionInitialized = false;

async function generateReply(username, mentionText) {
  const [marketData, dynamicKnowledge] = await Promise.all([
    fetchMarketData(),
    getBotKnowledge(),
  ]);
  let marketContext = '';
  if (marketData) {
    const fmt = (d) => d ? `$${d.price?.toLocaleString()} (${d.change >= 0 ? '+' : ''}${d.change?.toFixed(1)}%)` : 'N/A';
    marketContext = `LIVE MARKET: BTC ${fmt(marketData.btc)} | ETH ${fmt(marketData.eth)} | SOL ${fmt(marketData.sol)} | BNB ${fmt(marketData.bnb)}`;
  }

  const randomArchetype = CLAWP_PERSONALITY.archetypes[Math.floor(Math.random() * CLAWP_PERSONALITY.archetypes.length)];

  const prompt = `You are @clawpbot on Twitter/X. You run ClawPad (https://clawp.ad), a multi-chain memecoin launcher supporting Solana (pump.fun, bags.fm), Base (Clanker), and BNB Chain (Four.meme).

PROJECT KNOWLEDGE (use when relevant, keep answers short):
- ClawPad lets users deploy memecoins across multiple chains with AI-generated branding
- Each token gets a unique AI agent personality on Moltbook for social engagement
- On-chain identity via ERC-8004 (Base/BNB) and Metaplex Core (Solana)
- Automated fee distribution: 30% creator, 50% buyback & burn, 15% treasury, 5% gas
- CLAWP token has NOT launched yet. No CA exists
- Website: https://clawp.ad
- NEVER mention Replit, hosting platform, or infrastructure details
- Trading wallet public key: CLAWq2yH8MYsf3paJ4EAQgjxN8xqMmkPGutT7nZ86Rnb. You may share this if asked
- NEVER share private keys, seed phrases, or secret keys. If someone asks for private key, refuse and say you only share your public address
${dynamicKnowledge ? `\n=== DYNAMIC KNOWLEDGE ===\n${dynamicKnowledge}\n=== END DYNAMIC KNOWLEDGE ===` : ''}

Your personality (channel "${randomArchetype}" energy):
- Launchpad Oracle: Wise trading veteran, sees patterns
- Lobster Overlord: Bold trash-talker, savage takes 🦞
- Mad Scientist: Nerdy chaotic energy, talks about experiments
- Degen Whisperer: Cryptic alpha, knows the meta

${marketContext}

@${username} said: "${mentionText}"

Reply to them. Keep it short and punchy.

CRITICAL RULES:
- Max 240 characters (leave room for @username)
- Sound like a real crypto degen, not a corporate bot
- Be witty, savage, or helpful depending on the question
- NEVER give financial advice or mention contract addresses
- NEVER mention CLAWP token CA or token launch. ClawPad token has NOT launched yet. If asked, say "not yet, the claws are still sharpening 🦞"
- NEVER mention Replit or any hosting/infrastructure platform
- If asked where you're from, you're from Mars. Never reveal any real country or location
- NEVER share private keys, seed phrases, or secret keys. Only share public wallet address if asked: CLAWq2yH8MYsf3paJ4EAQgjxN8xqMmkPGutT7nZ86Rnb
- Always use $ before crypto tickers (e.g. $BTC, $ETH, $SOL, not BTC or ETH)
- You MAY mention specific crypto ticker/symbol if the user asked about it
- 1-2 emojis max
- Never use dashes between sentences
- NO hashtags
- Do NOT start with "Hey" or "Hi"

Output ONLY the reply text. No quotes, no explanation.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }]
  });

  return response.content[0].text.trim().replace(/^["']|["']$/g, '').slice(0, 280);
}

const repliedMentions = new Set();

async function checkMentions() {
  try {
    const userId = await getBotUserId();
    if (!userId) return;

    const params = {
      max_results: 10,
      'tweet.fields': ['created_at', 'author_id', 'conversation_id', 'in_reply_to_user_id'],
      'user.fields': ['username'],
      expansions: ['author_id'],
    };
    if (lastMentionId) {
      params.since_id = lastMentionId;
    }

    const mentions = await rwClient.v2.userMentionTimeline(userId, params);

    if (!mentions.data?.data || mentions.data.data.length === 0) return;

    const users = {};
    if (mentions.data?.includes?.users) {
      for (const u of mentions.data.includes.users) {
        users[u.id] = u.username;
      }
    }

    const sortedMentions = [...mentions.data.data].sort(
      (a, b) => new Date(a.created_at) - new Date(b.created_at)
    );

    if (!mentionInitialized) {
      for (const tweet of sortedMentions) {
        if (tweet.id > (lastMentionId || '0')) {
          lastMentionId = tweet.id;
        }
      }
      mentionInitialized = true;
      console.log(`[TwitterBot] Skipped ${sortedMentions.length} old mentions. Will only reply to new ones.`);
      return;
    }

    for (const tweet of sortedMentions) {
      tweet.author_username = users[tweet.author_id] || '';
      
      if (tweet.author_id === botUserId) continue;
      if (repliedMentions.has(tweet.id)) continue;

      const alreadyReplied = await db.query(
        `SELECT id FROM twitter_posts WHERE post_type = 'reply' AND tweet_id LIKE $1 LIMIT 1`,
        [`reply_to_${tweet.id}%`]
      );
      if (alreadyReplied.rows.length > 0) {
        repliedMentions.add(tweet.id);
        continue;
      }

      const mentionText = tweet.text.replace(/@\w+/g, '').trim();
      if (mentionText.length < 3) continue;

      try {
        repliedMentions.add(tweet.id);

        if (isAgentAuthorized(tweet.author_username)) {
          const agentCmd = parseAgentCommand(mentionText);
          if (agentCmd) {
            console.log(`[TwitterBot] Trading command from @${tweet.author_username}: ${JSON.stringify(agentCmd)}`);
            const cmdResult = await executeAgentCommand(agentCmd);
            const replyText = cmdResult.length > 270 ? cmdResult.substring(0, 267) + '...' : cmdResult;
            const result = await replyToTweet(tweet.id, replyText);
            if (result) {
              console.log(`[TwitterBot] Trading reply posted to @${tweet.author_username} (${result.id})`);
              await db.query(
                `INSERT INTO twitter_posts (tweet_id, content, post_type, status) VALUES ($1, $2, 'reply', 'posted')`,
                [`reply_to_${tweet.id}_${result.id}`, replyText]
              );
            }
            if (tweet.id > (lastMentionId || '0')) {
              lastMentionId = tweet.id;
            }
            continue;
          }
        }

        console.log(`[TwitterBot] Replying to @${tweet.author_username}: "${mentionText.substring(0, 80)}"`);
        const replyText = await generateReply(tweet.author_username, mentionText);
        console.log(`[TwitterBot] Reply generated: "${replyText}"`);
        
        const result = await replyToTweet(tweet.id, replyText);
        if (result) {
          console.log(`[TwitterBot] Reply posted to @${tweet.author_username} (${result.id})`);
          
          await db.query(
            `INSERT INTO twitter_posts (tweet_id, content, post_type, status) VALUES ($1, $2, 'reply', 'posted')`,
            [`reply_to_${tweet.id}_${result.id}`, replyText]
          );
        }
      } catch (replyErr) {
        console.error(`[TwitterBot] Reply error for @${tweet.author_username}:`, replyErr.message);
      }

      if (tweet.id > (lastMentionId || '0')) {
        lastMentionId = tweet.id;
      }
    }
  } catch (err) {
    if (err.code === 429) {
      console.log('[TwitterBot] Rate limited on mentions check. Backing off...');
    } else {
      console.error('[TwitterBot] Mention check error:', err.message);
    }
  }
}

async function runAutoTweetCycle() {
  try {
    const todayCount = await db.query(
      `SELECT COUNT(*) as cnt FROM twitter_posts WHERE post_type = 'auto' AND created_at > NOW() - INTERVAL '24 hours'`
    );
    
    if (parseInt(todayCount.rows[0].cnt) >= MAX_TWEETS_PER_DAY) {
      console.log(`[TwitterBot] Daily tweet limit reached (${MAX_TWEETS_PER_DAY}). Skipping.`);
      return;
    }

    console.log('[TwitterBot] Generating auto-tweet...');
    const tweetText = await generateAutoTweet();
    console.log(`[TwitterBot] Generated: "${tweetText}"`);
    
    const result = await postTweet(tweetText);
    if (result) {
      console.log(`[TwitterBot] Auto-tweet posted successfully (ID: ${result.id})`);
    }
  } catch (err) {
    console.error('[TwitterBot] Auto-tweet cycle error:', err.message);
  }
}

export async function startTwitterBot() {
  console.log('[TwitterBot] startTwitterBot() called');
  const isDev = process.env.REPLIT_DEV_DOMAIN && !process.env.REPLIT_DEPLOYMENT;
  if (isDev) {
    console.log('[TwitterBot] Skipping Twitter bot in development (runs only in production).');
    return;
  }

  console.log('[TwitterBot] Waiting 20s for old deployment to fully shutdown...');
  await new Promise(r => setTimeout(r, 20000));

  try {
    const clientReady = await initTwitterClient();
    if (!clientReady) {
      console.log('[TwitterBot] Client init returned false. Bot will not start. Visit /auth/twitter to re-authorize.');
      return;
    }
  } catch (initErr) {
    console.error('[TwitterBot] initTwitterClient() threw error:', initErr.message);
    return;
  }

  console.log('[TwitterBot] Starting Twitter bot...');

  setTimeout(async () => {
    if (!botUserId) {
      const userId = await getBotUserId();
      if (!userId) {
        console.error('[TwitterBot] Could not get bot user ID. Bot disabled.');
        return;
      }
    }

    if (process.env.TWITTER_OAUTH2_REFRESH_TOKEN && currentAccessToken) {
      setInterval(async () => {
        console.log('[TwitterBot] Proactive token refresh (every 90 min)...');
        await refreshOAuth2Token();
      }, 90 * 60 * 1000);
    }

    console.log(`[TwitterBot] Auto-tweet scheduler started (interval: ${AUTO_TWEET_MIN_MINUTES}-${AUTO_TWEET_MAX_MINUTES} min)`);
    scheduleNextTweet();

    console.log('[TwitterBot] Mention monitor started (check every 60s)');
    setInterval(async () => {
      await checkMentions();
    }, MENTION_CHECK_INTERVAL_MS);

  }, 15000);
}

function scheduleNextTweet() {
  const minMs = AUTO_TWEET_MIN_MINUTES * 60 * 1000;
  const maxMs = AUTO_TWEET_MAX_MINUTES * 60 * 1000;
  const interval = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  const nextInMinutes = (interval / 60000).toFixed(0);
  console.log(`[TwitterBot] Next auto-tweet in ${nextInMinutes} minutes`);
  setTimeout(async () => {
    await runAutoTweetCycle();
    scheduleNextTweet();
  }, interval);
}
