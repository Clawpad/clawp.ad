import { spawn } from 'child_process';
import { mkdirSync, readFileSync, unlinkSync, readdirSync } from 'fs';
import path from 'path';

const suffix = process.argv[2] || 'CLAW';
const outputDir = '/tmp/vanity-grind';

mkdirSync(outputDir, { recursive: true });

const existingFiles = readdirSync(outputDir);
for (const f of existingFiles) {
  try { unlinkSync(path.join(outputDir, f)); } catch {}
}

console.error(`[VanityWorker] Starting solana-keygen grind for suffix "${suffix}"...`);
console.error(`[VanityWorker] Output dir: ${outputDir}`);

const startTime = Date.now();

const child = spawn('solana-keygen', [
  'grind',
  '--ends-with', `${suffix}:1`,
  '--num-threads', '6'
], { 
  cwd: outputDir,
  stdio: ['ignore', 'pipe', 'pipe'] 
});

let lastSearched = 0;

child.stdout.on('data', (data) => {
  const text = data.toString();
  console.error(text.trim());
});

child.stderr.on('data', (data) => {
  const text = data.toString();
  
  const searchMatch = text.match(/Searched (\d+) keypairs/);
  if (searchMatch) {
    const searched = parseInt(searchMatch[1]);
    if (searched !== lastSearched) {
      lastSearched = searched;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const rate = (searched / (elapsed || 1)).toFixed(0);
      console.error(`[VanityWorker] ${searched.toLocaleString()} keypairs searched (${elapsed}s, ${rate}/s)`);
    }
  }
  
  if (text.includes('Wrote keypair to')) {
    console.error(text.trim());
  }
});

child.on('close', (code) => {
  const elapsed = (Date.now() - startTime) / 1000;
  
  if (code === 0) {
    const files = readdirSync(outputDir).filter(f => f.endsWith('.json'));
    
    if (files.length > 0) {
      const keypairFile = path.join(outputDir, files[0]);
      const publicKey = files[0].replace('.json', '');
      
      try {
        const keypairData = JSON.parse(readFileSync(keypairFile, 'utf8'));
        const secretKeyBytes = new Uint8Array(keypairData);
        
        const secretKeyHex = Buffer.from(secretKeyBytes).toString('hex');
        
        unlinkSync(keypairFile);
        
        const result = {
          publicKey,
          secretKey: secretKeyHex,
          elapsed,
          attempts: lastSearched
        };
        
        console.log(JSON.stringify(result));
        process.exit(0);
      } catch (parseErr) {
        console.error(`[VanityWorker] Error parsing keypair: ${parseErr.message}`);
        process.exit(1);
      }
    } else {
      console.error('[VanityWorker] No keypair file found');
      process.exit(1);
    }
  } else {
    console.error(`[VanityWorker] solana-keygen exited with code ${code}`);
    process.exit(1);
  }
});

child.on('error', (err) => {
  console.error(`[VanityWorker] Error: ${err.message}`);
  process.exit(1);
});

process.on('SIGTERM', () => {
  child.kill('SIGTERM');
});

process.on('SIGINT', () => {
  child.kill('SIGINT');
});
