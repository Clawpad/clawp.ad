import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, VersionedTransaction, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { createBurnInstruction, getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';

const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;

let connection = null;

export function getConnection() {
  if (!connection) {
    if (!process.env.HELIUS_API_KEY) {
      throw new Error('HELIUS_API_KEY environment variable is not set');
    }
    connection = new Connection(HELIUS_RPC_URL, 'confirmed');
  }
  return connection;
}

export function generateWallet() {
  const keypair = Keypair.generate();
  return {
    publicKey: keypair.publicKey.toBase58(),
    secretKey: bs58.encode(keypair.secretKey)
  };
}

export function generateVanityWalletSync(suffix = 'CLAW', maxAttempts = 50000000) {
  let attempts = 0;
  const startTime = Date.now();
  
  console.log(`[Vanity] Searching for mint address ending with "${suffix}"...`);
  
  while (attempts < maxAttempts) {
    attempts++;
    const keypair = Keypair.generate();
    const publicKey = keypair.publicKey.toBase58();
    
    if (publicKey.endsWith(suffix)) {
      const elapsed = (Date.now() - startTime) / 1000;
      console.log(`[Vanity] FOUND in ${elapsed.toFixed(2)}s after ${attempts.toLocaleString()} attempts!`);
      console.log(`[Vanity] Mint Address: ${publicKey}`);
      return {
        publicKey,
        secretKey: bs58.encode(keypair.secretKey),
        keypair,
        attempts,
        elapsed
      };
    }
    
    if (attempts % 500000 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`[Vanity] Progress: ${(attempts/1000000).toFixed(1)}M attempts (${elapsed}s)`);
    }
  }
  
  throw new Error(`Could not find vanity address after ${maxAttempts.toLocaleString()} attempts`);
}

export function keypairFromSecretKey(secretKeyBase58) {
  const secretKey = bs58.decode(secretKeyBase58);
  return Keypair.fromSecretKey(secretKey);
}

export function keypairFromHexSecretKey(secretKeyHex) {
  const secretKey = Buffer.from(secretKeyHex, 'hex');
  return Keypair.fromSecretKey(new Uint8Array(secretKey));
}

export async function getBalance(publicKeyString) {
  const conn = getConnection();
  const publicKey = new PublicKey(publicKeyString);
  const balance = await conn.getBalance(publicKey);
  return balance / LAMPORTS_PER_SOL;
}

export async function getRecentDepositSender(walletAddress) {
  try {
    const conn = getConnection();
    const pubkey = new PublicKey(walletAddress);
    const signatures = await conn.getSignaturesForAddress(pubkey, { limit: 5 });
    
    for (const sig of signatures) {
      const tx = await conn.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx?.meta || tx.meta.err) continue;
      
      const preBalance = tx.meta.preBalances[0];
      const postBalance = tx.meta.postBalances[0];
      
      if (postBalance > preBalance) {
        const senderKey = tx.transaction.message.accountKeys[0];
        const sender = typeof senderKey === 'string' ? senderKey : senderKey.pubkey?.toBase58();
        if (sender && sender !== walletAddress) {
          return sender;
        }
      }
    }
    return null;
  } catch (error) {
    console.error('[Solana] Error getting deposit sender:', error.message);
    return null;
  }
}

export async function waitForDeposit(publicKeyString, requiredAmount = 0.025, timeoutMs = 1800000, abortSignal = null) {
  const startTime = Date.now();
  const baseInterval = 5000;
  const maxInterval = 30000;
  let currentInterval = baseInterval;
  let retryCount = 0;
  const maxRetries = 3;
  
  while (Date.now() - startTime < timeoutMs) {
    if (abortSignal?.aborted) {
      return { success: false, balance: 0, aborted: true };
    }
    
    try {
      const balance = await getBalance(publicKeyString);
      retryCount = 0;
      currentInterval = baseInterval;
      
      if (balance >= requiredAmount) {
        return { success: true, balance };
      }
    } catch (error) {
      retryCount++;
      console.error(`[Solana] Balance check error (attempt ${retryCount}):`, error.message);
      
      if (retryCount >= maxRetries) {
        currentInterval = Math.min(currentInterval * 2, maxInterval);
        retryCount = 0;
      }
    }
    
    await new Promise(resolve => setTimeout(resolve, currentInterval));
  }
  
  return { success: false, balance: 0, timeout: true };
}

export async function signAndSendTransaction(transactionBytes, signerKeypairs, maxRetries = 3) {
  const conn = getConnection();
  
  const transaction = VersionedTransaction.deserialize(transactionBytes);
  transaction.sign(signerKeypairs);
  
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const signature = await conn.sendTransaction(transaction, {
        skipPreflight: false,
        preflightCommitment: 'confirmed'
      });
      
      const confirmation = await conn.confirmTransaction(signature, 'confirmed');
      
      if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }
      
      return signature;
    } catch (error) {
      lastError = error;
      console.error(`[Solana] Transaction attempt ${attempt} failed:`, error.message);
      
      if (attempt < maxRetries) {
        const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    }
  }
  
  throw lastError;
}

export async function getTokenBalance(walletAddress, tokenMint) {
  const conn = getConnection();
  const wallet = new PublicKey(walletAddress);
  const mint = new PublicKey(tokenMint);
  
  try {
    const tokenAccounts = await conn.getParsedTokenAccountsByOwner(wallet, { mint });
    if (tokenAccounts.value.length > 0) {
      return tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
    }
    return 0;
  } catch (error) {
    console.error('Error getting token balance:', error);
    return 0;
  }
}

export function isValidSolanaAddress(address) {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

export async function burnTokens(walletKeypair, tokenMint, amount) {
  const conn = getConnection();
  const mint = new PublicKey(tokenMint);
  
  const tokenAccounts = await conn.getParsedTokenAccountsByOwner(walletKeypair.publicKey, { mint });
  if (tokenAccounts.value.length === 0) {
    throw new Error('No token account found for this mint');
  }
  
  const tokenAccount = tokenAccounts.value[0];
  const tokenAccountAddress = tokenAccount.pubkey;
  const tokenInfo = tokenAccount.account.data.parsed.info;
  const rawAmount = BigInt(tokenInfo.tokenAmount.amount);
  
  if (rawAmount <= 0n) {
    throw new Error('No tokens to burn');
  }
  
  const tokenProgramId = tokenAccount.account.owner;
  console.log(`[Burn] Using token program: ${tokenProgramId.toString()}`);
  
  const { createBurnInstruction: createBurn } = await import('@solana/spl-token');
  
  const burnInstruction = createBurn(
    tokenAccountAddress,
    mint,
    walletKeypair.publicKey,
    rawAmount,
    [],
    tokenProgramId
  );
  
  const transaction = new Transaction().add(burnInstruction);
  
  const signature = await sendAndConfirmTransaction(conn, transaction, [walletKeypair], {
    commitment: 'confirmed'
  });
  
  return signature;
}

export async function transferSOL(fromKeypair, toAddress, amountSOL) {
  const conn = getConnection();
  const toPubkey = new PublicKey(toAddress);
  
  const { SystemProgram } = await import('@solana/web3.js');
  
  const lamports = Math.floor(amountSOL * LAMPORTS_PER_SOL);
  
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: fromKeypair.publicKey,
      toPubkey,
      lamports
    })
  );
  
  const { blockhash } = await conn.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = fromKeypair.publicKey;
  
  const signature = await sendAndConfirmTransaction(conn, transaction, [fromKeypair]);
  return signature;
}

export default {
  getConnection,
  generateWallet,
  generateVanityWalletSync,
  keypairFromSecretKey,
  keypairFromHexSecretKey,
  getBalance,
  getRecentDepositSender,
  waitForDeposit,
  signAndSendTransaction,
  getTokenBalance,
  isValidSolanaAddress,
  burnTokens,
  transferSOL
};
