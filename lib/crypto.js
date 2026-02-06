/**
 * Shared cryptographic utilities
 * 
 * Provides single Poseidon instance shared across all modules
 * to avoid duplicate initialization and memory waste.
 */

const { buildPoseidon } = require("circomlibjs");

// Single Poseidon instance (lazy-initialized)
let poseidon = null;
let initPromise = null;

/**
 * Get or initialize Poseidon hash function
 * 
 * PERFORMANCE: Shared instance across proof.js and tree.js
 * Avoids duplicate initialization (~500ms + memory)
 * 
 * @returns {Promise<Object>} Poseidon hash function
 */
async function getPoseidon() {
  if (poseidon) {
    return poseidon;
  }
  
  // If init is in progress, wait for it
  if (initPromise) {
    return await initPromise;
  }
  
  // Start init
  initPromise = buildPoseidon();
  poseidon = await initPromise;
  initPromise = null;
  
  return poseidon;
}

/**
 * Pre-initialize Poseidon (call at agent startup)
 * Avoids lazy-init delay on first proof
 */
async function initPoseidon() {
  await getPoseidon();
}

module.exports = {
  getPoseidon,
  initPoseidon,
};
