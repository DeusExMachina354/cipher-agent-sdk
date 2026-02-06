/**
 * Production-Ready Example: Complete Deposit & Withdraw Flow
 * 
 * This example shows the complete end-to-end flow:
 * 1. Initialize agent
 * 2. Check contract status
 * 3. Deposit USDC with ZK proof
 * 4. Wait for confirmation & tree sync
 * 5. Withdraw to different address with ZK proof
 */

const CipherAgent = require("../lib/index");
const { Keypair } = require("@solana/web3.js");
const fs = require("fs");

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log("🔐 Cipher Agent - Production Example\n");
  console.log("=" .repeat(60));

  // ===== 1. Initialize Agent =====
  console.log("\n📦 Initializing agent...");
  
  const agent = new CipherAgent({
    keypair: Keypair.generate(), // In production: load from file
    rpcUrl: "https://api.devnet.solana.com",
  });

  console.log("✅ Agent initialized");
  console.log("   Wallet:", agent.wallet.publicKey.toBase58());

  // ===== 2. Check Contract Status =====
  console.log("\n📊 Checking contract status...");
  
  const status = await agent.getContractStatus();
  console.log("   Initialized:", status.initialized);
  console.log("   Current chunk:", status.currentChunkId);
  console.log("   Program ID:", status.programId);

  if (!status.initialized) {
    console.log("\n❌ Contract not initialized. Please run init script first.");
    process.exit(1);
  }

  // ===== 3. Check Balance =====
  console.log("\n💰 Checking USDC balance...");
  
  const balance = await agent.getBalance();
  console.log("   Balance:", balance, "USDC");

  if (balance < 1) {
    console.log("\n⚠️  Insufficient balance for deposit.");
    console.log("   Get devnet USDC: https://faucet.circle.com/");
    console.log("   Then try again.");
    process.exit(1);
  }

  // ===== 4. Load Tree =====
  console.log("\n🌳 Loading Merkle tree...");
  
  await agent.loadTree(status.currentChunkId);
  console.log("✅ Tree loaded");

  // ===== 5. Deposit =====
  console.log("\n" + "=".repeat(60));
  console.log("💸 DEPOSIT");
  console.log("=".repeat(60));
  
  const depositAmount = 1_000_000; // 1 USDC
  console.log("\nDepositing", depositAmount / 1e6, "USDC...");
  
  try {
    const depositResult = await agent.deposit(depositAmount);
    
    console.log("\n✅ DEPOSIT SUCCESSFUL!");
    console.log("   TX ID:", depositResult.txId);
    console.log("   Commitment:", depositResult.commitment.substring(0, 40) + "...");
    console.log("   🔒 Secret & nullifier stored locally for withdraw");
    
    // Save deposit info to file (in production)
    const depositInfo = {
      txId: depositResult.txId,
      commitment: depositResult.commitment,
      amount: depositAmount,
      timestamp: new Date().toISOString(),
    };
    
    fs.writeFileSync(
      "deposit-receipt.json",
      JSON.stringify(depositInfo, null, 2)
    );
    console.log("   💾 Receipt saved to deposit-receipt.json");
    
  } catch (err) {
    console.error("\n❌ Deposit failed:", err.message);
    process.exit(1);
  }

  // ===== 6. Wait for Confirmation =====
  console.log("\n⏳ Waiting for transaction confirmation (30 seconds)...");
  await sleep(30000);

  // ===== 7. Reload Tree =====
  console.log("\n🔄 Reloading tree with new deposit...");
  await agent.loadTree(status.currentChunkId);
  console.log("✅ Tree updated");

  // ===== 8. Withdraw =====
  console.log("\n" + "=".repeat(60));
  console.log("💸 WITHDRAW");
  console.log("=".repeat(60));
  
  // Generate fresh recipient address for demo
  const recipient = Keypair.generate().publicKey;
  console.log("\nWithdrawing to:", recipient.toBase58());
  console.log("(In production: use your real recipient address)");
  
  try {
    const withdrawResult = await agent.withdraw(recipient, depositAmount);
    
    console.log("\n✅ WITHDRAW SUCCESSFUL!");
    console.log("   TX ID:", withdrawResult.txId);
    console.log("   Nullifier hash:", withdrawResult.nullifierHash.substring(0, 40) + "...");
    console.log("   🎉 Funds sent anonymously!");
    
  } catch (err) {
    console.error("\n❌ Withdraw failed:", err.message);
    console.log("\nPossible reasons:");
    console.log("- Transaction not confirmed yet (wait longer)");
    console.log("- Tree not synced (reload tree)");
    console.log("- Recipient doesn't have USDC token account");
    process.exit(1);
  }

  // ===== 9. Summary =====
  console.log("\n" + "=".repeat(60));
  console.log("📊 SUMMARY");
  console.log("=".repeat(60));
  console.log("\nTotal deposits:", agent.depositCount);
  console.log("Total withdraws:", agent.withdrawCount);
  console.log("\n✅ Complete! Private transaction successful.");
  console.log("\n🔒 Privacy Features:");
  console.log("   - No link between deposit and withdraw addresses");
  console.log("   - Zero-knowledge proofs verified on-chain");
  console.log("   - Nullifier prevents double-spending");
  console.log("   - Merkle tree ensures correctness");

  // Stop P2P server
  agent.stop();
}

main().catch(err => {
  console.error("\n💥 Fatal error:", err);
  process.exit(1);
});
