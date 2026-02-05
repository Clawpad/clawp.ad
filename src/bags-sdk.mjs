import { BagsSDK, signAndSendTransaction, createTipTransaction, sendBundleAndConfirm, waitForSlotsToPass, BAGS_FEE_SHARE_V2_MAX_CLAIMERS_NON_LUT } from '@bagsfm/bags-sdk';
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, VersionedTransaction } from '@solana/web3.js';
import * as solana from './solana.mjs';

const FALLBACK_JITO_TIP_LAMPORTS = 0.015 * LAMPORTS_PER_SOL;

let sdkInstance = null;

export function getSDK() {
  if (!sdkInstance) {
    const apiKey = process.env.BAGS_API_KEY;
    if (!apiKey) {
      throw new Error('BAGS_API_KEY environment variable is not set');
    }
    const connection = solana.getConnection();
    sdkInstance = new BagsSDK(apiKey, connection, 'processed');
  }
  return sdkInstance;
}

async function sendBundleWithTip(sdk, unsignedTransactions, keypair) {
  const commitment = sdk.state.getCommitment();
  const connection = solana.getConnection();
  const bundleBlockhash = unsignedTransactions[0]?.message.recentBlockhash;

  if (!bundleBlockhash) {
    throw new Error('Bundle transactions must have a blockhash');
  }

  let jitoTip = FALLBACK_JITO_TIP_LAMPORTS;

  const recommendedJitoTip = await sdk.solana.getJitoRecentFees().catch((err) => {
    console.log('[bags] Failed to get Jito fees, using fallback:', err.message);
    return null;
  });

  if (recommendedJitoTip?.landed_tips_95th_percentile) {
    jitoTip = Math.floor(recommendedJitoTip.landed_tips_95th_percentile * LAMPORTS_PER_SOL);
  }
  console.log(`[bags] Jito tip: ${jitoTip / LAMPORTS_PER_SOL} SOL`);

  const tipTransaction = await createTipTransaction(connection, commitment, keypair.publicKey, jitoTip, {
    blockhash: bundleBlockhash,
  });

  const signedTransactions = [tipTransaction, ...unsignedTransactions].map((tx) => {
    tx.sign([keypair]);
    return tx;
  });

  console.log(`[bags] Sending bundle via Jito...`);
  const bundleId = await sendBundleAndConfirm(signedTransactions, sdk);
  console.log(`[bags] Bundle confirmed! ID: ${bundleId}`);
  return bundleId;
}

async function getOrCreateFeeShareConfig(sdk, tokenMint, creatorWallet, keypair, feeClaimers) {
  const commitment = sdk.state.getCommitment();
  const connection = solana.getConnection();

  let additionalLookupTables;

  if (feeClaimers.length > BAGS_FEE_SHARE_V2_MAX_CLAIMERS_NON_LUT) {
    console.log(`[bags] Creating lookup tables for ${feeClaimers.length} fee claimers...`);

    const lutResult = await sdk.config.getConfigCreationLookupTableTransactions({
      payer: creatorWallet,
      baseMint: tokenMint,
      feeClaimers: feeClaimers,
    });

    if (!lutResult) {
      throw new Error('Failed to create lookup table transactions');
    }

    await signAndSendTransaction(connection, commitment, lutResult.creationTransaction, keypair);
    await waitForSlotsToPass(connection, commitment, 1);

    for (const extendTx of lutResult.extendTransactions) {
      await signAndSendTransaction(connection, commitment, extendTx, keypair);
    }

    additionalLookupTables = lutResult.lutAddresses;
    console.log('[bags] Lookup tables created successfully!');
  }

  const configResult = await sdk.config.createBagsFeeShareConfig({
    payer: creatorWallet,
    baseMint: tokenMint,
    feeClaimers: feeClaimers,
    additionalLookupTables: additionalLookupTables,
  });

  console.log('[bags] Creating fee share config...');

  if (configResult.bundles && configResult.bundles.length > 0) {
    for (const bundle of configResult.bundles) {
      await sendBundleWithTip(sdk, bundle, keypair);
    }
  }

  for (const tx of configResult.transactions || []) {
    await signAndSendTransaction(connection, commitment, tx, keypair);
  }

  console.log('[bags] Fee share config created successfully!');
  return configResult.meteoraConfigKey;
}

export async function createToken(params) {
  const { name, symbol, description, imageUrl, keypair, initialBuySol = 0 } = params;
  
  const sdk = getSDK();
  const connection = solana.getConnection();
  const commitment = sdk.state.getCommitment();

  console.log(`[bags] Creating token $${symbol} with wallet ${keypair.publicKey.toBase58()}`);

  console.log('[bags] Step 1: Creating token info and metadata...');
  const tokenInfoResponse = await sdk.tokenLaunch.createTokenInfoAndMetadata({
    imageUrl,
    name,
    description,
    symbol: symbol.toUpperCase().replace('$', ''),
  });

  console.log('[bags] Token mint:', tokenInfoResponse.tokenMint);

  const tokenMint = new PublicKey(tokenInfoResponse.tokenMint);

  console.log('[bags] Step 2: Creating fee share config...');
  const feeClaimers = [{ user: keypair.publicKey, userBps: 10000 }];
  
  const configKey = await getOrCreateFeeShareConfig(
    sdk,
    tokenMint,
    keypair.publicKey,
    keypair,
    feeClaimers
  );

  console.log('[bags] Config Key:', configKey.toString());

  console.log('[bags] Step 3: Creating token launch transaction...');
  const metadataUri = tokenInfoResponse.metadataUri || tokenInfoResponse.ipfs || tokenInfoResponse.uri;
  console.log('[bags] Metadata URI:', metadataUri);
  
  const tokenLaunchTxResponse = await sdk.tokenLaunch.createLaunchTransaction({
    tokenMint: tokenMint,
    launchWallet: keypair.publicKey,
    configKey: configKey,
    ipfs: metadataUri,
    initialBuyLamports: Math.floor(initialBuySol * LAMPORTS_PER_SOL),
  });

  console.log('[bags] Step 4: Signing and sending transaction...');
  
  const launchTx = tokenLaunchTxResponse.transaction;
  launchTx.sign([keypair]);
  
  const signature = await connection.sendRawTransaction(launchTx.serialize(), {
    skipPreflight: true,
    maxRetries: 3,
  });
  
  await connection.confirmTransaction(signature, 'confirmed');
  console.log('[bags] Token launch confirmed:', signature);

  return {
    mintAddress: tokenInfoResponse.tokenMint,
    signature,
    metadataUri: tokenInfoResponse.metadataUri,
  };
}

export async function getToken(mintAddress) {
  const sdk = getSDK();
  try {
    const tokenMint = new PublicKey(mintAddress);
    const creators = await sdk.state.getTokenCreators(tokenMint);
    return { creators };
  } catch (err) {
    return null;
  }
}

export async function getAllClaimablePositions(walletAddress) {
  const sdk = getSDK();
  try {
    const wallet = new PublicKey(walletAddress);
    const positions = await sdk.fees.getClaimablePositions(wallet);
    return positions || [];
  } catch (err) {
    console.error('[bags] Error getting claimable positions:', err.message);
    return [];
  }
}

export async function claimFees(keypair, tokenMint) {
  const sdk = getSDK();
  const connection = solana.getConnection();
  const commitment = sdk.state.getCommitment();
  
  try {
    const claimTx = await sdk.fees.createClaimTransaction({
      wallet: keypair.publicKey,
      tokenMint: new PublicKey(tokenMint),
    });
    
    if (!claimTx) {
      return null;
    }
    
    claimTx.sign([keypair]);
    
    const signature = await connection.sendRawTransaction(claimTx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });
    
    await connection.confirmTransaction(signature, 'confirmed');
    return signature;
  } catch (err) {
    console.error('[bags] Error claiming fees:', err.message);
    return null;
  }
}

export function getTokenUrl(mintAddress) {
  return `https://bags.fm/token/${mintAddress}`;
}

export default {
  getSDK,
  createToken,
  getToken,
  getAllClaimablePositions,
  claimFees,
  getTokenUrl,
};
