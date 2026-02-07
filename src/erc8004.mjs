import { ethers } from 'ethers';

const REGISTRY_CHAIN = 'base';

const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const REPUTATION_REGISTRY = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';

const SCAN_BASE_URL = 'https://www.8004scan.io';
const BASE_EXPLORER = 'https://basescan.org';

const BASE_RPC_ENDPOINTS = [
  'https://mainnet.base.org',
  'https://base.llamarpc.com',
  'https://base-rpc.publicnode.com',
  'https://1rpc.io/base'
];

async function getProvider() {
  const customRpc = process.env.BASE_RPC_URL;
  if (customRpc) {
    return new ethers.JsonRpcProvider(customRpc);
  }

  for (const rpc of BASE_RPC_ENDPOINTS) {
    try {
      const provider = new ethers.JsonRpcProvider(rpc);
      await provider.getBlockNumber();
      console.log(`[ERC-8004] Connected to Base RPC: ${rpc}`);
      return provider;
    } catch (err) {
      console.warn(`[ERC-8004] RPC failed: ${rpc} - ${err.message}`);
    }
  }
  throw new Error('All Base RPC endpoints failed. Check network connectivity.');
}

const IDENTITY_REGISTRY_ABI = [
  'function register(string agentURI) external returns (uint256 agentId)',
  'function register() external returns (uint256 agentId)',
  'function setAgentURI(uint256 agentId, string newURI) external',
  'function tokenURI(uint256 tokenId) external view returns (string)',
  'function ownerOf(uint256 tokenId) external view returns (address)',
  'function balanceOf(address owner) external view returns (uint256)',
  'function getMetadata(uint256 agentId, string metadataKey) external view returns (bytes)',
  'function setMetadata(uint256 agentId, string metadataKey, bytes metadataValue) external',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
  'event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy)'
];

function getBaseUrl() {
  return 'https://openclaw.ai';
}

export function getRegistryChain() {
  return REGISTRY_CHAIN;
}

export function getRegistryAddress() {
  return IDENTITY_REGISTRY;
}

export function getScanUrl(agentNftId) {
  if (!agentNftId) return null;
  return `${SCAN_BASE_URL}/agents/base/${agentNftId}`;
}

export function getExplorerTxUrl(txHash) {
  return `${BASE_EXPLORER}/tx/${txHash}`;
}

export function buildAgentMetadata(token, agentSkill, options = {}) {
  const baseUrl = getBaseUrl();
  const venue = token.venue || 'pump.fun';

  let topics = [];
  try {
    topics = typeof agentSkill.topics === 'string' ? JSON.parse(agentSkill.topics) : (agentSkill.topics || []);
  } catch (e) {
    topics = [];
  }

  let quirks = [];
  try {
    quirks = typeof agentSkill.quirks === 'string' ? JSON.parse(agentSkill.quirks) : (agentSkill.quirks || []);
  } catch (e) {
    quirks = [];
  }

  const tokenChain = (venue === 'clanker') ? 'base' : (venue === 'four.meme') ? 'bnb' : 'solana';

  const platformUrls = {
    'pump.fun': `https://pump.fun/coin/${token.mint_address}`,
    'bags.fm': `https://bags.fm/token/${token.mint_address}`,
    'clanker': `https://clanker.world/clanker/${token.mint_address}`,
    'four.meme': `https://four.meme/token/${token.mint_address}`
  };

  const metadata = {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: token.name.toLowerCase().includes('ai') ? `${token.name} Agent` : `${token.name} AI Agent`,
    description: `${agentSkill.archetype} archetype AI agent for ${token.name} ($${token.symbol}). ${agentSkill.voice || ''}`.trim(),
    image: token.image_url || '',
    external_url: token.slug ? `${baseUrl}/${token.slug}` : '',
    services: [
      {
        name: 'web',
        endpoint: token.slug ? `${baseUrl}/${token.slug}` : '',
        version: '1.0'
      }
    ],
    active: true,
    registrations: [],
    supportedTrust: ['reputation']
  };

  if (topics.length > 0) {
    metadata.attributes = metadata.attributes || [];
    metadata.attributes.push({ trait_type: 'archetype', value: agentSkill.archetype });
    metadata.attributes.push({ trait_type: 'token_symbol', value: token.symbol });
    metadata.attributes.push({ trait_type: 'token_chain', value: tokenChain });
    metadata.attributes.push({ trait_type: 'launch_platform', value: venue });
    metadata.attributes.push({ trait_type: 'launcher', value: 'ClawPad' });
    metadata.attributes.push({ trait_type: 'registry_chain', value: 'base' });
    metadata.attributes.push({ trait_type: 'topics', value: topics.join(', ') });
  } else {
    metadata.attributes = [
      { trait_type: 'archetype', value: agentSkill.archetype },
      { trait_type: 'token_symbol', value: token.symbol },
      { trait_type: 'token_chain', value: tokenChain },
      { trait_type: 'launch_platform', value: venue },
      { trait_type: 'launcher', value: 'ClawPad' },
      { trait_type: 'registry_chain', value: 'base' }
    ];
  }

  if (quirks.length > 0) {
    metadata.attributes.push({ trait_type: 'quirks', value: quirks.join(', ') });
  }

  if (platformUrls[venue]) {
    metadata.services.push({
      name: 'TradingPlatform',
      endpoint: platformUrls[venue],
      version: '1.0'
    });
  }

  if (agentSkill.moltbook_username) {
    metadata.services.push({
      name: 'Moltbook',
      endpoint: `https://moltbook.com/@${agentSkill.moltbook_username}`,
      version: '1.0'
    });
  }

  return metadata;
}

export async function registerAgentOnChain(metadataUri, existingAgentId = null) {
  const privateKey = process.env.BASE_RELAYER_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('BASE_RELAYER_PRIVATE_KEY not configured');
  }

  const provider = await getProvider();
  const relayer = new ethers.Wallet(privateKey, provider);

  console.log(`[ERC-8004] Relayer wallet: ${relayer.address}`);
  console.log(`[ERC-8004] Registry: ${IDENTITY_REGISTRY}`);

  const balance = await provider.getBalance(relayer.address);
  const balanceEth = ethers.formatEther(balance);
  console.log(`[ERC-8004] Relayer balance: ${balanceEth} ETH`);

  if (balance === 0n) {
    throw new Error(`Relayer wallet has no ETH on Base. Fund address: ${relayer.address}`);
  }

  const registry = new ethers.Contract(IDENTITY_REGISTRY, IDENTITY_REGISTRY_ABI, relayer);

  if (existingAgentId) {
    console.log(`[ERC-8004] Agent #${existingAgentId} already registered, updating URI...`);
    const updateTx = await registry.setAgentURI(existingAgentId, metadataUri);
    console.log(`[ERC-8004] setAgentURI TX sent: ${updateTx.hash}`);
    const updateReceipt = await updateTx.wait();
    console.log(`[ERC-8004] URI updated! Gas: ${updateReceipt.gasUsed.toString()}`);

    return {
      txHash: updateTx.hash,
      agentNftId: existingAgentId.toString(),
      registrarWallet: relayer.address,
      scanUrl: getScanUrl(existingAgentId),
      explorerUrl: getExplorerTxUrl(updateTx.hash),
      gasUsed: updateReceipt.gasUsed.toString(),
      updated: true
    };
  }

  console.log(`[ERC-8004] Calling register(agentURI)...`);
  const tx = await registry['register(string)'](metadataUri);
  console.log(`[ERC-8004] TX sent: ${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`[ERC-8004] TX confirmed! Gas used: ${receipt.gasUsed.toString()}`);

  let agentNftId = null;
  try {
    const registeredTopic = registry.interface.getEvent('Registered').topicHash;
    const event = receipt.logs.find(log => log.topics[0] === registeredTopic);
    if (event) {
      const parsed = registry.interface.parseLog({ topics: event.topics, data: event.data });
      agentNftId = parsed.args.agentId.toString();
      console.log(`[ERC-8004] Agent NFT ID: ${agentNftId}`);
    }
  } catch (parseErr) {
    console.error('[ERC-8004] Could not parse agentId from logs:', parseErr.message);
  }

  return {
    txHash: tx.hash,
    agentNftId: agentNftId,
    registrarWallet: relayer.address,
    scanUrl: agentNftId ? getScanUrl(agentNftId) : null,
    explorerUrl: getExplorerTxUrl(tx.hash),
    gasUsed: receipt.gasUsed.toString()
  };
}

export async function getRelayerInfo() {
  const privateKey = process.env.BASE_RELAYER_PRIVATE_KEY;
  if (!privateKey) {
    return { configured: false, address: null, balance: null };
  }

  try {
    const provider = await getProvider();
    const wallet = new ethers.Wallet(privateKey, provider);
    const balance = await provider.getBalance(wallet.address);

    return {
      configured: true,
      address: wallet.address,
      balance: ethers.formatEther(balance)
    };
  } catch (err) {
    return { configured: true, address: null, balance: null, error: err.message };
  }
}

export function getRegistrationFee() {
  return 2.00;
}

export default {
  REGISTRY_CHAIN,
  IDENTITY_REGISTRY,
  REPUTATION_REGISTRY,
  IDENTITY_REGISTRY_ABI,
  SCAN_BASE_URL,
  getRegistryChain,
  getRegistryAddress,
  getScanUrl,
  getExplorerTxUrl,
  buildAgentMetadata,
  registerAgentOnChain,
  getRelayerInfo,
  getRegistrationFee
};
