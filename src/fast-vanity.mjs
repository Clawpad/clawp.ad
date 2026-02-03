import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import os from 'os';

const NUM_WORKERS = os.cpus().length;

if (isMainThread) {
  const suffix = process.argv[2] || 'CLAW';
  const startTime = Date.now();
  let totalAttempts = 0;
  let found = false;
  
  console.error(`[FastVanity] Starting ${NUM_WORKERS} workers for suffix "${suffix}"...`);
  
  const workers = [];
  
  for (let i = 0; i < NUM_WORKERS; i++) {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { suffix, workerId: i }
    });
    
    worker.on('message', (msg) => {
      if (msg.type === 'progress') {
        totalAttempts += msg.attempts;
      } else if (msg.type === 'found' && !found) {
        found = true;
        const elapsed = (Date.now() - startTime) / 1000;
        
        console.log(JSON.stringify({
          publicKey: msg.publicKey,
          secretKey: msg.secretKey,
          attempts: totalAttempts + msg.attempts,
          elapsed
        }));
        
        workers.forEach(w => w.terminate());
        process.exit(0);
      }
    });
    
    worker.on('error', (err) => {
      console.error(`Worker ${i} error:`, err);
    });
    
    workers.push(worker);
  }
  
  const progressInterval = setInterval(() => {
    if (!found) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const rate = (totalAttempts / 1000000).toFixed(2);
      console.error(`[FastVanity] Progress: ${rate}M attempts (${elapsed}s)`);
    }
  }, 10000);
  
  setTimeout(() => {
    if (!found) {
      console.error('[FastVanity] Timeout after 10 minutes');
      workers.forEach(w => w.terminate());
      process.exit(1);
    }
  }, 600000);
  
} else {
  const { suffix, workerId } = workerData;
  let attempts = 0;
  const reportInterval = 100000;
  
  while (true) {
    for (let i = 0; i < 10000; i++) {
      attempts++;
      const keypair = Keypair.generate();
      const publicKey = keypair.publicKey.toBase58();
      
      if (publicKey.endsWith(suffix)) {
        const secretKey = bs58.encode(keypair.secretKey);
        parentPort.postMessage({ type: 'found', publicKey, secretKey, attempts });
        process.exit(0);
      }
    }
    
    if (attempts % reportInterval === 0) {
      parentPort.postMessage({ type: 'progress', attempts: reportInterval });
    }
  }
}
