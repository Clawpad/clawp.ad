import * as db from './db.mjs';
import { encrypt } from './crypto.mjs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const POOL_CONFIG = {
  targetSize: 100,
  minThreshold: 10,
  checkIntervalMs: 60000,
  suffix: 'CLAW',
  startDelayMs: 5000
};

let isGenerating = false;
let generatedCount = 0;

function generateOneAddressAsync() {
  return new Promise((resolve, reject) => {
    console.log(`[VanityPool] Spawning worker to find address ending with ${POOL_CONFIG.suffix}...`);
    
    const workerPath = path.join(__dirname, 'vanity-worker.mjs');
    const child = spawn('nice', ['-n', '19', 'node', workerPath, POOL_CONFIG.suffix], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    
    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    child.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) console.log(msg);
    });
    
    child.on('close', async (code) => {
      if (code === 0 && stdout.trim()) {
        try {
          const result = JSON.parse(stdout.trim());
          const encryptedSecretKey = encrypt(result.secretKey);
          
          await db.addVanityAddress(
            result.publicKey,
            encryptedSecretKey,
            result.attempts,
            result.elapsed
          );
          
          generatedCount++;
          console.log(`[VanityPool] Added address to pool: ${result.publicKey}`);
          const elapsedStr = result.elapsed ? result.elapsed.toFixed(2) : '?';
          const attemptsStr = result.attempts ? result.attempts.toLocaleString() : '?';
          console.log(`[VanityPool] Generated in ${elapsedStr}s (${attemptsStr} attempts)`);
          console.log(`[VanityPool] Total generated this session: ${generatedCount}`);
          
          resolve(true);
        } catch (err) {
          console.error('[VanityPool] Parse error:', err.message);
          reject(err);
        }
      } else {
        reject(new Error(`Worker exited with code ${code}`));
      }
    });
    
    child.on('error', (err) => {
      console.error('[VanityPool] Worker spawn error:', err.message);
      reject(err);
    });
  });
}

async function replenishPool() {
  if (isGenerating) {
    console.log('[VanityPool] Already generating, skipping...');
    return;
  }
  
  try {
    const stats = await db.getVanityPoolStats();
    console.log(`[VanityPool] Pool status: ${stats.available} available, ${stats.reserved} reserved, ${stats.used} used`);
    
    if (stats.available >= POOL_CONFIG.targetSize) {
      console.log('[VanityPool] Pool is full, no generation needed');
      return;
    }
    
    if (stats.available < POOL_CONFIG.minThreshold) {
      console.log(`[VanityPool] Pool below threshold (${stats.available}/${POOL_CONFIG.minThreshold}), starting generation...`);
    }
    
    isGenerating = true;
    
    const needed = POOL_CONFIG.targetSize - stats.available;
    console.log(`[VanityPool] Need to generate ${needed} addresses`);
    
    for (let i = 0; i < needed; i++) {
      const currentStats = await db.getVanityPoolStats();
      if (currentStats.available >= POOL_CONFIG.targetSize) {
        console.log('[VanityPool] Pool is now full');
        break;
      }
      
      console.log(`[VanityPool] Generating address ${i + 1}/${needed}...`);
      try {
        await generateOneAddressAsync();
      } catch (genErr) {
        console.error('[VanityPool] Generation failed:', genErr.message);
      }
    }
    
  } catch (error) {
    console.error('[VanityPool] Replenish error:', error.message);
  } finally {
    isGenerating = false;
  }
}

let poolInterval = null;

export function startPoolManager() {
  console.log('[VanityPool] Starting pool manager...');
  console.log(`[VanityPool] Target size: ${POOL_CONFIG.targetSize}, Min threshold: ${POOL_CONFIG.minThreshold}`);
  console.log(`[VanityPool] Check interval: ${POOL_CONFIG.checkIntervalMs / 1000}s`);
  console.log(`[VanityPool] Generation will start after ${POOL_CONFIG.startDelayMs / 1000}s delay...`);
  
  setTimeout(() => {
    console.log('[VanityPool] Starting initial pool check...');
    replenishPool();
  }, POOL_CONFIG.startDelayMs);
  
  poolInterval = setInterval(replenishPool, POOL_CONFIG.checkIntervalMs);
  
  return poolInterval;
}

export function stopPoolManager() {
  if (poolInterval) {
    clearInterval(poolInterval);
    poolInterval = null;
    console.log('[VanityPool] Pool manager stopped');
  }
}

export async function getPoolStatus() {
  const stats = await db.getVanityPoolStats();
  return {
    ...stats,
    targetSize: POOL_CONFIG.targetSize,
    minThreshold: POOL_CONFIG.minThreshold,
    isGenerating,
    generatedThisSession: generatedCount
  };
}

export function triggerGeneration() {
  if (!isGenerating) {
    replenishPool();
  }
}

export default {
  startPoolManager,
  stopPoolManager,
  getPoolStatus,
  triggerGeneration,
  POOL_CONFIG
};
