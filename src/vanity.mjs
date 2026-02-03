import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { fileURLToPath } from 'url';
import os from 'os';

const DEFAULT_SUFFIX = 'CLAW';
const NUM_WORKERS = Math.max(os.cpus().length - 1, 2);

function grindForSuffix(suffix, maxAttempts = Infinity) {
  let attempts = 0;
  const start = Date.now();
  
  while (attempts < maxAttempts) {
    attempts++;
    const keypair = Keypair.generate();
    const publicKey = keypair.publicKey.toBase58();
    
    if (publicKey.endsWith(suffix)) {
      return {
        publicKey,
        secretKey: bs58.encode(keypair.secretKey),
        attempts
      };
    }
    
    if (attempts % 500000 === 0) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      console.log(`[Vanity] Progress: ${(attempts/1000000).toFixed(1)}M attempts (${elapsed}s)`);
    }
  }
  
  return null;
}

export async function generateVanityWallet(suffix = DEFAULT_SUFFIX, timeoutMs = 300000) {
  console.log(`[Vanity] Searching for address ending with "${suffix}"...`);
  console.log(`[Vanity] Using ${NUM_WORKERS} worker threads`);
  console.log(`[Vanity] Timeout: ${timeoutMs / 1000}s`);
  
  const startTime = Date.now();
  
  return new Promise((resolve, reject) => {
    const workers = [];
    let found = false;
    let totalAttempts = 0;
    
    const cleanup = () => {
      workers.forEach(w => {
        try { w.terminate(); } catch {}
      });
    };
    
    const timeout = setTimeout(() => {
      if (!found) {
        cleanup();
        reject(new Error(`Vanity address generation timed out after ${timeoutMs / 1000}s`));
      }
    }, timeoutMs);
    
    for (let i = 0; i < NUM_WORKERS; i++) {
      const worker = new Worker(new URL(import.meta.url), {
        workerData: { suffix, workerId: i }
      });
      
      worker.on('message', (result) => {
        if (found) return;
        
        if (result.type === 'progress') {
          totalAttempts += result.attempts;
        } else if (result.type === 'found') {
          found = true;
          clearTimeout(timeout);
          cleanup();
          
          const elapsed = (Date.now() - startTime) / 1000;
          console.log(`[Vanity] Found address in ${elapsed.toFixed(2)}s after ${totalAttempts.toLocaleString()} attempts!`);
          console.log(`[Vanity] Address: ${result.publicKey}`);
          
          resolve({
            publicKey: result.publicKey,
            secretKey: result.secretKey,
            attempts: totalAttempts,
            elapsed
          });
        }
      });
      
      worker.on('error', (err) => {
        console.error(`[Vanity] Worker ${i} error:`, err);
      });
      
      workers.push(worker);
    }
  });
}

export function generateVanityWalletSync(suffix = DEFAULT_SUFFIX, maxAttempts = 5000000) {
  console.log(`[Vanity] Searching for address ending with "${suffix}" (sync mode)...`);
  const startTime = Date.now();
  
  const result = grindForSuffix(suffix, maxAttempts);
  
  if (result) {
    const elapsed = (Date.now() - startTime) / 1000;
    console.log(`[Vanity] Found in ${elapsed.toFixed(2)}s after ${result.attempts.toLocaleString()} attempts`);
    console.log(`[Vanity] Address: ${result.publicKey}`);
    return {
      ...result,
      elapsed
    };
  }
  
  throw new Error(`Could not find vanity address after ${maxAttempts.toLocaleString()} attempts`);
}

if (!isMainThread) {
  const { suffix } = workerData;
  let attempts = 0;
  
  while (true) {
    attempts++;
    const keypair = Keypair.generate();
    const publicKey = keypair.publicKey.toBase58();
    
    if (publicKey.endsWith(suffix)) {
      parentPort.postMessage({
        type: 'found',
        publicKey,
        secretKey: bs58.encode(keypair.secretKey)
      });
      break;
    }
    
    if (attempts % 100000 === 0) {
      parentPort.postMessage({ type: 'progress', attempts: 100000 });
      attempts = 0;
    }
  }
}

export default {
  generateVanityWallet,
  generateVanityWalletSync,
  DEFAULT_SUFFIX
};
