import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import crypto from 'crypto';
import bs58 from 'bs58';
import os from 'os';

const NUM_WORKERS = os.cpus().length;

function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).slice(-32);
  const privRaw = privateKey.export({ type: 'pkcs8', format: 'der' }).slice(-32);
  return { publicKey: pubRaw, privateKey: privRaw };
}

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
          attempts: totalAttempts + msg.localAttempts,
          elapsed
        }));
        
        workers.forEach(w => w.terminate());
        process.exit(0);
      }
    });
    
    worker.on('error', (err) => {
      console.error(`Worker ${i} error:`, err.message);
    });
    
    workers.push(worker);
  }
  
  const progressInterval = setInterval(() => {
    if (!found) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const rate = (totalAttempts / 1000000).toFixed(2);
      const perSec = elapsed > 0 ? Math.round(totalAttempts / parseInt(elapsed)) : 0;
      console.error(`[FastVanity] ${rate}M attempts (${elapsed}s, ${perSec.toLocaleString()}/s)`);
    }
  }, 5000);
  
  setTimeout(() => {
    if (!found) {
      clearInterval(progressInterval);
      console.error('[FastVanity] Timeout after 10 minutes');
      workers.forEach(w => w.terminate());
      process.exit(1);
    }
  }, 600000);
  
} else {
  const { suffix, workerId } = workerData;
  let attempts = 0;
  const reportInterval = 10000;
  
  while (true) {
    for (let i = 0; i < 100; i++) {
      attempts++;
      const { publicKey, privateKey } = generateKeypair();
      const pubBase58 = bs58.encode(publicKey);
      
      if (pubBase58.endsWith(suffix)) {
        const fullSecret = Buffer.concat([privateKey, publicKey]);
        
        parentPort.postMessage({ 
          type: 'found', 
          publicKey: pubBase58, 
          secretKey: bs58.encode(fullSecret),
          localAttempts: attempts
        });
        process.exit(0);
      }
    }
    
    if (attempts % reportInterval === 0) {
      parentPort.postMessage({ type: 'progress', attempts: reportInterval });
    }
  }
}
