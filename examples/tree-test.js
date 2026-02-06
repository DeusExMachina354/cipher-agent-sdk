/**
 * Test tree building from on-chain data
 */

const CipherAgent = require("../lib/index");
const { Keypair } = require("@solana/web3.js");

async function main() {
  console.log("🧪 Testing tree building...\n");

  const agent = new CipherAgent({
    keypair: Keypair.generate(),
    rpcUrl: "https://api.devnet.solana.com",
  });

  // Check contract status
  const status = await agent.getContractStatus();
  console.log("Contract Status:", status);

  if (!status.initialized) {
    console.log("\n❌ Contract not initialized");
    return;
  }

  // Load tree for current chunk
  console.log("\n📥 Loading tree for chunk", status.currentChunkId, "...");
  await agent.loadTree(status.currentChunkId);

  // Check tree
  const treeData = agent.treeBuilder.trees[status.currentChunkId];
  console.log("\n✅ Tree loaded!");
  console.log("Leaves:", treeData.leaves.length);
  console.log("Tree nodes:", treeData.tree.length);

  // Test path generation (if we have leaves)
  if (treeData.leaves.length > 0) {
    console.log("\n🧪 Testing path generation for leaf 0...");
    const path = agent.treeBuilder.getMerklePath(status.currentChunkId, 0);
    console.log("Path elements:", path.pathElements.length);
    console.log("Root:", path.root.substring(0, 20) + "...");
  }

  console.log("\n✅ Test complete!");
  agent.stop();
}

main().catch(console.error);
