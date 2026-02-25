import fetch from 'node-fetch';
import { VersionedTransaction } from '@solana/web3.js';
import * as solana from './solana.mjs';

const JUPITER_QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';
const JUPITER_SWAP_URL = 'https://lite-api.jup.ag/swap/v1/swap';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

export async function getSwapQuote(inputMint, outputMint, amountLamports, slippageBps = 100) {
  const url = `${JUPITER_QUOTE_URL}?` +
    `inputMint=${inputMint}` +
    `&outputMint=${outputMint}` +
    `&amount=${amountLamports}` +
    `&slippageBps=${slippageBps}` +
    `&restrictIntermediateTokens=true`;

  const response = await fetch(url);
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Jupiter quote error (${response.status}): ${error}`);
  }

  return response.json();
}

export async function getSwapTransaction(quoteResponse, userPublicKey) {
  const response = await fetch(JUPITER_SWAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: 'auto'
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Jupiter swap error (${response.status}): ${error}`);
  }

  return response.json();
}

export async function buyTokenWithSol(keypair, tokenMint, solAmount, slippageBps = 150) {
  const amountLamports = Math.floor(solAmount * 1e9);
  
  console.log(`[Jupiter] Getting quote: ${solAmount} SOL → ${tokenMint}`);
  const quote = await getSwapQuote(SOL_MINT, tokenMint, amountLamports, slippageBps);
  
  console.log(`[Jupiter] Quote received: ${quote.outAmount} tokens expected`);
  
  const swapResponse = await getSwapTransaction(quote, keypair.publicKey.toBase58());
  
  const swapTxBuf = Buffer.from(swapResponse.swapTransaction, 'base64');
  const transaction = VersionedTransaction.deserialize(swapTxBuf);
  
  transaction.sign([keypair]);
  
  const connection = solana.getConnection();
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: true,
    maxRetries: 3
  });
  
  console.log(`[Jupiter] Swap tx sent: ${signature}`);
  
  await connection.confirmTransaction(signature, 'confirmed');
  console.log(`[Jupiter] Swap confirmed`);
  
  return {
    signature,
    expectedTokens: quote.outAmount,
    priceImpact: quote.priceImpactPct
  };
}

export default {
  getSwapQuote,
  getSwapTransaction,
  buyTokenWithSol,
  SOL_MINT
};
