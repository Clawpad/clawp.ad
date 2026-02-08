import { ethers } from 'ethers';
import * as bnbWallet from './bnb-wallet.mjs';

const FOUR_MEME_API = 'https://four.meme/meme-api';
const TOKEN_MANAGER2_ADDRESS = '0x5c952063c7fc8610FFDB798152D69F0B9550762b';

const TOKEN_MANAGER2_ABI = [
  {
    inputs: [
      { name: 'createArg', type: 'bytes' },
      { name: 'signature', type: 'bytes' }
    ],
    name: 'createToken',
    outputs: [],
    stateMutability: 'payable',
    type: 'function'
  }
];

const TOKEN_CREATE_EVENT_TOPIC = ethers.id('TokenCreate(address,address,uint256,string,string,uint256,uint256,uint256)');

async function getNonce(accountAddress) {
  const res = await fetch(`${FOUR_MEME_API}/v1/private/user/nonce/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accountAddress,
      verifyType: 'LOGIN',
      networkCode: 'BSC'
    })
  });
  const data = await res.json();
  if (data.code !== '0' && data.code !== 0) {
    throw new Error(`Four.meme nonce failed: ${JSON.stringify(data)}`);
  }
  return data.data;
}

async function login(accountAddress, privateKey) {
  const nonce = await getNonce(accountAddress);
  const message = `You are sign in Meme ${nonce}`;
  const signature = await bnbWallet.signMessage(privateKey, message);

  const res = await fetch(`${FOUR_MEME_API}/v1/private/user/login/dex`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      region: 'WEB',
      langType: 'EN',
      loginIp: '',
      inviteCode: '',
      verifyInfo: {
        address: accountAddress,
        networkCode: 'BSC',
        signature,
        verifyType: 'LOGIN'
      },
      walletName: 'MetaMask'
    })
  });
  const data = await res.json();
  if (data.code !== '0' && data.code !== 0) {
    throw new Error(`Four.meme login failed: ${JSON.stringify(data)}`);
  }
  return data.data;
}

async function uploadImage(accessToken, imageBuffer) {
  const formData = new FormData();
  const blob = new Blob([imageBuffer], { type: 'image/png' });
  formData.append('file', blob, 'token-logo.png');

  const res = await fetch(`${FOUR_MEME_API}/v1/private/token/upload`, {
    method: 'POST',
    headers: {
      'meme-web-access': accessToken
    },
    body: formData
  });
  const data = await res.json();
  if (data.code !== '0' && data.code !== 0) {
    throw new Error(`Four.meme image upload failed: ${JSON.stringify(data)}`);
  }
  return data.data;
}

async function getRaisedTokenConfig() {
  try {
    const res = await fetch(`${FOUR_MEME_API}/v1/public/config`);
    const data = await res.json();
    if (data.code === '0' || data.code === 0) {
      const configs = data.data?.raisedTokens || data.data?.raisedTokenConfigs || [];
      const bnbConfig = configs.find(c => c.symbol === 'BNB' && c.networkCode === 'BSC');
      if (bnbConfig) return bnbConfig;
    }
  } catch (err) {
    console.warn('[FourMeme] Failed to fetch config, using defaults:', err.message);
  }
  return {
    symbol: 'BNB',
    nativeSymbol: 'BNB',
    symbolAddress: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
    deployCost: '0',
    buyFee: '0.01',
    sellFee: '0.01',
    minTradeFee: '0',
    b0Amount: '8',
    totalBAmount: '24',
    totalAmount: '1000000000',
    logoUrl: 'https://static.four.meme/market/68b871b6-96f7-408c-b8d0-388d804b34275092658264263839640.png',
    tradeLevel: ['0.1', '0.5', '1'],
    status: 'PUBLISH',
    buyTokenLink: 'https://pancakeswap.finance/swap',
    reservedNumber: 10,
    saleRate: '0.8',
    networkCode: 'BSC',
    platform: 'MEME'
  };
}

async function createTokenApi(accessToken, params) {
  const {
    name,
    symbol,
    description,
    imgUrl,
    label = 'Meme',
    preSale = '0',
    webUrl = '',
    twitterUrl = '',
    telegramUrl = '',
    taxConfig = null
  } = params;

  const raisedToken = await getRaisedTokenConfig();

  const launchTime = Date.now() + 60000;

  const isValidUrl = (url) => url && /^https:\/\/.{1,150}$/.test(url);

  const body = {
    name,
    shortName: symbol,
    symbol: 'BNB',
    desc: description,
    imgUrl,
    launchTime,
    label,
    lpTradingFee: 0.0025,
    totalSupply: 1000000000,
    raisedAmount: 24,
    saleRate: 0.8,
    reserveRate: 0,
    funGroup: false,
    clickFun: false,
    preSale,
    onlyMPC: false,
    feePlan: false,
    raisedToken
  };

  if (taxConfig && taxConfig.recipientAddress) {
    body.tokenTaxInfo = {
      feeRate: taxConfig.feeRate || 1,
      recipientAddress: taxConfig.recipientAddress,
      recipientRate: taxConfig.recipientRate || 100,
      burnRate: taxConfig.burnRate || 0,
      divideRate: taxConfig.divideRate || 0,
      liquidityRate: taxConfig.liquidityRate || 0,
      minSharing: taxConfig.minSharing || 100000
    };
    console.log(`[FourMeme] Tax enabled: ${body.tokenTaxInfo.feeRate}% fee, ${body.tokenTaxInfo.recipientRate}% to ${body.tokenTaxInfo.recipientAddress}`);
  }

  if (isValidUrl(webUrl)) body.webUrl = webUrl;
  if (isValidUrl(twitterUrl)) body.twitterUrl = twitterUrl;
  if (isValidUrl(telegramUrl)) body.telegramUrl = telegramUrl;

  const res = await fetch(`${FOUR_MEME_API}/v1/private/token/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'meme-web-access': accessToken
    },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  if (data.code !== '0' && data.code !== 0) {
    throw new Error(`Four.meme create token API failed: ${JSON.stringify(data)}`);
  }

  return {
    createArg: data.data.createArg,
    signature: data.data.signature
  };
}

async function submitCreateToken(privateKey, createArg, signature, creationFeeBNB = null) {
  if (!creationFeeBNB) {
    const config = await getRaisedTokenConfig();
    creationFeeBNB = config.deployCost || '0';
  }
  const wallet = await bnbWallet.getConnectedWallet(privateKey);

  const contract = new ethers.Contract(TOKEN_MANAGER2_ADDRESS, TOKEN_MANAGER2_ABI, wallet);

  const createArgBytes = ethers.getBytes(createArg);
  const signatureBytes = ethers.getBytes(signature);

  const value = ethers.parseEther(creationFeeBNB);

  console.log(`[FourMeme] Submitting createToken tx with ${creationFeeBNB} BNB fee...`);

  const tx = await contract.createToken(createArgBytes, signatureBytes, { value });
  console.log(`[FourMeme] TX submitted: ${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`[FourMeme] TX confirmed in block ${receipt.blockNumber}, gas used: ${receipt.gasUsed}`);

  let tokenAddress = null;
  for (const log of receipt.logs) {
    if (log.topics[0] === TOKEN_CREATE_EVENT_TOPIC) {
      const iface = new ethers.Interface([
        'event TokenCreate(address creator, address token, uint256 requestId, string name, string symbol, uint256 totalSupply, uint256 launchTime, uint256 launchFee)'
      ]);
      try {
        const parsed = iface.parseLog({ topics: log.topics, data: log.data });
        tokenAddress = parsed.args.token;
        console.log(`[FourMeme] Token created at: ${tokenAddress}`);
        break;
      } catch (e) {}
    }
  }

  if (!tokenAddress) {
    for (const log of receipt.logs) {
      try {
        const iface = new ethers.Interface([
          'event TokenCreate(address creator, address token, uint256 requestId, string name, string symbol, uint256 totalSupply, uint256 launchTime, uint256 launchFee)'
        ]);
        const parsed = iface.parseLog({ topics: log.topics, data: log.data });
        if (parsed && parsed.args.token) {
          tokenAddress = parsed.args.token;
          console.log(`[FourMeme] Token found via fallback parse: ${tokenAddress}`);
          break;
        }
      } catch (e) {}
    }
  }

  return {
    txHash: tx.hash,
    tokenAddress,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString()
  };
}

export async function deployToken(params) {
  const {
    name,
    symbol,
    description = '',
    imageBuffer = null,
    imageUrl = '',
    privateKey,
    label = 'Meme',
    webUrl = '',
    twitterUrl = '',
    telegramUrl = '',
    taxConfig = null
  } = params;

  const wallet = bnbWallet.walletFromPrivateKey(privateKey);
  const accountAddress = wallet.address;

  console.log(`[FourMeme] Deploying ${name} ($${symbol}) on BNB Chain...`);
  console.log(`[FourMeme] Wallet: ${accountAddress}`);

  const balance = await bnbWallet.getBalance(accountAddress);
  console.log(`[FourMeme] Balance: ${balance} BNB`);

  const config = await getRaisedTokenConfig();
  const deployCost = parseFloat(config.deployCost || '0');
  const estimatedGas = 0.001;
  const totalNeeded = deployCost + estimatedGas;
  console.log(`[FourMeme] Deploy cost from config: ${deployCost} BNB, est gas: ${estimatedGas} BNB, total needed: ${totalNeeded} BNB`);

  if (balance < totalNeeded) {
    throw new Error(`Insufficient BNB. Balance: ${balance} BNB, need at least ${totalNeeded} BNB (deploy: ${deployCost} + gas: ${estimatedGas}). Deposit more BNB to session wallet.`);
  }

  console.log('[FourMeme] Step 1: Logging in...');
  const accessToken = await login(accountAddress, privateKey);
  console.log('[FourMeme] Login successful');

  let imgUrl = imageUrl;
  if (imageBuffer && !imgUrl) {
    console.log('[FourMeme] Step 2: Uploading image...');
    imgUrl = await uploadImage(accessToken, imageBuffer);
    console.log(`[FourMeme] Image uploaded: ${imgUrl}`);
  }

  if (!imgUrl) {
    throw new Error('No image provided for Four.meme token');
  }

  console.log('[FourMeme] Step 3: Creating token via API...');
  const { createArg, signature } = await createTokenApi(accessToken, {
    name,
    symbol,
    description,
    imgUrl,
    label,
    webUrl,
    twitterUrl,
    telegramUrl,
    taxConfig
  });
  console.log('[FourMeme] API returned createArg and signature');

  console.log('[FourMeme] Step 4: Submitting on-chain transaction...');
  const result = await submitCreateToken(privateKey, createArg, signature);

  if (!result.tokenAddress) {
    throw new Error('Token created on-chain but could not parse token address from receipt');
  }

  console.log(`[FourMeme] Token deployed: ${result.tokenAddress}`);
  console.log(`[FourMeme] View: https://four.meme/token/${result.tokenAddress}`);

  return {
    contractAddress: result.tokenAddress,
    txHash: result.txHash,
    deployerAddress: accountAddress,
    imageUrl: imgUrl,
    fourMemeUrl: `https://four.meme/token/${result.tokenAddress}`,
    bscscanUrl: `https://bscscan.com/token/${result.tokenAddress}`
  };
}

const TAX_TOKEN_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'claimableFee',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'claimedFee',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [],
    name: 'claimFee',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [],
    name: 'founder',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [],
    name: 'feeRate',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [],
    name: 'quote',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [{ name: '', type: 'address' }],
    name: 'userInfo',
    outputs: [
      { name: 'share', type: 'uint256' },
      { name: 'rewardDebt', type: 'uint256' },
      { name: 'claimable', type: 'uint256' },
      { name: 'claimed', type: 'uint256' }
    ],
    stateMutability: 'view',
    type: 'function'
  }
];

export async function getClaimableTaxFees(tokenAddress, walletAddress) {
  try {
    const provider = await bnbWallet.getProvider();
    const contract = new ethers.Contract(tokenAddress, TAX_TOKEN_ABI, provider);
    const claimable = await contract.claimableFee(walletAddress);
    return parseFloat(ethers.formatEther(claimable));
  } catch (err) {
    console.error(`[FourMeme] Error checking claimable fees for ${tokenAddress}:`, err.message);
    return 0;
  }
}

export async function claimTaxFees(tokenAddress, privateKey) {
  try {
    const wallet = await bnbWallet.getConnectedWallet(privateKey);
    const contract = new ethers.Contract(tokenAddress, TAX_TOKEN_ABI, wallet);

    const claimable = await contract.claimableFee(wallet.address);
    if (claimable === 0n) {
      console.log(`[FourMeme] No claimable tax fees for ${tokenAddress}`);
      return null;
    }

    const claimableFormatted = parseFloat(ethers.formatEther(claimable));
    console.log(`[FourMeme] Claiming ${claimableFormatted} quote tokens from ${tokenAddress}...`);

    const tx = await contract.claimFee();
    const receipt = await tx.wait();

    console.log(`[FourMeme] Tax fees claimed, tx: ${receipt.hash}`);
    return {
      txHash: receipt.hash,
      amount: claimableFormatted
    };
  } catch (err) {
    console.error(`[FourMeme] Error claiming tax fees for ${tokenAddress}:`, err.message);
    return null;
  }
}

export async function getTokenTaxInfo(tokenAddress) {
  try {
    const provider = await bnbWallet.getProvider();
    const contract = new ethers.Contract(tokenAddress, TAX_TOKEN_ABI, provider);
    const [founder, feeRate] = await Promise.all([
      contract.founder().catch(() => null),
      contract.feeRate().catch(() => 0n)
    ]);
    return {
      founder,
      feeRate: Number(feeRate),
      isTaxToken: founder !== null && founder !== ethers.ZeroAddress
    };
  } catch (err) {
    return { founder: null, feeRate: 0, isTaxToken: false };
  }
}

export function getTokenUrl(contractAddress) {
  return `https://four.meme/token/${contractAddress}`;
}

export function getBscscanUrl(contractAddress) {
  return `https://bscscan.com/token/${contractAddress}`;
}

export default {
  deployToken,
  login,
  uploadImage,
  createTokenApi,
  submitCreateToken,
  getTokenUrl,
  getBscscanUrl,
  getRaisedTokenConfig,
  getClaimableTaxFees,
  claimTaxFees,
  getTokenTaxInfo,
  TOKEN_MANAGER2_ADDRESS,
  TAX_TOKEN_ABI
};
