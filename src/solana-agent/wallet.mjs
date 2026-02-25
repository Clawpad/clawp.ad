import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import * as db from '../db.mjs';
import { encrypt, decrypt } from '../crypto.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function generateCLAWWalletViaWorker() {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, 'claw-wallet-worker.mjs');
    console.log('[SolAgent] Spawning CLAW wallet worker...');

    const child = spawn('nice', ['-n', '19', 'node', workerPath], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      if (text.includes('keypairs searched') || text.includes('CLAWWorker')) {
        console.log(text.trim());
      }
    });

    child.on('close', (code) => {
      if (code === 0 && stdout.trim()) {
        try {
          const result = JSON.parse(stdout.trim());
          console.log(`[SolAgent] CLAW wallet generated: ${result.publicKey} (${result.elapsed?.toFixed(1)}s)`);
          resolve(result);
        } catch (err) {
          reject(new Error(`Failed to parse worker output: ${err.message}`));
        }
      } else {
        reject(new Error(`Worker exited with code ${code}: ${stderr.substring(0, 200)}`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Worker spawn error: ${err.message}`));
    });

    setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('CLAW wallet generation timed out after 5 minutes'));
    }, 5 * 60 * 1000);
  });
}

function hexToBase58(hexKey) {
  const bytes = Buffer.from(hexKey, 'hex');
  const keypair = Keypair.fromSecretKey(new Uint8Array(bytes));
  return bs58.encode(keypair.secretKey);
}

export async function getOrCreateAgentWallet() {
  const existing = await db.query(
    `SELECT public_key, encrypted_private_key FROM agent_wallets WHERE name = 'trading' AND chain = 'solana' LIMIT 1`
  );

  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    console.log(`[SolAgent] Using existing wallet: ${row.public_key}`);
    return {
      publicKey: row.public_key,
      secretKey: decrypt(row.encrypted_private_key),
    };
  }

  if (process.env.AGENT_WALLET_PUBLIC_KEY && process.env.AGENT_WALLET_PRIVATE_KEY) {
    const pubKey = process.env.AGENT_WALLET_PUBLIC_KEY;
    const privKey = process.env.AGENT_WALLET_PRIVATE_KEY;
    console.log(`[SolAgent] Using wallet from env vars: ${pubKey}`);

    const encryptedKey = encrypt(privKey);
    await db.query(
      `INSERT INTO agent_wallets (name, public_key, encrypted_private_key, chain, created_at)
       VALUES ('trading', $1, $2, 'solana', NOW())
       ON CONFLICT (name, chain) DO UPDATE SET public_key = $1, encrypted_private_key = $2`,
      [pubKey, encryptedKey]
    );

    return { publicKey: pubKey, secretKey: privKey };
  }

  console.log('[SolAgent] No existing wallet found. Generating CLAW wallet via solana-keygen...');
  const result = await generateCLAWWalletViaWorker();

  const secretKeyBase58 = hexToBase58(result.secretKey);
  const encryptedKey = encrypt(secretKeyBase58);

  await db.query(
    `INSERT INTO agent_wallets (name, public_key, encrypted_private_key, chain, created_at)
     VALUES ('trading', $1, $2, 'solana', NOW())
     ON CONFLICT (name, chain) DO UPDATE SET public_key = $1, encrypted_private_key = $2`,
    [result.publicKey, encryptedKey]
  );

  console.log(`[SolAgent] New CLAW trading wallet created: ${result.publicKey}`);
  return {
    publicKey: result.publicKey,
    secretKey: secretKeyBase58,
  };
}

export function keypairFromSecret(secretKeyBase58) {
  return Keypair.fromSecretKey(bs58.decode(secretKeyBase58));
}
