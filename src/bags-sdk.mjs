import fetch from 'node-fetch';

const BAGS_API_BASE = 'https://api.bags.fm';

export class BagsSDK {
  constructor(apiKey = null) {
    this.apiKey = apiKey;
  }

  async createToken(params) {
    const { 
      name, 
      symbol, 
      description, 
      imageUrl, 
      creatorWallet,
      signedTransaction
    } = params;

    const response = await fetch(`${BAGS_API_BASE}/v1/tokens/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey && { 'Authorization': `Bearer ${this.apiKey}` })
      },
      body: JSON.stringify({
        name,
        symbol,
        description,
        image_url: imageUrl,
        creator_wallet: creatorWallet,
        signed_transaction: signedTransaction
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`bags.fm API error: ${error}`);
    }

    return response.json();
  }

  async getToken(mintAddress) {
    const response = await fetch(`${BAGS_API_BASE}/v1/tokens/${mintAddress}`);
    
    if (!response.ok) {
      return null;
    }

    return response.json();
  }

  async getAllClaimablePositions(walletAddress) {
    const response = await fetch(
      `${BAGS_API_BASE}/v1/fees/claimable?wallet=${walletAddress}`
    );

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    return data.positions || [];
  }

  async claimFees(walletAddress, tokenMint, signedTransaction) {
    const response = await fetch(`${BAGS_API_BASE}/v1/fees/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        wallet: walletAddress,
        token_mint: tokenMint,
        signed_transaction: signedTransaction
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`bags.fm claim error: ${error}`);
    }

    return response.json();
  }

  async getTokenStats(mintAddress) {
    const response = await fetch(`${BAGS_API_BASE}/v1/tokens/${mintAddress}/stats`);
    
    if (!response.ok) {
      return null;
    }

    return response.json();
  }
}

export function getTokenUrl(mintAddress) {
  return `https://bags.fm/token/${mintAddress}`;
}

export default BagsSDK;
