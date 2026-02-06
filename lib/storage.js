/**
 * Persistent storage for deposit codes
 * 
 * Saves deposit codes to ~/.cipher/deposits.json
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const DEFAULT_STORAGE_DIR = path.join(os.homedir(), ".cipher");
const DEFAULT_STORAGE_FILE = path.join(DEFAULT_STORAGE_DIR, "deposits.json");

class DepositStorage {
  constructor(storageFile = DEFAULT_STORAGE_FILE) {
    this.storageFile = storageFile;
    this.ensureStorageDir();
  }

  /**
   * Ensure storage directory exists with secure permissions
   */
  ensureStorageDir() {
    const dir = path.dirname(this.storageFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    
    // Verify directory permissions
    try {
      const stats = fs.statSync(dir);
      const mode = stats.mode & 0o777;
      if (mode !== 0o700) {
        console.warn(`⚠️  WARNING: ${dir} has insecure permissions (${mode.toString(8)})`);
        console.warn(`   Run: chmod 700 ${dir}`);
      }
    } catch (err) {
      // Ignore permission check errors on Windows
    }
  }

  /**
   * Load all deposits from file
   * @returns {Array} Array of deposit records
   */
  loadDeposits() {
    if (!fs.existsSync(this.storageFile)) {
      return [];
    }

    try {
      const data = fs.readFileSync(this.storageFile, "utf-8");
      return JSON.parse(data);
    } catch (err) {
      console.warn("Failed to load deposits:", err.message);
      return [];
    }
  }

  /**
   * Save deposits to file with secure permissions
   * 
   * SECURITY NOTE: Deposits contain secrets that can be used to withdraw funds.
   * File is saved with 0600 permissions (owner read/write only).
   * 
   * @param {Array} deposits - Array of deposit records
   */
  saveDeposits(deposits) {
    try {
      // Write to temp file first (atomic write pattern)
      const tempFile = `${this.storageFile}.tmp`;
      fs.writeFileSync(
        tempFile,
        JSON.stringify(deposits, null, 2),
        { mode: 0o600 }
      );
      
      // Atomic rename
      fs.renameSync(tempFile, this.storageFile);
      
      // Verify permissions on final file
      const stats = fs.statSync(this.storageFile);
      const mode = stats.mode & 0o777;
      if (mode > 0o600) {
        console.warn(`⚠️  WARNING: ${this.storageFile} has insecure permissions`);
        console.warn(`   Run: chmod 600 ${this.storageFile}`);
        // Try to fix automatically
        try {
          fs.chmodSync(this.storageFile, 0o600);
        } catch (chmodErr) {
          console.error("   Failed to fix permissions automatically");
        }
      }
    } catch (err) {
      console.error("Failed to save deposits:", err.message);
      throw err;
    }
  }

  /**
   * Add a new deposit
   * @param {string} code - Base58 encoded deposit code
   * @param {string} txId - Transaction ID
   * @param {Object} metadata - Additional metadata
   */
  addDeposit(code, txId, metadata = {}) {
    const deposits = this.loadDeposits();
    deposits.push({
      code,
      txId,
      withdrawn: false,
      timestamp: new Date().toISOString(),
      ...metadata,
    });
    this.saveDeposits(deposits);
  }

  /**
   * Find an unwithdrawn deposit
   * @param {number} [amount] - Optional amount filter
   * @returns {Object|null} Deposit record or null
   */
  findUnwithdrawnDeposit(amount = null) {
    const deposits = this.loadDeposits();
    
    if (amount !== null) {
      return deposits.find(d => !d.withdrawn && d.amount === amount) || null;
    }
    
    return deposits.find(d => !d.withdrawn) || null;
  }

  /**
   * Mark deposit as withdrawn
   * @param {string} code - Deposit code
   * @param {string} withdrawTxId - Withdraw transaction ID
   */
  markAsWithdrawn(code, withdrawTxId) {
    const deposits = this.loadDeposits();
    const deposit = deposits.find(d => d.code === code);
    
    if (deposit) {
      deposit.withdrawn = true;
      deposit.withdrawTxId = withdrawTxId;
      deposit.withdrawTimestamp = new Date().toISOString();
      this.saveDeposits(deposits);
    }
  }

  /**
   * Get all deposits
   * @returns {Array} All deposit records
   */
  getAllDeposits() {
    return this.loadDeposits();
  }

  /**
   * Get deposit statistics
   * @returns {Object} Stats
   */
  getStats() {
    const deposits = this.loadDeposits();
    return {
      total: deposits.length,
      withdrawn: deposits.filter(d => d.withdrawn).length,
      pending: deposits.filter(d => !d.withdrawn).length,
    };
  }
}

module.exports = DepositStorage;
