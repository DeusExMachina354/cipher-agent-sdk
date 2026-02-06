/**
 * Bootstrap Node - No Auto-Mixing
 * 
 * This node ONLY provides P2P and DHT services.
 * It doesn't deposit/withdraw, just helps other agents discover each other.
 * 
 * Perfect for running on a public VPS as bootstrap node.
 */

const CipherAgent = require("../lib/index");

async function main() {
  console.log("🌍 Starting Cipher Bootstrap Node...\n");
  
  const agent = new CipherAgent({
    rpcUrl: process.env.RPC_URL || "https://api.devnet.solana.com",
    p2pPort: parseInt(process.env.P2P_PORT || '8547'),
  });

  console.log("📋 Bootstrap Node Configuration:");
  console.log("   Wallet:", agent.wallet.publicKey.toBase58());
  console.log("   RPC:", agent.rpcUrl);
  console.log("   P2P Port:", agent.p2p.port);
  console.log("   DHT Port:", agent.p2p.dhtPort);
  console.log("");

  // Check contract status
  try {
    const status = await agent.getContractStatus();
    console.log("📊 Contract Status:");
    console.log("   Initialized:", status.initialized);
    console.log("   Current chunk:", status.currentChunkId);
    console.log("");
  } catch (err) {
    console.log("⚠️  Could not connect to contract (OK for bootstrap-only node)");
    console.log("");
  }

  // Start P2P and DHT services (but don't start auto-mixing)
  console.log("🚀 Starting P2P and DHT services...\n");
  
  await agent.p2p.startServer();
  
  console.log("✅ Bootstrap node is running!");
  console.log("");
  console.log("📡 Services:");
  console.log("   - HTTP P2P: port", agent.p2p.port);
  console.log("   - UDP Broadcast: port", agent.p2p.discoveryPort);
  console.log("   - DHT: port", agent.p2p.dhtPort);
  console.log("");
  console.log("🌐 This node will:");
  console.log("   ✓ Accept DHT bootstrap requests");
  console.log("   ✓ Store DHT routing information");
  console.log("   ✓ Help other agents discover each other");
  console.log("   ✓ Share Merkle trees");
  console.log("   ✗ NOT perform deposits/withdraws");
  console.log("");
  console.log("💡 To use as bootstrap node, add to other agents:");
  console.log(`   DHT_BOOTSTRAP_NODES.push({ host: 'YOUR_IP', port: ${agent.p2p.dhtPort} })`);
  console.log("");
  console.log("Press Ctrl+C to stop\n");

  // Keep process alive
  process.on('SIGTERM', () => {
    console.log("\n🛑 Shutting down bootstrap node...");
    agent.p2p.stopServer();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log("\n🛑 Shutting down bootstrap node...");
    agent.p2p.stopServer();
    process.exit(0);
  });

  // Load initial tree to serve to other agents
  try {
    const status = await agent.getContractStatus();
    if (status.initialized) {
      console.log(`📥 Loading tree for chunk ${status.currentChunkId}...`);
      await agent.treeBuilder.getOrBuildTree(status.currentChunkId);
      console.log("✅ Tree loaded and ready to serve\n");
    }
  } catch (err) {
    console.log("ℹ️  No tree loaded (will sync from chain when requested)\n");
  }
}

main().catch(err => {
  console.error("❌ Error:", err);
  process.exit(1);
});
