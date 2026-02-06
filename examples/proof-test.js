/**
 * Test ZK proof generation
 */

const {
  randomBytes,
  generateCommitment,
  generateDepositProof,
} = require("../lib/proof");

async function main() {
  console.log("🧪 Testing ZK proof generation...\n");

  // Generate random secret & nullifier
  const secret = randomBytes(32);
  const nullifier = randomBytes(32);
  const amount = 1_000_000; // 1 USDC

  console.log("Secret:", secret.toString("hex").substring(0, 20) + "...");
  console.log("Nullifier:", nullifier.toString("hex").substring(0, 20) + "...");
  console.log("Amount:", amount, "USDC units\n");

  // Generate commitment
  const commitment = await generateCommitment(secret, nullifier);
  console.log("Commitment:", commitment.toString().substring(0, 20) + "...\n");

  // Generate deposit proof
  const { proof } = await generateDepositProof(secret, nullifier, amount);

  console.log("\n✅ Deposit proof generated successfully!");
  console.log("Proof A:", proof.proofA.length, "bytes");
  console.log("Proof B:", proof.proofB.length, "bytes");
  console.log("Proof C:", proof.proofC.length, "bytes");
  console.log("Public inputs:", proof.publicSignals.length);

  console.log("\n🎉 All tests passed!");
}

main().catch(console.error);
