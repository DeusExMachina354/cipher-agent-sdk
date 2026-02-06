/**
 * Transaction builders for deposit/withdraw
 */

const anchor = require("@coral-xyz/anchor");
const { PublicKey, SystemProgram } = require("@solana/web3.js");
const { getAssociatedTokenAddress } = require("@solana/spl-token");
const fs = require("fs");
const path = require("path");

const IDL = JSON.parse(fs.readFileSync(path.join(__dirname, "cipher.json"), "utf-8"));
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/**
 * Build and send deposit transaction
 */
async function sendDepositTransaction(
  connection,
  wallet,
  programId,
  usdcMint,
  proof,
  amount,
  chunkId
) {
  // Create wallet adapter
  const walletAdapter = {
    publicKey: wallet.publicKey,
    signTransaction: async (tx) => {
      // Sign with the keypair
      tx.partialSign(wallet);
      return tx;
    },
    signAllTransactions: async (txs) => {
      for (const tx of txs) {
        tx.partialSign(wallet);
      }
      return txs;
    },
  };
  
  // Setup Anchor provider
  const provider = new anchor.AnchorProvider(
    connection,
    walletAdapter,
    { commitment: "confirmed" }
  );

  // Anchor v0.30: IDL contains address, pass provider only
  const program = new anchor.Program(IDL, provider);
  
  // Verify programId matches (for safety)
  if (program.programId.toString() !== programId.toString()) {
    throw new Error(`Program ID mismatch! Expected ${programId}, got ${program.programId}`);
  }

  // Derive PDAs
  const [masterPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("master")],
    programId
  );

  const [escrowPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow")],
    programId
  );

  const [merkleRootPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("merkle_root")],
    programId
  );

  const toU32Bytes = (num) => {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(num, 0);
    return buf;
  };

  const toU16Bytes = (num) => {
    const buf = Buffer.alloc(2);
    buf.writeUInt16BE(num, 0);
    return buf;
  };

  const [merkleChunkPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("merkle_chunk"), toU32Bytes(chunkId)],
    programId
  );

  // Get current storage ID
  const chunkInfo = await connection.getAccountInfo(merkleChunkPda);
  if (!chunkInfo) {
    throw new Error("Chunk not initialized");
  }
  const currentStorageId = chunkInfo.data.readUInt16LE(12);

  const [leaveStoragePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("leave_storage"), toU32Bytes(chunkId), toU16Bytes(currentStorageId)],
    programId
  );

  const [newLeaveStoragePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("leave_storage"), toU32Bytes(chunkId), toU16Bytes(currentStorageId + 1)],
    programId
  );

  // Token accounts
  const userTokenAccount = await getAssociatedTokenAddress(
    usdcMint,
    wallet.publicKey
  );

  const escrowTokenAccount = await getAssociatedTokenAddress(
    usdcMint,
    escrowPda,
    true
  );

  // Format proof
  const depositProof = {
    proofA: Array.from(proof.proofA),
    proofB: Array.from(proof.proofB),
    proofC: Array.from(proof.proofC),
    publicInputs: proof.publicSignals.map(s => Array.from(s)),
  };

  // Send transaction with increased compute budget
  const { ComputeBudgetProgram } = require("@solana/web3.js");
  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({ 
    units: 1_000_000 
  });

  const tx = await program.methods
    .deposit(depositProof)
    .accounts({
      merkleChunk: merkleChunkPda,
      leaveStorage: leaveStoragePda,
      newLeaveStorage: newLeaveStoragePda,
      escrow: escrowPda,
      escrowTokenAccount: escrowTokenAccount,
      userTokenAccount: userTokenAccount,
      master: masterPda,
      merkleRootAccount: merkleRootPda,
      user: wallet.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([computeBudgetIx])
    .rpc();

  return tx;
}

/**
 * Build and send withdraw transaction
 */
async function sendWithdrawTransaction(
  connection,
  wallet,
  programId,
  usdcMint,
  proof,
  recipient,
  chunkId,
  nullifierHash
) {
  // Create wallet adapter
  const walletAdapter = {
    publicKey: wallet.publicKey,
    signTransaction: async (tx) => {
      tx.partialSign(wallet);
      return tx;
    },
    signAllTransactions: async (txs) => {
      for (const tx of txs) {
        tx.partialSign(wallet);
      }
      return txs;
    },
  };
  
  const provider = new anchor.AnchorProvider(
    connection,
    walletAdapter,
    { commitment: "confirmed" }
  );

  // Anchor v0.30: IDL contains address
  const program = new anchor.Program(IDL, provider);
  
  // Verify programId matches
  if (program.programId.toString() !== programId.toString()) {
    throw new Error(`Program ID mismatch! Expected ${programId}, got ${program.programId}`);
  }

  // Derive PDAs
  const [escrowPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow")],
    program.programId
  );

  const [merkleRootPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("merkle_root")],
    program.programId
  );

  const toU32Bytes = (num) => {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(num, 0);
    return buf;
  };

  const [merkleChunkPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("merkle_chunk"), toU32Bytes(chunkId)],
    program.programId
  );

  // Nullifier PDA
  const nullifierHashBuffer = Buffer.alloc(32);
  let nullifierHashBigIntMut = BigInt(nullifierHash);
  for (let i = 31; i >= 0; i--) {
    nullifierHashBuffer[i] = Number(nullifierHashBigIntMut & 0xffn);
    nullifierHashBigIntMut >>= 8n;
  }

  const [usedNullifierPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier"), nullifierHashBuffer],
    program.programId
  );

  // Token accounts
  const recipientTokenAccount = await getAssociatedTokenAddress(
    usdcMint,
    new PublicKey(recipient)
  );

  const escrowTokenAccount = await getAssociatedTokenAddress(
    usdcMint,
    escrowPda,
    true
  );

  // Format proof (matching frontend structure EXACTLY!)
  // publicSignals are STRINGS from groth16
  // Structure: [0-3] first signals, [4-35] recipient bytes, [36] last signal
  
  const to32ByteBuffer = (numStr) => {
    const num = BigInt(numStr);
    const buf = Buffer.alloc(32);
    for (let k = 0; k < 32; k++) {
      buf[31 - k] = Number((num >> BigInt(k * 8)) & BigInt(0xff));
    }
    return buf;
  };
  
  const recipientBuf = Buffer.from(proof.publicSignals.slice(4, 36).map(Number));
  
  const withdrawProof = {
    proofA: Array.from(proof.proofA),
    proofB: Array.from(proof.proofB),
    proofC: Array.from(proof.proofC),
    publicInputs: [
      ...proof.publicSignals.slice(0, 4).map(to32ByteBuffer).map(b => Array.from(b)),
      Array.from(recipientBuf),
      Array.from(to32ByteBuffer(proof.publicSignals[36]))
    ]
  };

  // Send transaction with increased compute budget
  const ix = await program.methods
    .withdraw(withdrawProof, chunkId)
    .accounts({
      usedNullifier: usedNullifierPda,
      signer: wallet.publicKey,
      recipient: recipientTokenAccount,
      escrow: escrowPda,
      escrowTokenAccount: escrowTokenAccount,
      recipientTokenAccount: recipientTokenAccount,
      merkleRootAccount: merkleRootPda,
      merkleChunk: merkleChunkPda,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  // Add compute budget instruction
  const { ComputeBudgetProgram } = require("@solana/web3.js");
  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({ 
    units: 1_000_000 
  });

  // Build and send transaction manually
  const tx = await program.methods
    .withdraw(withdrawProof, chunkId)
    .accounts({
      usedNullifier: usedNullifierPda,
      signer: wallet.publicKey,
      recipient: recipientTokenAccount,
      escrow: escrowPda,
      escrowTokenAccount: escrowTokenAccount,
      recipientTokenAccount: recipientTokenAccount,
      merkleRootAccount: merkleRootPda,
      merkleChunk: merkleChunkPda,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([computeBudgetIx])
    .rpc();

  return tx;
}

module.exports = {
  sendDepositTransaction,
  sendWithdrawTransaction,
};
