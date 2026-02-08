# Solana AI Identity System Architecture

## Executive Summary

The **Solana AI Identity** system mints on-chain identity NFTs for AI Agents deployed via **pump.fun** and **bags.fm**. Uses **Metaplex Core** NFTs with metadata on Arweave. This is a **parallel** system (not a replacement) to ERC-8004 on EVM chains (Base/BNB).

Both identity systems are **automatic** during token deployment. A manual fallback exists for tokens deployed before auto-registration was enabled.

---

## 1. Identity Standards by Chain

### EVM Identity (ERC-8004) Live

| Chain | Standard | Registry Contract | Gas Payer | Status |
|-------|----------|-------------------|-----------|--------|
| **Base** | ERC-8004 | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | Session wallet (Clanker) | LIVE, Auto |
| **BNB Chain** | ERC-8004 | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | Session wallet (Four.meme) | LIVE, Auto |

**How it works:**
- Each chain registers on its **native chain** (no cross-chain relayer needed)
- Clanker tokens: `register(agentURI)` on Base, session wallet pays ETH gas
- Four.meme tokens: `register(agentURI)` on BNB Chain, session wallet pays BNB gas
- `setAgentURI(id, uri)` updates metadata without re-minting
- Same contract address on all chains (deployed via CREATE2)
- Viewable on **8004scan.io** (supports Base and BNB paths)
