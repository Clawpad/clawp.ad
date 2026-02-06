import { createPublicClient, createWalletClient, http } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { Clanker } from 'clanker-sdk/v4';
import * as baseWallet from './base-wallet.mjs';

const CLANKER_FEE_LOCKER = '0xF3622742b1E446D92e45E22923Ef11C2fcD55D68';
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';
const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD';

// From https://clanker.gitbook.io/clanker-documentation/references/core-contracts/v4/fee-management-contracts/clankerfeelocker
// claim(address feeOwner, address token) - callable by anyone, transfers available fees to the recipient
// availableFees(address feeOwner, address token) - view function to return the amount of fees available
// NOTE: the 'token' parameter is the token being CLAIMED (e.g. WETH), NOT the token generating the fees
const FEE_LOCKER_ABI = [
  {
    inputs: [
      { name: 'feeOwner', type: 'address' },
      { name: 'token', type: 'address' }
    ],
    name: 'availableFees',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [
      { name: 'feeOwner', type: 'address' },
      { name: 'token', type: 'address' }
    ],
    name: 'claim',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  }
];

const ERC20_ABI = [
  {
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    name: 'transfer',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  }
];

function getBaseRpcUrl() {
  return process.env.BASE_RPC_URL || 'https://mainnet.base.org';
}

function getViemClients(privateKey) {
  const account = privateKeyToAccount(privateKey);
  const rpcUrl = getBaseRpcUrl();

  const publicClient = createPublicClient({
    chain: base,
    transport: http(rpcUrl)
  });

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(rpcUrl)
  });

  return { account, publicClient, walletClient };
}

export async function deployToken(params) {
  const {
    name,
    symbol,
    description = '',
    imageUrl = '',
    socialMediaUrls = [],
    rewardRecipient = null,
    privateKey = null
  } = params;

  if (!privateKey) {
    throw new Error('Private key is required for token deployment. User must deposit ETH to session wallet.');
  }
  const deployKey = privateKey;

  const { account, publicClient, walletClient } = getViemClients(deployKey);

  console.log(`[Clanker] Deploying token ${name} ($${symbol}) via SDK...`);
  console.log(`[Clanker] Deployer wallet: ${account.address}`);

  const balance = await publicClient.getBalance({ address: account.address });
  const balanceEth = Number(balance) / 1e18;
  console.log(`[Clanker] Wallet balance: ${balanceEth.toFixed(6)} ETH`);

  const minRequired = 0.0003;
  if (balanceEth < minRequired) {
    throw new Error(`Insufficient ETH on Base. Balance: ${balanceEth.toFixed(6)} ETH, need at least ${minRequired} ETH for gas. Deposit more ETH to session wallet.`);
  }

  const gasPrice = await publicClient.getGasPrice();
  const estimatedGasCost = Number(gasPrice * 500000n) / 1e18;
  console.log(`[Clanker] Estimated gas cost: ${estimatedGasCost.toFixed(6)} ETH (gasPrice: ${Number(gasPrice) / 1e9} gwei)`);

  if (balanceEth < estimatedGasCost * 1.5) {
    throw new Error(`ETH balance (${balanceEth.toFixed(6)}) may be too low for deploy gas (est: ${estimatedGasCost.toFixed(6)} ETH). Consider depositing more.`);
  }

  const clanker = new Clanker({
    publicClient,
    wallet: walletClient
  });

  const recipient = rewardRecipient || account.address;

  // Deploy config per SDK v4.0.0 docs:
  // https://clanker.gitbook.io/clanker-documentation/sdk/v4.0.0
  // https://clanker.gitbook.io/clanker-documentation/general/creator-rewards-and-fees
  const deployConfig = {
    name: name,
    symbol: symbol,
    tokenAdmin: account.address,
    metadata: {
      description: description,
      socialMediaUrls: socialMediaUrls,
    },
    context: {
      interface: 'ClawPad',
    },
    fees: {
      type: 'static',
      clankerFee: 100,
      pairedFee: 100,
    },
    rewards: {
      recipients: [
        {
          recipient: recipient,
          admin: account.address,
          bps: 10_000,
          token: 'Paired'
        }
      ]
    }
  };

  if (imageUrl && (imageUrl.startsWith('http') || imageUrl.startsWith('ipfs://'))) {
    deployConfig.image = imageUrl;
  }

  console.log('[Clanker] Sending deploy transaction...');
  const { txHash, waitForTransaction, error } = await clanker.deploy(deployConfig);

  if (error) {
    console.error('[Clanker] Deploy error:', error);
    throw new Error(`Clanker deploy failed: ${error.message || error}`);
  }

  console.log(`[Clanker] Deploy TX sent: ${txHash}`);

  const result = await waitForTransaction();

  if (result.error) {
    throw new Error(`Clanker deploy tx failed: ${result.error.message || result.error}`);
  }

  console.log(`[Clanker] Token deployed at: ${result.address}`);
  console.log(`[Clanker] View: https://clanker.world/clanker/${result.address}`);

  return {
    contractAddress: result.address,
    txHash: txHash,
    deployerAddress: account.address,
    rewardRecipient: recipient,
    clankerUrl: `https://clanker.world/clanker/${result.address}`,
    basescanUrl: `https://basescan.org/token/${result.address}`
  };
}

export async function getUnclaimedFees(tokenAddress, recipientAddress) {
  const { publicClient } = getViemClients(process.env.BASE_RELAYER_PRIVATE_KEY);

  try {
    const wethFees = await publicClient.readContract({
      address: CLANKER_FEE_LOCKER,
      abi: FEE_LOCKER_ABI,
      functionName: 'availableFees',
      args: [recipientAddress, WETH_ADDRESS]
    });

    const tokenFees = await publicClient.readContract({
      address: CLANKER_FEE_LOCKER,
      abi: FEE_LOCKER_ABI,
      functionName: 'availableFees',
      args: [recipientAddress, tokenAddress]
    });

    return {
      wethAmount: Number(wethFees) / 1e18,
      tokenAmount: Number(tokenFees) / 1e18,
      wethRaw: wethFees.toString(),
      tokenRaw: tokenFees.toString()
    };
  } catch (err) {
    console.error(`[Clanker] Error checking fees for ${tokenAddress}:`, err.message);
    return { wethAmount: 0, tokenAmount: 0, wethRaw: '0', tokenRaw: '0' };
  }
}

export async function claimFees(tokenAddress, recipientAddress) {
  const privateKey = process.env.BASE_RELAYER_PRIVATE_KEY;
  if (!privateKey) throw new Error('BASE_RELAYER_PRIVATE_KEY not configured');

  const { account, publicClient, walletClient } = getViemClients(privateKey);

  console.log(`[Clanker] Claiming WETH fees for token ${tokenAddress}...`);

  // availableFees: check how much WETH is available for this recipient
  const wethFees = await publicClient.readContract({
    address: CLANKER_FEE_LOCKER,
    abi: FEE_LOCKER_ABI,
    functionName: 'availableFees',
    args: [recipientAddress, WETH_ADDRESS]
  });

  if (wethFees === 0n) {
    console.log('[Clanker] No WETH fees to claim');
    return null;
  }

  const wethAmount = Number(wethFees) / 1e18;
  console.log(`[Clanker] WETH fees available: ${wethAmount.toFixed(8)} WETH`);

  // claim: callable by anyone, transfers fees to the designated recipient
  const hash = await walletClient.writeContract({
    address: CLANKER_FEE_LOCKER,
    abi: FEE_LOCKER_ABI,
    functionName: 'claim',
    args: [recipientAddress, WETH_ADDRESS]
  });

  console.log(`[Clanker] Claim TX: ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`[Clanker] Claim confirmed! Gas: ${receipt.gasUsed}`);

  return {
    txHash: hash,
    wethClaimed: wethAmount,
    gasUsed: receipt.gasUsed.toString()
  };
}

export async function claimTokenFees(tokenAddress, recipientAddress) {
  const privateKey = process.env.BASE_RELAYER_PRIVATE_KEY;
  if (!privateKey) throw new Error('BASE_RELAYER_PRIVATE_KEY not configured');

  const { account, publicClient, walletClient } = getViemClients(privateKey);

  const tokenFees = await publicClient.readContract({
    address: CLANKER_FEE_LOCKER,
    abi: FEE_LOCKER_ABI,
    functionName: 'availableFees',
    args: [recipientAddress, tokenAddress]
  });

  if (tokenFees === 0n) {
    return null;
  }

  const hash = await walletClient.writeContract({
    address: CLANKER_FEE_LOCKER,
    abi: FEE_LOCKER_ABI,
    functionName: 'claim',
    args: [recipientAddress, tokenAddress]
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  return {
    txHash: hash,
    tokensClaimed: Number(tokenFees) / 1e18,
    gasUsed: receipt.gasUsed.toString()
  };
}

export async function burnTokens(tokenAddress, amount) {
  const privateKey = process.env.BASE_RELAYER_PRIVATE_KEY;
  if (!privateKey) throw new Error('BASE_RELAYER_PRIVATE_KEY not configured');

  const { account, publicClient, walletClient } = getViemClients(privateKey);

  console.log(`[Clanker] Burning ${amount} tokens of ${tokenAddress}...`);

  const balance = await publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account.address]
  });

  if (balance === 0n) {
    console.log('[Clanker] No tokens to burn');
    return null;
  }

  const hash = await walletClient.writeContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [BURN_ADDRESS, balance]
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`[Clanker] Burn TX confirmed: ${hash}`);

  return {
    txHash: hash,
    tokensBurned: Number(balance) / 1e18,
    gasUsed: receipt.gasUsed.toString()
  };
}

export function getTokenUrl(contractAddress) {
  return `https://clanker.world/clanker/${contractAddress}`;
}

export function getAdminUrl(contractAddress) {
  return `https://clanker.world/clanker/${contractAddress}/admin`;
}

export function getBasescanUrl(contractAddress) {
  return `https://basescan.org/token/${contractAddress}`;
}

export default {
  deployToken,
  getUnclaimedFees,
  claimFees,
  claimTokenFees,
  burnTokens,
  getTokenUrl,
  getAdminUrl,
  getBasescanUrl,
  CLANKER_FEE_LOCKER,
  WETH_ADDRESS,
  BURN_ADDRESS
};
