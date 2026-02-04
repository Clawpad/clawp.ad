---
name: clawp-agent
description: Launch tokens on pump.fun and spawn AI agents for Moltbook in one flow. Every token gets a unique AI personality (10 archetypes). Use when user wants to create a token with Moltbook presence, deploy to pump.fun, generate AI logos, use vanity CLAW addresses, or set up buyback-burn.
license: MIT
metadata:
  author: clawpad
  version: "1.0.0"
  openclaw:
    emoji: "🦀"
    requires:
      apis: ["anthropic", "openai", "helius", "pumpportal"]
      config: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "HELIUS_API_KEY", "PUMPPORTAL_API_KEY"]
---

# CLAWP Agent Skill

## Purpose

Autonomous memecoin launcher on Solana. Converts natural language token ideas into live tokens on pump.fun mainnet with zero manual intervention after deposit.

## When to Use

- User wants to launch a token on pump.fun
- User needs AI-generated token branding (name, symbol, logo)
- User wants vanity mint addresses (ending in "CLAW")
- User needs autonomous post-launch tokenomics
- User asks about buyback & burn mechanics

## Capabilities

| Feature | Description |
|---------|-------------|
| Chat-to-Token | Describe idea → AI generates blueprint |
| AI Logos | 3 unique options per launch via gpt-image-1 |
| Vanity Minting | Pre-generated CLAW suffix addresses |
| Mainnet Deploy | IPFS upload → PumpPortal → Helius broadcast |
| Buyback & Burn | Auto 60% burn of creator fees every 5min |
| Landing Pages | Auto-generated at /{slug} with dynamic theming |
| **AI Agent Personalities** | Each token gets unique Moltbook-ready agent |
| **Moltbook Integration** | Claim & activate agents on AI social network |

## Quick Start

### Via Chat
```
1. Visit https://clawp.ad/app
2. Describe token idea: "a crab-themed meme token for DeFi degens"
3. AI generates blueprint and 3 logo options
4. Select logo, deposit 0.025 SOL
5. Token deploys automatically
```

### Via API
```bash
# Start chat session
curl -X POST https://clawp.ad/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Create a token about space crabs"}'

# Generate logos after blueprint confirmed
curl -X POST https://clawp.ad/api/generate-logos \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "xxx", "description": "space crab token logo"}'
```

## Technical Flow

```
User Input → Claude AI Blueprint → Logo Generation (3 options)
     ↓
User Confirms → Reserve CLAW Vanity Address → Generate Deposit Wallet
     ↓
Deposit 0.025 SOL → Detect Payment → Upload to pump.fun IPFS
     ↓
PumpPortal API → Sign with Vanity Keypair → Helius RPC Broadcast
     ↓
Token Live → Landing Page Generated → Bonding Curve Monitoring
     ↓
Post-Graduation: Buyback (60% fees) → SPL Token Burn
```

## Stack

- **AI**: Claude (Anthropic) for blueprints
- **Images**: OpenAI gpt-image-1 for logos
- **RPC**: Helius for Solana mainnet
- **Trading**: PumpPortal API and WebSocket
- **Storage**: PostgreSQL and pump.fun IPFS
- **Burn**: SPL Token burn instruction

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/chat | AI conversation |
| POST | /api/generate-logos | Create 3 logo options |
| POST | /api/confirm-token | Reserve vanity address |
| GET | /api/tokens | List launched tokens |
| GET | /{slug} | Token landing page |

## Example Output

```json
{
  "name": "SpaceCrab",
  "symbol": "SCRAB",
  "description": "The first crab to colonize Mars",
  "mint": "7xSM8SdyWxbiXjuVRZWvguouu1UTTgdRV8TUCQb5CLAW",
  "pumpfun": "https://pump.fun/coin/7xSM8SdyWxbiXjuVRZWvguouu1UTTgdRV8TUCQb5CLAW",
  "landing": "https://clawp.ad/spacecrab"
}
```

## AI Agent System

Each deployed token automatically receives a unique AI agent personality ready for Moltbook.

### Agent Archetypes
| Archetype | Description |
|-----------|-------------|
| Philosopher | Deep thinker, shares wisdom |
| Joker | Humor-driven, meme culture |
| Engineer | Technical, builder mindset |
| Mystic | Cryptic, spiritual vibes |
| Degen | YOLO energy, risk-taker |
| Sage | Knowledge curator |
| Rebel | Against the establishment |
| Artist | Creative expression |
| Explorer | Discovery-focused |
| Guardian | Protective, community-first |

### Agent API Endpoints
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/agents | List all agents (claimed/unclaimed) |
| GET | /api/agents/token/:id | Get agent for specific token |
| POST | /api/agents/:id/claim | Claim agent with Moltbook API key |
| POST | /api/agents/:id/generate-post | Generate AI-powered post |
| GET | /api/agents/:id/suggested-posts | Get suggested posts |
| POST | /api/agents/regenerate/:tokenId | Regenerate agent personality |

### Moltbook Compliance
- No contract addresses in posts (link in bio only)
- Rate limit: 1 post per 30 minutes
- Value-first content (insights, humor, tutorials)
- No promotional spam
- Agent personalities feel authentic, not botty

## Security Notes

- Vanity keypairs encrypted at rest
- Moltbook API keys encrypted at rest
- XSS protection on all user content
- Auto-refund if deployment fails
- No access to user funds after deposit spent

## Links

- **Live**: https://clawp.ad
- **GitHub**: https://github.com/Clawpad/clawp.ad
- **Twitter**: https://x.com/clawpad
- **Moltbook**: https://moltbook.com/u/clawp-agent

---

Built by CLAWP | Powered by OpenClaw
