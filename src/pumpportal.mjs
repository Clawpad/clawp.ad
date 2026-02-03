import WebSocket from 'ws';

const PUMPPORTAL_WS_URL = 'wss://pumpportal.fun/api/data';
const PUMPPORTAL_API_URL = 'https://pumpportal.fun/api';
const PUMPFUN_IPFS_URL = 'https://pump.fun/api/ipfs';

let wsConnection = null;
let wsReconnectTimeout = null;
let messageHandler = null;
const subscribers = new Map();
const tokenSubscriptions = new Set();
const walletSubscriptions = new Set();

function resubscribeAll() {
  if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN) return;
  
  wsConnection.send(JSON.stringify({ method: 'subscribeNewToken' }));
  wsConnection.send(JSON.stringify({ method: 'subscribeMigration' }));
  
  if (tokenSubscriptions.size > 0) {
    wsConnection.send(JSON.stringify({
      method: 'subscribeTokenTrade',
      keys: Array.from(tokenSubscriptions)
    }));
  }
  
  if (walletSubscriptions.size > 0) {
    wsConnection.send(JSON.stringify({
      method: 'subscribeAccountTrade',
      keys: Array.from(walletSubscriptions)
    }));
  }
}

export function connectWebSocket(onMessage) {
  if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
    return wsConnection;
  }
  
  messageHandler = onMessage;
  wsConnection = new WebSocket(PUMPPORTAL_WS_URL);
  
  wsConnection.on('open', () => {
    console.log('[PumpPortal] WebSocket connected');
    resubscribeAll();
  });
  
  wsConnection.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      if (messageHandler) messageHandler(message);
      
      for (const [key, callback] of subscribers) {
        callback(message);
      }
    } catch (error) {
      console.error('[PumpPortal] Error parsing message:', error);
    }
  });
  
  wsConnection.on('close', () => {
    console.log('[PumpPortal] WebSocket closed, reconnecting in 5s...');
    wsConnection = null;
    clearTimeout(wsReconnectTimeout);
    wsReconnectTimeout = setTimeout(() => connectWebSocket(messageHandler), 5000);
  });
  
  wsConnection.on('error', (error) => {
    console.error('[PumpPortal] WebSocket error:', error.message);
  });
  
  return wsConnection;
}

export function subscribeToToken(tokenMint) {
  tokenSubscriptions.add(tokenMint);
  if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
    wsConnection.send(JSON.stringify({
      method: 'subscribeTokenTrade',
      keys: [tokenMint]
    }));
  }
}

export function subscribeToWallet(walletAddress) {
  walletSubscriptions.add(walletAddress);
  if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
    wsConnection.send(JSON.stringify({
      method: 'subscribeAccountTrade',
      keys: [walletAddress]
    }));
  }
}

export function unsubscribeFromToken(tokenMint) {
  tokenSubscriptions.delete(tokenMint);
  if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
    wsConnection.send(JSON.stringify({
      method: 'unsubscribeTokenTrade',
      keys: [tokenMint]
    }));
  }
}

export function unsubscribeFromWallet(walletAddress) {
  walletSubscriptions.delete(walletAddress);
  if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
    wsConnection.send(JSON.stringify({
      method: 'unsubscribeAccountTrade',
      keys: [walletAddress]
    }));
  }
}

export function addSubscriber(key, callback) {
  subscribers.set(key, callback);
}

export function removeSubscriber(key) {
  subscribers.delete(key);
}

export async function uploadToIPFS(imageBuffer, metadata) {
  const FormData = (await import('form-data')).default;
  const fetch = (await import('node-fetch')).default;
  
  const formData = new FormData();
  formData.append('file', imageBuffer, {
    filename: 'token.png',
    contentType: 'image/png'
  });
  formData.append('name', metadata.name);
  formData.append('symbol', metadata.symbol);
  formData.append('description', metadata.description || '');
  formData.append('twitter', metadata.twitter || '');
  formData.append('telegram', metadata.telegram || '');
  formData.append('website', metadata.website || '');
  formData.append('showName', 'true');
  
  const response = await fetch(PUMPFUN_IPFS_URL, {
    method: 'POST',
    body: formData,
    headers: formData.getHeaders()
  });
  
  if (!response.ok) {
    throw new Error(`IPFS upload failed: ${response.statusText}`);
  }
  
  return await response.json();
}

export async function createTokenTransaction(params) {
  const fetch = (await import('node-fetch')).default;
  
  const response = await fetch(`${PUMPPORTAL_API_URL}/trade-local`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey: params.publicKey,
      action: 'create',
      tokenMetadata: {
        name: params.name,
        symbol: params.symbol,
        uri: params.metadataUri
      },
      mint: params.mintPublicKey,
      denominatedInSol: 'true',
      amount: params.initialBuyAmount || 0,
      slippage: params.slippage || 10,
      priorityFee: params.priorityFee || 0.0005,
      pool: 'pump'
    })
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token creation failed: ${error}`);
  }
  
  return Buffer.from(await response.arrayBuffer());
}

export async function buyTokenTransaction(params) {
  const fetch = (await import('node-fetch')).default;
  
  const response = await fetch(`${PUMPPORTAL_API_URL}/trade-local`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey: params.publicKey,
      action: 'buy',
      mint: params.mintAddress,
      denominatedInSol: 'true',
      amount: params.solAmount,
      slippage: params.slippage || 10,
      priorityFee: params.priorityFee || 0.0005,
      pool: 'auto'
    })
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Buy transaction failed: ${error}`);
  }
  
  return Buffer.from(await response.arrayBuffer());
}

export async function sellTokenTransaction(params) {
  const fetch = (await import('node-fetch')).default;
  
  const response = await fetch(`${PUMPPORTAL_API_URL}/trade-local`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey: params.publicKey,
      action: 'sell',
      mint: params.mintAddress,
      denominatedInSol: 'false',
      amount: params.tokenAmount,
      slippage: params.slippage || 10,
      priorityFee: params.priorityFee || 0.0005,
      pool: 'auto'
    })
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Sell transaction failed: ${error}`);
  }
  
  return Buffer.from(await response.arrayBuffer());
}

export function closeWebSocket() {
  if (wsConnection) {
    wsConnection.close();
    wsConnection = null;
  }
  clearTimeout(wsReconnectTimeout);
  tokenSubscriptions.clear();
  walletSubscriptions.clear();
}

export default {
  connectWebSocket,
  subscribeToToken,
  subscribeToWallet,
  unsubscribeFromToken,
  unsubscribeFromWallet,
  addSubscriber,
  removeSubscriber,
  uploadToIPFS,
  createTokenTransaction,
  buyTokenTransaction,
  sellTokenTransaction,
  closeWebSocket
};
