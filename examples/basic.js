/**
 * Basic example: Auto-mixing agent
 * 
 * This agent automatically deposits and withdraws 1 USDC
 * to create continuous mixing traffic for privacy.
 * 
 * Features:
 * - Random delays between deposits/withdraws
 * - Fresh wallet for each withdraw (max privacy)
 * - Automatic balance checking
 * - P2P tree synchronization
 * - Automatic peer discovery
 */

const CipherAgent = require("../lib/index");
const { Keypair } = require("@solana/web3.js");
const fs = require("fs");

async function main() {
  // SECURITY: Agent uses isolated wallet in ~/.cipher/agent-wallet.json
  // On first run, it will generate and display the wallet address
  // No manual keypair loading needed - agent handles it automatically
  
  const agent = new CipherAgent({
    rpcUrl: process.env.RPC_URL || "https://api.devnet.solana.com",
    p2pPort: parseInt(process.env.P2P_PORT || '8547'),
  });

  console.log("\n📋 Configuration:");
  console.log("   Wallet:", agent.wallet.publicKey.toBase58());
  console.log("   RPC:", agent.rpcUrl);
  console.log("   P2P Port:", agent.p2p.port);
  console.log("");

  // Check contract status
  const status = await agent.getContractStatus();
  console.log("📊 Contract Status:");
  console.log("   Initialized:", status.initialized);
  console.log("   Current chunk:", status.currentChunkId);
  console.log("");

  if (!status.initialized) {
    console.log("❌ Contract not initialized. Please run init script first.");
    process.exit(1);
  }

  // Check balance
  const balance = await agent.getBalance();
  console.log("💰 Balance:", balance / 1e6, "USDC\n");

  if (balance < 2_000_000) {
    console.log("⚠️  Low balance! Get devnet USDC: https://faucet.circle.com/");
    console.log("   Need at least 2 USDC to start mixing.");
    console.log("");
  }

  // Start auto-mixing
  await agent.start({
    depositInterval: [5, 15],      // Random delay 5-15 minutes
    withdrawInterval: [10, 30],    // Random delay 10-30 minutes
    amount: 1_000_000,             // 1 USDC
    mode: 'continuous',            // Continuous mixing
    generateNewWallets: true,      // Fresh wallet per withdraw (max privacy)
    minBalance: 2_000_000,         // Stop if balance < 2 USDC
    maxRunTime: null,              // Run forever (null = no limit)
  });
}

main().catch(err => {
  console.error("❌ Error:", err);
  process.exit(1);
});
