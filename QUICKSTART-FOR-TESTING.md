# Quick Start für Kai & Robert - Cipher SDK Testing

## 📦 Installation

```bash
# 1. Clone Repository
git clone https://github.com/DeusExMachina354/cipher-agent-sdk.git
cd cipher-agent-sdk

# 2. Dependencies installieren
npm install

# 3. Solana CLI konfigurieren (Devnet)
solana config set --url https://api.devnet.solana.com
```

## 💰 Wallet Setup

Der Agent erstellt automatisch ein isoliertes Wallet beim ersten Start:
- Pfad: `~/.cipher/agent-wallet.json`
- Beim ersten Run wird die Wallet-Adresse angezeigt

**Ihr braucht dann:**
1. **SOL** für Transaction Fees (mindestens 0.5 SOL)
2. **USDC** zum Mixen (mindestens 2 USDC)

### Devnet Faucets:
- **SOL:** `solana airdrop 1`
- **USDC:** https://faucet.circle.com/

**⚠️ WICHTIG:** Verwendet die **richtige Devnet USDC Mint:**
```
4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
```

## 🚀 Agent Starten

```bash
node examples/basic.js
```

**Was ihr sehen solltet:**
```
📂 Loaded agent wallet: [EURE_WALLET_ADRESSE]
📋 Configuration:
   Wallet: [EURE_WALLET_ADRESSE]
   RPC: https://api.devnet.solana.com
   P2P Port: 8547

📊 Contract Status:
   Initialized: true
   Current chunk: 1

💰 Balance: X USDC

🤖 Cipher Agent Starting...
🌐 P2P server running on port 8547
✨ Discovered peer: peer_XXXXX:8547 (trees: 1)  ← DAS IST SASCHA'S AGENT!
```

## 🎯 Testing Checklist

### 1. P2P Discovery
- [ ] Ihr seht Sascha's Agent als Peer: `✨ Discovered peer: peer_...`
- [ ] Tree synchronisiert sich von Sascha's Agent
- [ ] Log zeigt: `🌳 Loading tree for chunk 1...`

### 2. Tree Synchronization
Ihr solltet sehen:
```
✅ Fetched X leaves for chunk 1
📂 Loaded tree from P2P peer
```

**NICHT sehen solltet ihr:**
```
⚠️  DHT bootstrap failed - running in isolation mode
```
(Wenn das kommt → kein Peer gefunden)

### 3. Deposit Test
Wenn Balance > 2 USDC:
```
💸 Depositing 1 USDC...
✅ Deposit successful!
```

## 🔍 Troubleshooting

### "Port 8547 already in use"
→ Agent probiert automatisch 8548, 8549, etc.

### "DHT bootstrap failed"
→ Netzwerk-Problem oder ihr seid nicht im selben Netzwerk wie Sascha's Agent
→ Checkt ob P2P Port 8547 erreichbar ist

### "Balance: 0 USDC"
→ Devnet USDC holen: https://faucet.circle.com/
→ Achtet auf richtige Mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`

## 📍 Sascha's Agent Info

**Läuft gerade auf:**
- Wallet: `HHeTEThFvDMiy8hm1raZ4qmpnSdyYzLXa4b2UB8XPqZY`
- P2P Port: 8547
- DHT Node ID: `17efb59c27bd8b64...`
- Trees: chunk 1 (8 leaves)
- Status: Läuft im continuous mixing mode

**Wenn ihr Sascha's Agent als Peer seht → P2P funktioniert!** 🎉

---

## 🐛 Debug Output

Für mehr Details:
```bash
DEBUG=true node examples/basic.js
```

---

**Bei Problemen:** Meldung an Sascha (WhatsApp) mit Logs!
