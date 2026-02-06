/**
 * Zero-Knowledge Proof Generation
 * 
 * Wraps snarkjs for deposit/withdraw proof generation
 */

const { groth16 } = require("snarkjs");
const { buildPoseidon } = require("circomlibjs");
const crypto = require("crypto");
const path = require("path");

// Circuit paths
const CIRCUITS_DIR = path.join(__dirname, "..", "circuits");
const DEPOSIT_WASM = path.join(CIRCUITS_DIR, "deposit.wasm");
const DEPOSIT_ZKEY = path.join(CIRCUITS_DIR, "deposit_final.zkey");
const WITHDRAW_WASM = path.join(CIRCUITS_DIR, "withdraw.wasm");
const WITHDRAW_ZKEY = path.join(CIRCUITS_DIR, "withdraw_final.zkey");

let poseidon = null;

/**
 * Initialize Poseidon hash
 */
async function initPoseidon() {
  if (!poseidon) {
    poseidon = await buildPoseidon();
  }
  return poseidon;
}

/**
 * Generate random bytes
 */
function randomBytes(length) {
  return crypto.randomBytes(length);
}

/**
 * Compute Poseidon hash
 */
async function hash(...inputs) {
  await initPoseidon();
  const h = poseidon(inputs);
  return BigInt(poseidon.F.toObject(h));
}

/**
 * Generate commitment from secret, nullifier, and amount
 * MUST match circuit: poseidon([nullifier, secret, amount])
 */
async function generateCommitment(secret, nullifier, amount) {
  const secretBigInt = BigInt('0x' + secret.toString('hex'));
  const nullifierBigInt = BigInt('0x' + nullifier.toString('hex'));
  const amountBigInt = BigInt(amount);
  
  // Commitment = Poseidon(nullifier, secret, amount)
  return await hash(nullifierBigInt, secretBigInt, amountBigInt);
}

/**
 * Format proof for Solana contract
 */
function formatProof(proof, publicSignals) {
  const toBytes = (numStr) => {
    const num = BigInt(numStr);
    const buf = Buffer.alloc(32);
    let temp = num;
    for (let i = 31; i >= 0; i--) {
      buf[i] = Number(temp & 0xffn);
      temp >>= 8n;
    }
    return buf;
  };

  return {
    proofA: Buffer.concat([
      toBytes(proof.pi_a[0]),
      toBytes(proof.pi_a[1]),
    ]),
    proofB: Buffer.concat([
      toBytes(proof.pi_b[0][1]),
      toBytes(proof.pi_b[0][0]),
      toBytes(proof.pi_b[1][1]),
      toBytes(proof.pi_b[1][0]),
    ]),
    proofC: Buffer.concat([
      toBytes(proof.pi_c[0]),
      toBytes(proof.pi_c[1]),
    ]),
    publicSignals: publicSignals.map(s => toBytes(s)),
  };
}

/**
 * Generate deposit proof
 * 
 * @param {Buffer} secret - 32 random bytes
 * @param {Buffer} nullifier - 32 random bytes
 * @param {number} amount - Deposit amount (in USDC units, e.g. 1_000_000 for 1 USDC)
 * @returns {Object} { proof, commitment, secret, nullifier }
 */
async function generateDepositProof(secret, nullifier, amount) {
  console.log("🔐 Generating deposit proof...");
  const start = Date.now();

  // Convert to BigInt
  const secretBigInt = BigInt('0x' + secret.toString('hex'));
  const nullifierBigInt = BigInt('0x' + nullifier.toString('hex'));
  const commitment = await generateCommitment(secret, nullifier, amount);

  // Circuit input
  const input = {
    nullifier: nullifierBigInt.toString(),
    secret: secretBigInt.toString(),
    deposit_amount: amount.toString(),
  };

  // Generate proof
  const { proof, publicSignals } = await groth16.fullProve(
    input,
    DEPOSIT_WASM,
    DEPOSIT_ZKEY
  );

  const formatted = formatProof(proof, publicSignals);

  const elapsed = ((Date.now() - start) / 1000).toFixed(2);
  console.log(`✅ Deposit proof generated in ${elapsed}s`);

  return {
    proof: formatted,
    commitment: commitment.toString(),
    secret,
    nullifier,
  };
}

/**
 * Generate withdraw proof
 * 
 * @param {Buffer} secret - Secret from deposit
 * @param {Buffer} nullifier - Nullifier from deposit
 * @param {string} recipient - Recipient public key (base58)
 * @param {number} amount - Withdraw amount
 * @param {Array<string>} pathElements - Merkle path elements
 * @param {Array<number>} pathIndices - Merkle path indices
 * @param {string} root - Merkle root
 * @param {number} relayerFee - Relayer fee (0 for now)
 * @returns {Object} { proof }
 */
async function generateWithdrawProof(
  secret,
  nullifier,
  recipient,
  amount,
  pathElements,
  pathIndices,
  root,
  relayerFee = 0
) {
  console.log("🔓 Generating withdraw proof...");
  const start = Date.now();

  // Convert to BigInt
  const secretBigInt = BigInt('0x' + secret.toString('hex'));
  const nullifierBigInt = BigInt('0x' + nullifier.toString('hex'));
  const commitment = await generateCommitment(secret, nullifier, amount);

  // Compute nullifier hash (matching frontend: poseidon([nullifier, 0]))
  const nullifierHash = await hash(nullifierBigInt, BigInt(0));

  // Convert recipient address (base58) to bytes
  const { PublicKey } = require("@solana/web3.js");
  const recipientPubkey = new PublicKey(recipient);
  const recipientBytes = Array.from(recipientPubkey.toBytes());

  // Circuit input (matching frontend exactly!)
  const input = {
    root: root.toString(),
    withdraw_amount: amount.toString(),
    nullifierHash: nullifierHash.toString(),
    recipient: recipientBytes,  // Array of numbers
    fee: relayerFee.toString(),
    nullifier: nullifierBigInt.toString(),
    secret: secretBigInt.toString(),
    pathElements: pathElements,
    pathIndices: pathIndices,
  };

  // Generate proof
  const { proof, publicSignals } = await groth16.fullProve(
    input,
    WITHDRAW_WASM,
    WITHDRAW_ZKEY
  );

  // For withdraw, keep publicSignals as strings (not Buffers!)
  const toBytes = (numStr) => {
    const num = BigInt(numStr);
    const buf = Buffer.alloc(32);
    let temp = num;
    for (let i = 31; i >= 0; i--) {
      buf[i] = Number(temp & 0xffn);
      temp >>= 8n;
    }
    return buf;
  };

  const formatted = {
    proofA: Buffer.concat([
      toBytes(proof.pi_a[0]),
      toBytes(proof.pi_a[1]),
    ]),
    proofB: Buffer.concat([
      toBytes(proof.pi_b[0][1]),
      toBytes(proof.pi_b[0][0]),
      toBytes(proof.pi_b[1][1]),
      toBytes(proof.pi_b[1][0]),
    ]),
    proofC: Buffer.concat([
      toBytes(proof.pi_c[0]),
      toBytes(proof.pi_c[1]),
    ]),
    publicSignals: publicSignals,  // Keep as strings!
  };

  const elapsed = ((Date.now() - start) / 1000).toFixed(2);
  console.log(`✅ Withdraw proof generated in ${elapsed}s`);

  return {
    proof: formatted,
    nullifierHash: nullifierHash.toString(),
  };
}

module.exports = {
  randomBytes,
  generateCommitment,
  generateDepositProof,
  generateWithdrawProof,
};
