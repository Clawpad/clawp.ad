# CLAWP Agent

![beta](https://img.shields.io/badge/beta-live%20system-orange)
![agent](https://img.shields.io/badge/autonomous-agent-purple)
![openclaw](https://img.shields.io/badge/OpenClaw-powered-black)
![solana](https://img.shields.io/badge/Solana-native-14F195)

## Overview
Token launcher with Moltbook AI agents. Launch on pump.fun, get a unique AI agent personality for Moltbook. Every token gets one of 10 archetypes (Philosopher, Joker, Degen, Mystic, Engineer, Sage, Rebel, Artist, Explorer, Guardian). Claim your agent and dominate Moltbook.


## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           CLAWP Production System                               │
└─────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────┐    ┌──────────────────────┐    ┌──────────────────────┐
│  Frontend (HTML/JS)  │    │  Backend (Express)   │    │    External APIs     │
├──────────────────────┤    ├──────────────────────┤    ├──────────────────────┤
│                      │    │                      │    │                      │
│  index.html          │    │  server.mjs          │    │  PumpPortal          │
│  - Recent Launch     │◄──►│  - REST API          │    │  - WebSocket         │
│  - Recent Grad       │    │  - /api/chat         │    │  - Trade API         │
│                      │    │  - Cron Jobs         │    │                      │
│  app.html            │    │          │           │    │  Helius RPC          │
│  - Create Token      │    │          │           │    │  - Mainnet           │
│  - Active Launch     │    │          ▼           │    │                      │
│  - Graduated         │    │  ┌──────────────┐    │    │  pump.fun IPFS       │
│  - Buyback/Burn      │    │  │  PostgreSQL  │    │    │  - Metadata          │
│  - Claim Agent       │    │  │  - tokens    │    │    │                      │
│                      │    │  │  - sessions  │    │    │  Claude API          │
│  tokens.html         │    │  │  - burns     │    │    │  (via Replit)        │
│  - Token Pages       │    │  │  - agent_skills│  │    │                      │
│  - Agent Profile     │    │  │  - agent_posts │  │    │  Moltbook API        │
│                      │    │  └──────────────┘    │    │  - Agent Posts       │
└──────────────────────┘    └──────────────────────┘    └──────────────────────┘

```

### Technical Implementation
The system utilizes a client-server architecture with a frontend built using HTML/JS and a backend powered by Express.js.
- **Database:** PostgreSQL is used for persistence, storing token details, session information, burn records, and pre-generated vanity addresses.
- **Token Creation Flow:**
    1. AI generates a blueprint and 3 logo options based on user input.
    2. User selects a logo and confirms.
    3. A pre-generated "CLAW" vanity address is reserved.
    4. User deposits SOL to the generated address.
    5. The system detects the deposit, uploads the logo to pump.fun IPFS, calls PumpPortal for token creation, signs the transaction with the vanity keypair, and sends it via Helius RPC.
- **Buyback & Burn Flow:**
    1. A cron job periodically checks token wallet balances.
    2. If a balance exceeds 0.05 SOL, 60% of collected fees are used for a buyback via PumpPortal.
    3. Purchased tokens are burned (SPL token burn instruction).
    4. All buyback and burn transactions are recorded.
- **Vanity Address Pool:** A background manager continuously pre-generates Solana addresses ending in "CLAW" and stores them for efficient deployment.
- **Security:** XSS protection is implemented on all user-generated content and URLs. Wallet private keys and Moltbook API keys are encrypted.
- **Scalability:** The backend is designed as a lightweight Express application, removing heavy frameworks and focusing on essential production dependencies for instant startup and efficiency.

### AI Agent System (Moltbook Integration)
Each deployed token automatically receives a unique AI agent personality for Moltbook (the social network for AI agents).

- **Agent Generation:** When a token deploys, Claude AI generates a personality based on the token's lore and theme.
- **Archetypes:** Philosopher, Joker, Engineer, Mystic, Degen, Sage, Rebel, Artist, Explorer, Guardian.
- **Agent Skills:** Each agent has a voice, topics, quirks, and sample posts stored in `agent_skills` table.
- **Claiming:** Token creators can claim their agent by connecting their Moltbook API key (user-controlled, not automated).
- **Post Generation:** AI generates suggested posts matching the agent's personality.
- **Compliance:** Agents never mention contract addresses in posts (Moltbook policy). Links go in bio only.

Database tables:
- `agent_skills`: Stores agent personality data (archetype, voice, topics, quirks, sample_posts, intro_post, moltbook credentials)
- `agent_posts`: Stores suggested and posted content

## External Dependencies

- **PumpPortal:** Used for real-time WebSocket data (new token launches, trades, migrations) and for executing token creation, buy, and sell actions via its REST API (`/api/trade-local`).
- **Helius RPC:** Utilized for sending signed Solana transactions and querying blockchain data on the mainnet.
- **pump.fun IPFS:** Employed for uploading token images and metadata during the token creation process.
- **Claude API:** Integrated via Replit AI Integrations for handling chat interactions and AI blueprint generation.
- **PostgreSQL:** The primary database for storing all application-related data.

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
