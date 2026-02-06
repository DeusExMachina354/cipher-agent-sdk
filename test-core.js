/**
 * Core functionality test
 * Tests key features without requiring Solana connection
 */

console.log("🧪 Testing core functionality...\n");

async function runTests() {
  let passed = 0;
  let failed = 0;

  // Test 1: Crypto module
  try {
    const { getPoseidon, initPoseidon } = require("./lib/crypto");
    console.log("📝 Test 1: Crypto module initialization");
    
    await initPoseidon();
    const poseidon = await getPoseidon();
    
    if (!poseidon || typeof poseidon !== 'function') {
      throw new Error("Poseidon not properly initialized");
    }
    
    // Test that second call returns same instance
    const poseidon2 = await getPoseidon();
    if (poseidon !== poseidon2) {
      throw new Error("Poseidon singleton pattern broken");
    }
    
    console.log("   ✅ Poseidon initialized correctly");
    console.log("   ✅ Singleton pattern works\n");
    passed++;
  } catch (err) {
    console.error(`   ❌ FAILED: ${err.message}\n`);
    failed++;
  }

  // Test 2: Storage module (async)
  try {
    const DepositStorage = require("./lib/storage");
    console.log("📝 Test 2: Storage module (async I/O)");
    
    const testFile = "/tmp/test-deposits.json";
    const storage = new DepositStorage(testFile);
    
    // Test async operations
    await storage.addDeposit("TEST_CODE_123", "TX_ABC", { amount: 1000000 });
    const deposits = await storage.loadDeposits();
    
    if (deposits.length !== 1) {
      throw new Error("Storage add/load failed");
    }
    
    if (deposits[0].code !== "TEST_CODE_123") {
      throw new Error("Storage data corrupted");
    }
    
    // Test find
    const found = await storage.findUnwithdrawnDeposit(1000000);
    if (!found || found.code !== "TEST_CODE_123") {
      throw new Error("Storage find failed");
    }
    
    // Test mark as withdrawn
    await storage.markAsWithdrawn("TEST_CODE_123", "TX_DEF");
    const updated = await storage.loadDeposits();
    
    if (!updated[0].withdrawn) {
      throw new Error("Storage update failed");
    }
    
    // Cleanup
    const fs = require("fs");
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
    }
    
    console.log("   ✅ Async file operations work");
    console.log("   ✅ Add/load/find/update all functional\n");
    passed++;
  } catch (err) {
    console.error(`   ❌ FAILED: ${err.message}\n`);
    failed++;
  }

  // Test 3: Sparse Tree (memory optimization)
  try {
    const MerkleTreeBuilder = require("./lib/tree");
    const { Connection, PublicKey } = require("@solana/web3.js");
    
    console.log("📝 Test 3: Sparse tree memory optimization");
    
    const connection = new Connection("https://api.devnet.solana.com");
    const programId = new PublicKey("Dn1AjFeQbQsv3ufRw9KbPKQmp1is8VhGPVsKodqA4WLN");
    const builder = new MerkleTreeBuilder(programId, connection);
    
    await builder.init();
    
    // Create small leaf set (should use sparse tree)
    const testLeaves = [
      BigInt(123456789),
      BigInt(987654321),
      BigInt(111222333),
    ];
    
    const tree = await builder.buildTree(1, testLeaves);
    
    if (!tree || tree.length === 0) {
      throw new Error("Tree build failed");
    }
    
    // Verify tree is built correctly
    const treeData = builder.trees[1];
    if (!treeData || treeData.leaves.length !== 3) {
      throw new Error("Tree data not stored correctly");
    }
    
    console.log("   ✅ Sparse tree builds successfully");
    console.log(`   ✅ Tree stored correctly (${treeData.leaves.length} leaves)\n`);
    passed++;
  } catch (err) {
    console.error(`   ❌ FAILED: ${err.message}\n`);
    failed++;
  }

  // Test 4: Relayer validation
  try {
    const RelayerService = require("./lib/relayer");
    console.log("📝 Test 4: Relayer input validation");
    
    const mockAgent = { wallet: {}, connection: {} };
    const relayer = new RelayerService(mockAgent);
    
    // Test validation function
    const validProof = {
      pi_a: ["1", "2", "3"],
      pi_b: [["4", "5"], ["6", "7"], ["8", "9"]],
      pi_c: ["10", "11", "12"],
      protocol: "groth16",
      curve: "bn128"
    };
    
    const validRecipient = "11111111111111111111111111111111";
    const validAmount = 1000000;
    const validChunkId = 1;
    
    const result = relayer._validateWithdrawRequest(
      validProof,
      validRecipient,
      validAmount,
      validChunkId
    );
    
    if (!result.valid) {
      throw new Error(`Valid input rejected: ${result.error}`);
    }
    
    // Test invalid inputs
    const invalidAmount = relayer._validateWithdrawRequest(
      validProof,
      validRecipient,
      -1, // Invalid!
      validChunkId
    );
    
    if (invalidAmount.valid) {
      throw new Error("Invalid amount not caught");
    }
    
    const invalidRecipient = relayer._validateWithdrawRequest(
      validProof,
      "not-base58!", // Invalid!
      validAmount,
      validChunkId
    );
    
    if (invalidRecipient.valid) {
      throw new Error("Invalid recipient not caught");
    }
    
    console.log("   ✅ Valid inputs accepted");
    console.log("   ✅ Invalid inputs rejected correctly\n");
    passed++;
  } catch (err) {
    console.error(`   ❌ FAILED: ${err.message}\n`);
    failed++;
  }

  // Test 5: Rate limiting
  try {
    const RelayerService = require("./lib/relayer");
    console.log("📝 Test 5: Rate limiting");
    
    const mockAgent = { wallet: {}, connection: {} };
    const relayer = new RelayerService(mockAgent, {
      rateLimit: { requests: 3, window: 1000 }
    });
    
    const testIp = "192.168.1.100";
    
    // Should allow first 3 requests
    for (let i = 0; i < 3; i++) {
      if (!relayer._checkRateLimit(testIp)) {
        throw new Error(`Request ${i + 1} blocked incorrectly`);
      }
    }
    
    // Should block 4th request
    if (relayer._checkRateLimit(testIp)) {
      throw new Error("Rate limit not enforced");
    }
    
    console.log("   ✅ Rate limit allows valid requests");
    console.log("   ✅ Rate limit blocks excess requests\n");
    passed++;
  } catch (err) {
    console.error(`   ❌ FAILED: ${err.message}\n`);
    failed++;
  }

  // Test 6: DHT peer validation
  try {
    const { DHTNode } = require("./lib/dht");
    console.log("📝 Test 6: DHT peer validation");
    
    const dht = new DHTNode();
    
    // Valid peer (public IP)
    const validPeer = { host: "8.8.8.8", port: 8547, id: Buffer.alloc(20) };
    if (!dht._validatePeer(validPeer)) {
      throw new Error("Valid peer rejected");
    }
    
    // Invalid port
    const invalidPort = { host: "8.8.8.8", port: 99999, id: Buffer.alloc(20) };
    if (dht._validatePeer(invalidPort)) {
      throw new Error("Invalid port not caught");
    }
    
    // Private IP (should be rejected)
    const privateIp = { host: "192.168.1.1", port: 8547, id: Buffer.alloc(20) };
    if (dht._validatePeer(privateIp)) {
      throw new Error("Private IP not rejected");
    }
    
    // Another private IP
    const privateIp2 = { host: "10.0.0.1", port: 8547, id: Buffer.alloc(20) };
    if (dht._validatePeer(privateIp2)) {
      throw new Error("Private IP not rejected");
    }
    
    // Localhost (should be allowed for testing)
    const localhost = { host: "127.0.0.1", port: 8547, id: Buffer.alloc(20) };
    if (!dht._validatePeer(localhost)) {
      throw new Error("Localhost rejected incorrectly");
    }
    
    console.log("   ✅ Valid peers accepted");
    console.log("   ✅ Invalid peers rejected");
    console.log("   ✅ Private IPs blocked (except localhost)\n");
    passed++;
  } catch (err) {
    console.error(`   ❌ FAILED: ${err.message}\n`);
    failed++;
  }

  console.log("━".repeat(50));
  console.log(`\n📊 Final Results: ${passed}/${passed + failed} tests passed\n`);

  if (failed > 0) {
    console.error(`❌ ${failed} test(s) failed!\n`);
    process.exit(1);
  }

  console.log("✅ All core functionality tests passed!\n");
}

runTests().catch(err => {
  console.error("💥 Test suite crashed:", err);
  process.exit(1);
});
