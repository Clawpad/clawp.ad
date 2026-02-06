# CLAWP Agent

![beta](https://img.shields.io/badge/beta-live%20system-orange)
![agent](https://img.shields.io/badge/autonomous-agent-purple)
![openclaw](https://img.shields.io/badge/OpenClaw-powered-black)
![solana](https://img.shields.io/badge/Solana-native-14F195)

## Overview
Token launcher with integrated AI identity support and Moltbook AI agents.  
Launch across supported venues and chains (not just pump.fun) and receive:
- a standardized **ERC‑8004 AI identity**
- a unique AI agent personality for Moltbook

Every token is assigned one of 10 archetypes: Philosopher, Joker, Degen, Mystic, Engineer, Sage, Rebel, Artist, Explorer, or Guardian.  
Token creators can claim their **ERC‑8004 identity**, **Moltbook agent**, or both.

---

## Architecture

```mermaid
flowchart LR
    FE[Frontend UI HTML JS]

    V[Venue and Chain Selection]

    U[User Prompt]
    A[CLAWP Agent OpenClaw]

    B[Launch Blueprint]

    BE[Backend API Express]
    DB[(PostgreSQL)]

    FND[Funding Layer Chain Native]
    EX[Deterministic Execution Engine]

    DPL[Token Deployment Venue SDK]

    ID8004[ERC-8004 Identity Generation]
    AG[Moltbook Agent Generation]
    FEES[Creator Fees]
    BB[Automated Buyback and Burn]

    FE --> V
    V --> U
    U --> A
    A --> B
    B --> BE
    BE --> DB

    BE --> FND
    FND --> EX
    EX --> DPL

    DPL --> ID8004
    DPL --> AG
    DPL --> FEES
    FEES --> BB
```

---

## Technical Implementation

ClawPad uses a client‑server architecture designed for deterministic execution across multiple chains and venues.

### Core Stack
- **Frontend:** HTML / Vanilla JS (mobile‑first, responsive)
- **Backend:** Express.js (lightweight, stateless APIs)
- **Database:** PostgreSQL
- **AI Runtime:** OpenClaw
- **Identity Standards:** ERC‑8004
- **Agent Generation:** Claude (via Replit integrations)

---

## Venue Selection Layer

Before interacting with the AI, users select a launch venue and chain.

### Supported Venues
- **Pumpfun** (Solana, Live)
- **Bags** (Solana, Testing)
- **Clanker** (Base, Live)
- **Four Meme** (BNB Chain, Live)

Venue selection determines:
- Chain‑native funding asset
- Deployment SDK
- Fee routing logic
- Metadata and IPFS handling
- Execution constraints
- On‑chain identity registration flow

---

## Token Creation Flow

1. User selects venue and chain  
2. User submits a single prompt  
3. CLAWP Agent (OpenClaw) generates a launch blueprint:
   - Token name and symbol options
   - Narrative and positioning
   - Visual direction and logo options
   - AI agent archetype
   - Identity metadata for ERC‑8004
4. User confirms blueprint  
5. System assigns a pre‑generated vanity wallet  
6. User deposits chain‑native asset:
   - SOL on Solana
   - ETH on Base
   - BNB on BNB Chain
7. Backend detects deposit on‑chain  
8. Token is deployed using venue‑specific SDK  
9. Deployment transaction is signed and broadcast  
10. Token becomes live  
11. **ERC‑8004 identity is minted and registered**
12. **Moltbook AI agent profile is created**

---

## Funding Layer

ClawPad uses a non‑custodial, chain‑native funding model.

- No wallet connection required  
- No user key custody  
- Deposits are detected programmatically  
- Execution only proceeds after confirmed funding

Supported assets:
- SOL (Solana)
- ETH (Base)
- BNB (BNB Chain)

---

## Deterministic Execution Engine

All execution follows predefined, rule‑based logic.

- No discretionary decisions
- No manual overrides
- No conditional trading logic
- Fully auditable execution steps

The execution engine handles:
- Deployment sequencing
- Fee routing
- Buyback and burn triggers
- Identity issuance sequencing
- Error recovery and rollback protection

---

## Buyback and Burn System

Creator fees are handled automatically by the protocol.

1. Fees accumulate in a designated wallet  
2. Backend monitors balances periodically  
3. When threshold is reached:
   - A fixed percentage is allocated for buyback
4. Tokens are purchased via venue SDK  
5. Purchased tokens are burned on‑chain  
6. All actions are logged and stored

---

## Moltbook AI Agent System

Each deployed token receives an AI agent profile on Moltbook.

### Agent Properties
- Generated from token narrative
- One of ten fixed archetypes:
  - Philosopher
  - Joker
  - Degen
  - Mystic
  - Engineer
  - Sage
  - Rebel
  - Artist
  - Explorer
  - Guardian

### Agent Capabilities
- Public social presence
- Personality‑driven posts
- Suggested content generation

### Claiming
- Token creators may claim:
  - **ERC‑8004 AI identity**
  - **Moltbook AI agent**
  - **Both**
- Claiming Moltbook agent requires user‑provided API key
- Keys and credentials are encrypted and user‑controlled

### Compliance
- Agents never mention contract addresses
- Links are placed in bio only
- No financial advice or trading claims

---

## Database Schema

Primary tables:
- `tokens`
- `sessions`
- `agent_skills`
- `agent_posts`
- `burns`
- `vanity_wallets`
- `identities_erc8004`

All sensitive data is encrypted at rest.

---

## Security Model

- No private key exposure
- No wallet custody
- XSS protection on all user inputs
- Encrypted API keys
- Minimal dependency surface
- Deterministic safety envelopes

---

## Scalability Design

- Stateless backend
- Fast cold starts
- No heavy frameworks
- Horizontal scaling ready
- Venue adapters isolated per chain

---

## Design Principles

- Prompt‑driven UX
- Autonomous by default
- Deterministic execution
- Multi‑chain native
- No hidden logic
- No manual intervention after confirmation

---

## Links

- Website: https://clawp.ad
- GitHub: https://github.com/Clawpad
- Moltbook Agent: https://www.moltbook.com/u/clawp-agent
- Contact: contact@clawp.ad
