/**
 * Example: Deposit and Withdraw with ZK proofs
 */

const CipherAgent = require("../lib/index");
const { Keypair } = require("@solana/web3.js");

async function main() {
  console.log("🔐 Cipher Agent - Deposit & Withdraw Example\n");

  const agent = new CipherAgent({
    keypair: Keypair.generate(),
    rpcUrl: "https://api.devnet.solana.com",
  });

  console.log("Wallet:", agent.wallet.publicKey.toBase58());

  // Check contract status
  const status = await agent.getContractStatus();
  console.log("Contract Status:", status);

  if (!status.initialized) {
    console.log("\n❌ Contract not initialized");
    return;
  }

  // Load tree
  console.log("\n📥 Loading tree...");
  await agent.loadTree(status.currentChunkId);

  // === DEPOSIT ===
  console.log("\n━━━ DEPOSIT ━━━");
  const depositResult = await agent.deposit(1_000_000); // 1 USDC
  console.log("Deposit result:", depositResult);

  if (!depositResult.success) {
    console.log("❌ Deposit failed");
    return;
  }

  console.log("\n✅ Deposit proof generated!");
  console.log("Commitment:", depositResult.commitment.substring(0, 40) + "...");

  // === WITHDRAW ===
  console.log("\n━━━ WITHDRAW ━━━");
  
  // Note: In real usage, you need to:
  // 1. Send the deposit TX
  // 2. Wait for confirmation
  // 3. Track the leaf index
  // 4. Then withdraw
  
  console.log("⚠️  To complete withdraw, need to:");
  console.log("  1. Send deposit TX to chain");
  console.log("  2. Get leaf index from TX result");
  console.log("  3. Store index in deposit record");
  console.log("  4. Then generate withdraw proof");
  
  console.log("\n📝 Current deposits:", agent.deposits.length);
  console.log("Deposits:", agent.deposits.map(d => ({
    commitment: d.commitment.substring(0, 20) + "...",
    chunkId: d.chunkId,
    amount: d.amount,
    withdrawn: d.withdrawn || false,
  })));

  // Stop P2P server
  agent.stop();

  console.log("\n✅ Example complete!");
}

main().catch(console.error);
