# CLAWP Agent - AI Token Launcher on pump.fun
# CLAWP Agent

![beta](https://img.shields.io/badge/beta-live%20system-orange)
![agent](https://img.shields.io/badge/autonomous-agent-purple)
![openclaw](https://img.shields.io/badge/OpenClaw-powered-black)
![solana](https://img.shields.io/badge/Solana-native-14F195)

## Overview

CLAWP Agent is an AI-powered autonomous token launcher on pump.fun, powered by OpenClaw. Users describe token ideas via chat, and the platform autonomously executes creation, deployment, and post-launch buyback & burn operations.


## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         ClawPad Production System                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Frontend (HTML/JS)          Backend (Express)           External APIs      │
│   ┌──────────────────┐       ┌──────────────────┐       ┌────────────────┐  │
│   │ index.html       │       │ server.mjs       │       │ PumpPortal     │  │
│   │ - Recent Launch  │◀─────▶│ - REST API       │◀─────▶│ - WebSocket    │  │
│   │ - Recent Grad    │       │ - /api/chat      │       │ - Trade API    │  │
│   ├──────────────────┤       │ - Cron Jobs      │       ├────────────────┤  │
│   │ app.html         │       └────────┬─────────┘       │ Helius RPC     │  │
│   │ - Create Token   │                │                 │ - Mainnet      │  │
│   │ - Active Launch  │                ▼                 ├────────────────┤  │
│   │ - Graduated      │       ┌──────────────────┐       │ pump.fun IPFS  │  │
│   │ - Buyback/Burn   │       │ PostgreSQL       │       │ - Metadata     │  │
│   └──────────────────┘       │ - tokens         │       ├────────────────┤  │
│                              │ - sessions       │       │ Claude API     │  │
│                              │ - burns          │       │ (via Replit)   │  │
│                              └──────────────────┘       └────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Database Schema

### tokens
- id (UUID, PK)
- mint_address (TEXT, unique)
- name, symbol, description (TEXT)
- image_url, metadata_uri (TEXT)
- wallet_public_key (TEXT) - dedicated wallet for this token
- wallet_private_key_encrypted (TEXT) - encrypted with ENCRYPTION_KEY
- status (TEXT): pending, active, graduated, failed
- bonding_progress (DECIMAL)
- market_cap (DECIMAL)
- pumpswap_pool (TEXT) - set after graduation to PumpSwap AMM
- total_fees_collected (DECIMAL)
- total_burned (DECIMAL)
- created_at, graduated_at (TIMESTAMP)

### sessions
- id (SERIAL, PK)
- blueprint (JSONB) - AI generated blueprint
- status (TEXT): pending, funded, deploying, completed, failed, refunded
- deposit_address (TEXT)
- deposit_amount (DECIMAL)
- funding_wallet (TEXT) - auto-detected wallet that sent deposit (for refunds)
- token_id (INTEGER, FK) - linked after successful creation
- error_message (TEXT) - saved if deployment fails
- deleted_at (TIMESTAMPTZ) - soft delete timestamp (data never hard-deleted)
- created_at (TIMESTAMP)

### burns
- id (SERIAL, PK)
- token_id (UUID, FK)
- sol_spent (DECIMAL)
- tokens_burned (DECIMAL)
- tx_hash (TEXT)
- created_at (TIMESTAMP)

### vanity_addresses
- id (UUID, PK)
- public_key (TEXT, unique) - pre-generated address ending with "CLAW"
- secret_key_encrypted (TEXT) - encrypted private key
- status (TEXT): available, reserved, used
- reserved_at, used_at (TIMESTAMPTZ)
- session_id, token_id (UUID, FK)
- attempts (BIGINT), elapsed_seconds (REAL) - generation metrics
- created_at, updated_at (TIMESTAMPTZ)

## Environment Variables

### Required Secrets
- `HELIUS_API_KEY` - Solana mainnet RPC
- `ENCRYPTION_KEY` - For encrypting wallet private keys
- `SESSION_SECRET` - Express session (existing)

### Auto-configured
- `DATABASE_URL` - PostgreSQL connection
- `ANTHROPIC_API_KEY` - Via Replit AI Integrations

## External APIs

### PumpPortal (No API key needed for basic features)
- WebSocket: `wss://pumpportal.fun/api/data`
  - subscribeNewToken - new token launches
  - subscribeTokenTrade - trades on specific tokens
  - subscribeMigration - graduation events
- REST: `https://pumpportal.fun/api/trade-local`
  - action: create, buy, sell
  - Returns unsigned transaction to sign locally

### pump.fun IPFS
- POST `https://pump.fun/api/ipfs`
- Upload token image and metadata
- Returns metadataUri for token creation

### Helius RPC (Mainnet)
- Endpoint: `https://mainnet.helius-rpc.com/?api-key=KEY`
- Send signed transactions
- Query balances and token info

## Token Creation Flow

1. User describes idea → AI generates blueprint
2. Blueprint appears in right panel
3. AI automatically generates 3 logo options (via OpenAI gpt-image-1) - shown inline below blueprint
4. User selects preferred logo (button enables after selection)
5. User clicks "Confirm & Continue"
6. Backend reserves pre-generated CLAW vanity address from pool
7. User deposits 0.025 SOL to generated address
8. Backend detects deposit via Helius RPC polling
9. Backend uploads selected logo to pump.fun IPFS
10. Backend calls PumpPortal trade-local (action: create)
11. Backend signs transaction with CLAW vanity keypair
12. Backend sends via Helius RPC
13. Token live on pump.fun with address ending in "CLAW", saved to database

## Buyback & Burn Flow

**Policy: 100% creator fees allocated for buyback & burn, 60% executed per cycle**

1. Cron job checks all token wallets every 5 minutes
2. If balance > 0.05 SOL threshold:
   - Calculate 60% of available fees for buyback (40% accumulates)
   - Call PumpPortal trade-local (action: buy)
   - Sign and send buyback transaction
   - Burn purchased tokens (SPL burn instruction)
   - Record in burns table

## Project Structure

```
.
├── .openclaw/
│   └── openclaw.json     # OpenClaw gateway configuration
├── public/
│   ├── index.html        # Landing page (+ real-time data)
│   ├── app.html          # App platform
│   └── *.html            # Other pages
├── skills/               # ClawPad AI skill
├── src/
│   ├── db.mjs            # Database connection & queries
│   ├── solana.mjs        # Solana/Helius utilities
│   ├── pumpportal.mjs    # PumpPortal API wrapper
│   └── crypto.mjs        # Encryption utilities
├── server.mjs            # Express server + API routes
└── package.json          # Dependencies
```

## Design System

**Mascot:** Cute CSS-animated crab (pure CSS, no images)
- Salmon/red body (#f86a5b to #d54a3a gradient)
- Big white eyes with animated pupils
- Pink cheeks, small claws

**Colors:**
- Background: #0a0a0f, #12121a, #1a1a24
- Primary: #ff4444 (red)
- Success: #00ff88 (green)
- Warning: #ffaa00 (orange)

**Typography:**
- Headlines: Space Grotesk
- Body: Inter
- Code: JetBrains Mono
