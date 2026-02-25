const DEXSCREENER_API = 'https://api.dexscreener.com/latest/dex';

export async function getTopSolanaTokens(limit = 10) {
  try {
    const res = await fetch(`https://api.dexscreener.com/token-boosts/top/v1`);
    if (!res.ok) {
      console.warn(`[SolAgent] DexScreener boost API failed: ${res.status}`);
      return await getTopByVolume(limit);
    }

    const data = await res.json();
    const solanaTokens = data
      .filter(t => t.chainId === 'solana' && t.tokenAddress)
      .slice(0, limit * 2);

    if (solanaTokens.length === 0) {
      return await getTopByVolume(limit);
    }

    const detailed = [];
    for (const token of solanaTokens) {
      try {
        const pairRes = await fetch(`${DEXSCREENER_API}/tokens/${token.tokenAddress}`);
        if (!pairRes.ok) continue;
        const pairData = await pairRes.json();
        const pair = pairData.pairs?.[0];
        if (!pair) continue;

        const liq = parseFloat(pair.liquidity?.usd || 0);
        const vol = parseFloat(pair.volume?.h24 || 0);
        const mc = parseFloat(pair.marketCap || 0);

        if (liq < 10000 || vol < 5000) continue;

        detailed.push({
          tokenAddress: token.tokenAddress,
          name: pair.baseToken?.name || 'Unknown',
          symbol: pair.baseToken?.symbol || '???',
          priceUsd: parseFloat(pair.priceUsd || 0),
          priceNative: parseFloat(pair.priceNative || 0),
          change24h: parseFloat(pair.priceChange?.h24 || 0),
          change1h: parseFloat(pair.priceChange?.h1 || 0),
          volume24h: vol,
          liquidity: liq,
          marketCap: mc,
          pairAddress: pair.pairAddress,
        });

        if (detailed.length >= limit) break;
      } catch (err) {
        continue;
      }
    }

    console.log(`[SolAgent] Fetched ${detailed.length} top Solana tokens from DexScreener`);
    return detailed;
  } catch (err) {
    console.error('[SolAgent] DexScreener fetch error:', err.message);
    return [];
  }
}

async function getTopByVolume(limit = 10) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=SOL`);
    if (!res.ok) return [];
    const data = await res.json();

    const tokens = (data.pairs || [])
      .filter(p => p.chainId === 'solana' && parseFloat(p.liquidity?.usd || 0) > 10000)
      .sort((a, b) => parseFloat(b.volume?.h24 || 0) - parseFloat(a.volume?.h24 || 0))
      .slice(0, limit)
      .map(p => ({
        tokenAddress: p.baseToken?.address,
        name: p.baseToken?.name || 'Unknown',
        symbol: p.baseToken?.symbol || '???',
        priceUsd: parseFloat(p.priceUsd || 0),
        priceNative: parseFloat(p.priceNative || 0),
        change24h: parseFloat(p.priceChange?.h24 || 0),
        change1h: parseFloat(p.priceChange?.h1 || 0),
        volume24h: parseFloat(p.volume?.h24 || 0),
        liquidity: parseFloat(p.liquidity?.usd || 0),
        marketCap: parseFloat(p.marketCap || 0),
        pairAddress: p.pairAddress,
      }));

    console.log(`[SolAgent] Fetched ${tokens.length} Solana tokens by volume`);
    return tokens;
  } catch (err) {
    console.error('[SolAgent] Volume fetch error:', err.message);
    return [];
  }
}

export async function getTokenPrice(tokenAddress) {
  try {
    const res = await fetch(`${DEXSCREENER_API}/tokens/${tokenAddress}`);
    if (!res.ok) return null;
    const data = await res.json();
    const pair = data.pairs?.[0];
    if (!pair) return null;

    return {
      priceUsd: parseFloat(pair.priceUsd || 0),
      priceNative: parseFloat(pair.priceNative || 0),
      change24h: parseFloat(pair.priceChange?.h24 || 0),
      liquidity: parseFloat(pair.liquidity?.usd || 0),
      name: pair.baseToken?.name || 'Unknown',
      symbol: pair.baseToken?.symbol || '???',
    };
  } catch (err) {
    console.error(`[SolAgent] Price fetch error for ${tokenAddress}:`, err.message);
    return null;
  }
}
