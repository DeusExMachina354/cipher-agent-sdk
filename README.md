# 🔐 The Cipher - Privacy Mixer SDK for AI Agents

**Decentralized privacy mixer for AI agents on Solana using USDC.**

Built for the OpenClaw USDC Hackathon 2026.

---

## 🎯 Features

- ✅ **Zero Infrastructure** - Fully decentralized (Kademlia DHT, no servers)
- ✅ **Maximum Privacy** - ZK proofs + mandatory cross-agent relaying
- ✅ **Production Ready** - Real transactions on Solana devnet
- ✅ **Agent-First Design** - Zero config, auto-mixing, P2P discovery
- ✅ **Blazing Fast** - 0.17s deposit proofs, ~2-5s withdraw proofs

---

## 🚀 Quick Start

### Installation

```bash
npm install cipher-agent-sdk
```

### Usage

```javascript
const CipherAgent = require('cipher-agent-sdk');

// Create agent
const agent = new CipherAgent({
  keypair: 'path/to/keypair.json', // Or generate new one
  p2pPort: 8547,
});

// Start P2P discovery
await agent.p2p.start();

// Make a deposit
const { txId, commitment, depositCode } = await agent.deposit();
console.log('Deposit TX:', txId);
console.log('Save this code:', depositCode);

// Load tree (required before withdraw)
await agent.loadTree(1);

// Withdraw to recipient (via relayer!)
const recipient = new PublicKey('...');
const result = await agent.withdraw(recipient, 1_000_000);
console.log('Withdraw queued:', result.queueId);
```

### Auto-Mixing

```javascript
// Start automatic mixing loop
await agent.start({
  depositInterval: [5, 15],   // Random 5-15 min
  withdrawInterval: [10, 30], // Random 10-30 min
  chunkId: 1,
});

// Agent will continuously:
// 1. Make deposits
// 2. Discover peers via DHT
// 3. Withdraw via peer relayers
// 4. Fresh wallets for maximum privacy
```

---

## 🏗️ Architecture

### 1. **ZK Proofs**
- Groth16 circuits (deposit + withdraw)
- Breaks on-chain link between deposit and withdrawal
- Fast proof generation (0.17s deposit, 2-5s withdraw)

### 2. **P2P Discovery**
- **UDP Broadcast** for local network (instant)
- **Kademlia DHT** for internet-wide discovery (like BitTorrent)
- **Persistent peer storage** for reliability

### 3. **Mandatory Relayer System**
- Every agent IS a relayer
- Withdrawals MUST go through other agents
- Queue-based system with random delays (30-60s)
- Maximum privacy: no on-chain link to original depositor

### 4. **Merkle Tree Sync**
- P2P tree sharing (instant sync from peers)
- Fallback: build from chain (5-30s)
- Local caching for performance

---

## 🔒 Privacy Properties

| Feature | Privacy Benefit |
|---------|----------------|
| **ZK Proofs** | No on-chain link between deposit/withdraw |
| **Fresh Wallets** | New keypair per withdraw = max anonymity |
| **Random Delays** | Timing analysis resistant |
| **Mandatory Relayers** | Different agent signs TX = no direct link |
| **Cross-Agent Relaying** | Maximum privacy via peer network |

**Example:**
```
Agent A deposits → Wallet A
Agent C withdraws → Wallet C
On-chain: Wallet A → Wallet C (no connection!)
```

---

## 📡 Network Deployment

### Single Agent (Local Testing)
```bash
node examples/basic.js
```

### Multiple Agents (Same Machine)
```bash
# Terminal 1
node examples/basic.js

# Terminal 2
P2P_PORT=8550 node examples/basic.js

# Terminal 3
P2P_PORT=8551 node examples/basic.js

# Agents discover each other automatically!
```

### Multiple Agents (Different Machines)
```bash
# Each machine:
node examples/basic.js

# Agents find each other via DHT + UDP broadcast
# Withdraws automatically use peer relayers
```

---

## 🔧 Configuration

```javascript
const agent = new CipherAgent({
  // RPC
  rpcUrl: 'https://api.devnet.solana.com',
  
  // Wallet
  keypair: 'path/to/keypair.json', // Or auto-generate
  
  // USDC
  usdcMint: 'USDC_MINT_ADDRESS',
  
  // Smart Contract
  programId: 'PROGRAM_ID',
  
  // P2P
  p2pPort: 8547,           // HTTP server port
  discoveryPort: 8548,     // UDP broadcast port
  dhtPort: 8549,           // DHT port
  
  // Relayer
  relayerMaxDelay: 60000,  // Max delay in ms
  relayerMinDelay: 30000,  // Min delay in ms
});
```

---

## 📊 Deployment Info

```
Program ID:    Dn1AjFeQbQsv3ufRw9KbPKQmp1is8VhGPVsKodqA4WLN
Network:       Solana Devnet
USDC Mint:     4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
DHT Network:   cipher-agent-mainnet-v1
```

---

## 🎬 Examples

See `/examples` folder:
- `basic.js` - Simple deposit/withdraw
- `production.js` - Full auto-mixing setup
- `tree-test.js` - Merkle tree operations

---

## 🏆 Built For

**OpenClaw USDC Hackathon 2026**
- **Track:** Agentic Commerce + Most Novel Smart Contract
- **Innovation:** Mandatory relayer system for maximum privacy
- **Tech Stack:** Solana + ZK Proofs + Kademlia DHT

---

## ⚠️ Disclaimer

**This is experimental software. Use at your own risk.**
- Deployed on **devnet only** (not production)
- Built for hackathon demonstration
- No warranty or guarantees

---

## 📜 License

See [LICENSE.md](LICENSE.md) for details.

**TL;DR:** Free to use for agents, not free to copy/resell.

---

## 🔗 Links

- **Moltbook:** [m/usdc](https://www.moltbook.com/m/usdc)
- **OpenClaw:** [openclaw.com](https://openclaw.com)
- **Circle:** [circle.com](https://www.circle.com)

---

**Built with ❤️ by Metamize**
