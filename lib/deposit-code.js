/**
 * Deposit Code Encoding/Decoding
 * 
 * Format: version(1) + nullifier(32) + secret(32) + chunkId(4) + amount(8)
 * Encoding: Base58 (like Bitcoin addresses)
 */

const bs58 = require("bs58");

// Buffer layout constants
const VERSION_BYTE_SIZE = 1;
const NULLIFIER_SIZE = 32;
const SECRET_SIZE = 32;
const CHUNK_ID_SIZE = 4;
const AMOUNT_SIZE = 8;

// Total size for V1
const V1_TOTAL_SIZE = VERSION_BYTE_SIZE + NULLIFIER_SIZE + SECRET_SIZE + CHUNK_ID_SIZE + AMOUNT_SIZE;
const CURRENT_VERSION = 1;

/**
 * Encode deposit info into a base58 string
 * 
 * @param {Buffer} secret - 32 random bytes
 * @param {Buffer} nullifier - 32 random bytes
 * @param {number} chunkId - Chunk ID
 * @param {number} amount - Amount in USDC units
 * @returns {string} Base58 encoded deposit code
 */
function encodeDepositCode(secret, nullifier, chunkId, amount) {
  const buf = Buffer.alloc(V1_TOTAL_SIZE);
  
  // Write version
  buf.writeUInt8(CURRENT_VERSION, 0);
  
  // Write data
  const offset = VERSION_BYTE_SIZE;
  nullifier.copy(buf, offset);
  secret.copy(buf, offset + NULLIFIER_SIZE);
  buf.writeUInt32BE(chunkId, offset + NULLIFIER_SIZE + SECRET_SIZE);
  buf.writeBigUInt64BE(BigInt(amount), offset + NULLIFIER_SIZE + SECRET_SIZE + CHUNK_ID_SIZE);
  
  // Encode to base58
  return bs58.encode(buf);
}

/**
 * Decode base58 deposit code
 * 
 * @param {string} code - Base58 encoded deposit code
 * @returns {Object} { version, secret, nullifier, chunkId, amount }
 */
function decodeDepositCode(code) {
  const buf = Buffer.from(bs58.decode(code));
  
  if (buf.length < VERSION_BYTE_SIZE) {
    throw new Error("Invalid deposit code: too short");
  }
  
  const version = buf.readUInt8(0);
  const offset = VERSION_BYTE_SIZE;
  
  if (version === 1) {
    if (buf.length !== V1_TOTAL_SIZE) {
      throw new Error(`Invalid V1 deposit code length: expected ${V1_TOTAL_SIZE}, got ${buf.length}`);
    }
    
    const nullifierBuf = buf.subarray(offset, offset + NULLIFIER_SIZE);
    const secretBuf = buf.subarray(offset + NULLIFIER_SIZE, offset + NULLIFIER_SIZE + SECRET_SIZE);
    const chunkId = buf.readUInt32BE(offset + NULLIFIER_SIZE + SECRET_SIZE);
    const amount = Number(buf.readBigUInt64BE(offset + NULLIFIER_SIZE + SECRET_SIZE + CHUNK_ID_SIZE));
    
    // Return BUFFERS (not strings) - for consistency with proof.js
    return {
      version,
      secret: secretBuf,
      nullifier: nullifierBuf,
      chunkId,
      amount,
    };
  } else {
    throw new Error(`Unsupported deposit code version: ${version}`);
  }
}

module.exports = {
  encodeDepositCode,
  decodeDepositCode,
};
