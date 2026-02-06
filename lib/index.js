const {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} = require("@solana/web3.js");
const {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} = require("@solana/spl-token");
const anchor = require("@coral-xyz/anchor");
const fs = require("fs");
const path = require("path");
const MerkleTreeBuilder = require("./tree");
const TreeP2P = require("./p2p");
const RelayerService = require("./relayer");
const { initPoseidon } = require("./crypto");
const {
  randomBytes,
  generateDepositProof,
  generateWithdrawProof,
} = require("./proof");
const {
  sendDepositTransaction,
  sendWithdrawTransaction,
} = require("./transactions");
const DepositStorage = require("./storage");
const { encodeDepositCode, decodeDepositCode } = require("./deposit-code");

const PROGRAM_ID = new PublicKey("Dn1AjFeQbQsv3ufRw9KbPKQmp1is8VhGPVsKodqA4WLN");
const IDL = JSON.parse(fs.readFileSync(path.join(__dirname, "cipher.json"), "utf-8"));
const USDC_DEVNET = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"); // USDC devnet
const DEPOSIT_AMOUNT = 1_000_000; // 1 USDC

class CipherAgent {
  constructor(config = {}) {
    this.rpcUrl = config.rpcUrl || "https://api.devnet.solana.com";
    this.connection = new Connection(this.rpcUrl, "confirmed");
    
    // SECURITY: Use isolated agent wallet instead of user's main wallet
    const agentWalletPath = path.join(require('os').homedir(), '.cipher', 'agent-wallet.json');
    
    if (config.keypair) {
      // Manual keypair override (for testing)
      if (typeof config.keypair === "string") {
        this._validateKeypairFile(config.keypair);
        const keypairData = JSON.parse(fs.readFileSync(config.keypair, "utf-8"));
        if (!Array.isArray(keypairData) || keypairData.length !== 64) {
          throw new Error("Invalid keypair format: expected 64-byte array");
        }
        this.wallet = Keypair.fromSecretKey(Uint8Array.from(keypairData));
      } else {
        this.wallet = config.keypair;
      }
    } else if (fs.existsSync(agentWalletPath)) {
      // Load existing agent wallet
      // SECURITY: Validate file permissions before loading
      this._validateKeypairFile(agentWalletPath);
      const walletData = JSON.parse(fs.readFileSync(agentWalletPath, 'utf-8'));
      this.wallet = Keypair.fromSecretKey(Uint8Array.from(walletData));
      console.log("📂 Loaded agent wallet:", this.wallet.publicKey.toBase58());
    } else {
      // First run: generate new isolated wallet
      this.wallet = Keypair.generate();
      const walletArray = Array.from(this.wallet.secretKey);
      
      // Save wallet securely
      const cipherDir = path.dirname(agentWalletPath);
      if (!fs.existsSync(cipherDir)) {
        fs.mkdirSync(cipherDir, { recursive: true, mode: 0o700 });
        // SECURITY FIX: Explicit chmod for macOS (umask can override mode param)
        fs.chmodSync(cipherDir, 0o700);
      }
      fs.writeFileSync(agentWalletPath, JSON.stringify(walletArray), { mode: 0o600 });
      
      console.log("\n🆕 FIRST RUN - Agent Wallet Created!");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log("📍 Wallet Address:", this.wallet.publicKey.toBase58());
      console.log("🔑 Private key stored securely");
      console.log("💾 Saved to:", agentWalletPath);
      console.log("\n⚠️  IMPORTANT - Send funds to this address:");
      console.log("   1. SOL (for transaction fees): ~0.1 SOL");
      console.log("   2. USDC (for mixing): at least 2 USDC");
      console.log("\n   Devnet Faucets:");
      console.log("   - SOL: https://faucet.solana.com");
      console.log("   - USDC: https://faucet.circle.com");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    }

    this.usdcMint = config.usdcMint ? new PublicKey(config.usdcMint) : USDC_DEVNET;
    this.programId = config.programId ? new PublicKey(config.programId) : PROGRAM_ID;
    
    this.isRunning = false;
    this.depositCount = 0;
    this.withdrawCount = 0;
    
    // Tree builder & P2P
    this.treeBuilder = new MerkleTreeBuilder(this.programId, this.connection);
    this.p2p = new TreeP2P(this.treeBuilder, {
      port: config.p2pPort || 8547,
      discoveryPort: config.discoveryPort,
      dhtPort: config.dhtPort,
    });
    
    // Relayer service
    this.relayer = new RelayerService(this, {
      maxDelay: config.relayerMaxDelay || 60000,
      minDelay: config.relayerMinDelay || 30000,
    });
    
    // Persistent storage for deposits
    this.storage = new DepositStorage();
    
    // Store deposits for later withdraws (legacy RAM storage)
    this.deposits = []; // { commitment, nullifier, chunkId, leafIndex }
    
    // Background tree update interval
    this.treeUpdateInterval = null;
    
    // PERFORMANCE: Pre-initialize Poseidon to avoid lazy-init delay on first proof
    // Eliminates timing fingerprint on first operation
    initPoseidon().catch(err => {
      console.warn("Failed to pre-initialize Poseidon:", err.message);
    });
  }
  
  /**
   * Start background tree updates (every 5 minutes)
   */
  startTreeUpdates(chunkId = 1, intervalMs = 5 * 60 * 1000) {
    if (this.treeUpdateInterval) {
      console.log("⚠️  Tree updates already running");
      return;
    }
    
    console.log(`🔄 Starting background tree updates (every ${intervalMs / 1000}s)`);
    
    // Initial load
    this.loadTree(chunkId).catch(err => {
      console.error("❌ Initial tree load failed:", err.message);
    });
    
    // Periodic updates
    this.treeUpdateInterval = setInterval(async () => {
      try {
        await this.loadTree(chunkId);
      } catch (err) {
        console.error("❌ Tree update failed:", err.message);
      }
    }, intervalMs);
  }
  
  /**
   * Stop background tree updates
   */
  stopTreeUpdates() {
    if (this.treeUpdateInterval) {
      clearInterval(this.treeUpdateInterval);
      this.treeUpdateInterval = null;
      console.log("✅ Stopped background tree updates");
    }
  }

  /**
   * Load Merkle tree for a chunk (cache -> peers -> chain)
   * Uses incremental updates when possible!
   */
  async loadTree(chunkId) {
    console.log(`🌳 Loading tree for chunk ${chunkId}...`);
    
    // Check if we have a tree in memory already
    const existingTree = this.treeBuilder.trees[chunkId];
    
    // Fetch current leaves from chain
    const currentLeaves = await this.treeBuilder.fetchLeavesFromChain(chunkId);
    
    if (existingTree && existingTree.leaves.length === currentLeaves.length) {
      console.log("✅ Tree already up-to-date in memory");
      return;
    }
    
    if (existingTree && currentLeaves.length > existingTree.leaves.length) {
      // Incremental update (FAST!)
      console.log(`🔄 Incremental update (${existingTree.leaves.length} -> ${currentLeaves.length} leaves)...`);
      await this.treeBuilder.updateTree(chunkId, currentLeaves);
      this.p2p.saveTreeCache(chunkId);
      return;
    }
    
    // No existing tree, try cache first
    const cacheResult = this.p2p.loadTreeCache(chunkId);
    
    if (cacheResult === true) {
      // Complete tree loaded from cache (instant!)
      console.log("✅ Using complete cached tree (instant!)");
      return;
    } else if (cacheResult && cacheResult.length === currentLeaves.length) {
      // Legacy: only leaves cached, need to build
      console.log("✅ Using cached leaves (need to build)");
      await this.treeBuilder.buildTree(chunkId, cacheResult);
      return;
    }

    // Try fetching COMPLETE tree from peers (instant!)
    await this.p2p.discoverPeers();
    const gotCompleteTree = await this.p2p.fetchCompleteTreeFromPeers(chunkId);
    
    if (gotCompleteTree) {
      console.log("✅ Using complete tree from peer (instant!)");
      this.p2p.saveTreeCache(chunkId);
      return;
    }

    // Full build from chain
    console.log("🔨 Building tree from on-chain data...");
    await this.treeBuilder.buildTree(chunkId, currentLeaves);
    this.p2p.saveTreeCache(chunkId);
    console.log("✅ Tree ready");
  }

  /**
   * Start P2P server to share trees + discovery + relayer
   */
  async startP2P() {
    await this.p2p.startServer();
    await this.p2p.startBroadcast();
    await this.p2p.startDHT();
    
    // Add relayer endpoints to HTTP server
    this.relayer.addEndpoints(this.p2p.server);
    console.log('✅ Relayer service ready');
  }

  /**
   * Stop P2P server
   */
  stopP2P() {
    this.p2p.stopServer();
  }

  /**
   * Get agent's USDC balance
   */
  async getBalance() {
    const tokenAccount = await getAssociatedTokenAddress(
      this.usdcMint,
      this.wallet.publicKey
    );

    try {
      const balance = await this.connection.getTokenAccountBalance(tokenAccount);
      // FIX: uiAmount is already in human-readable form (e.g., 34.0)
      // Return raw amount (e.g., 34000000) to match expected format
      return parseInt(balance.value.amount);
    } catch {
      return 0;
    }
  }

  /**
   * Deposit USDC into the mixer with ZK proof
   */
  async deposit(amount = DEPOSIT_AMOUNT) {
    console.log("🔒 Depositing", amount / 1e6, "USDC...");
    
    // 1. Generate secret & nullifier
    const secret = randomBytes(32);
    const nullifier = randomBytes(32);
    
    // 2. Generate ZK proof
    const { proof, commitment } = await generateDepositProof(secret, nullifier, amount);
    
    // 3. Get current chunk ID
    const status = await this.getContractStatus();
    const chunkId = status.currentChunkId;
    
    // 4. Send transaction
    try {
      const txId = await sendDepositTransaction(
        this.connection,
        this.wallet,
        this.programId,
        this.usdcMint,
        proof,
        amount,
        chunkId
      );
      
      console.log("✅ Deposit successful!");
      console.log("   TX:", txId);
      // PRIVACY: Don't log commitment in production (reduces anonymity set)
      if (process.env.DEBUG) {
        console.log("   Commitment:", commitment.substring(0, 40) + "...");
      }
      
      // Store deposit for later withdraw (RAM - legacy)
      this.deposits.push({
        secret,
        nullifier,
        commitment,
        chunkId,
        leafIndex: null, // TODO: Query from chain events
        amount,
        txId,
      });
      
      // Store deposit code on disk (persistent)
      const depositCode = encodeDepositCode(secret, nullifier, chunkId, amount);
      await this.storage.addDeposit(depositCode, txId, { commitment, amount });
      console.log("💾 Deposit code saved to ~/.cipher/deposits.json");
      // PRIVACY: Don't log deposit code (contains secret)
      if (process.env.DEBUG) {
        console.log("   Code:", depositCode);
      }
      
      this.depositCount++;
      return { 
        success: true, 
        txId,
        commitment,
        depositCode, // Return code for user backup
      };
    } catch (err) {
      console.error("❌ Deposit failed:", err.message);
      throw err;
    }
  }

  /**
   * Withdraw USDC from the mixer with ZK proof
   */
  async withdraw(recipient, amount = DEPOSIT_AMOUNT) {
    console.log("🔓 Withdrawing", amount / 1e6, "USDC to", recipient?.toBase58?.() || recipient);
    
    // 1. Find a deposit to withdraw (try persistent storage first)
    let deposit = this.deposits.find(d => d.amount === amount && !d.withdrawn);
    
    // If not in RAM, try loading from disk
    if (!deposit) {
      console.log("💾 Loading deposit from storage...");
      const depositRecord = await this.storage.findUnwithdrawnDeposit(amount);
      
      if (!depositRecord) {
        throw new Error("No matching deposit found. Deposit first!");
      }
      
      // Decode deposit code
      const decoded = decodeDepositCode(depositRecord.code);
      deposit = {
        secret: decoded.secret,
        nullifier: decoded.nullifier,
        chunkId: decoded.chunkId,
        amount: decoded.amount,
        commitment: depositRecord.commitment,
        leafIndex: null,
        depositCode: depositRecord.code,
      };
      
      console.log("✅ Loaded deposit from storage");
    }
    
    // 2. Load tree for this chunk
    await this.loadTree(deposit.chunkId);
    
    // 3. Get Merkle path
    if (deposit.leafIndex === null) {
      console.log("⚠️  Leaf index not tracked. Trying to find commitment in tree...");
      
      // Try to find the commitment in the tree
      const treeData = this.treeBuilder.trees[deposit.chunkId];
      if (treeData) {
        const commitmentBigInt = BigInt(deposit.commitment);
        const leafIndex = treeData.leaves.findIndex(leaf => leaf === commitmentBigInt);
        
        if (leafIndex >= 0) {
          console.log("✅ Found commitment at index", leafIndex);
          deposit.leafIndex = leafIndex;
        } else {
          throw new Error("Commitment not found in tree. TX may not be confirmed yet.");
        }
      }
    }
    
    const path = this.treeBuilder.getMerklePath(deposit.chunkId, deposit.leafIndex);
    
    // 4. Generate ZK proof
    const { proof, nullifierHash } = await generateWithdrawProof(
      deposit.secret,
      deposit.nullifier,
      recipient.toBase58(),
      amount,
      path.pathElements,
      path.pathIndices,
      path.root,
      0 // No relayer fee
    );
    
    console.log("✅ Withdraw proof generated!");
    // PRIVACY: Don't log nullifier hash (enables correlation)
    if (process.env.DEBUG) {
      console.log("   Nullifier hash:", nullifierHash.substring(0, 20) + "...");
    }
    
    // 5. Submit to relayer (MANDATORY!)
    try {
      const relayerUrl = await this.selectRelayer();
      
      console.log(`\n📤 Submitting withdraw to relayer: ${relayerUrl}`);
      
      // SECURITY FIX: Mark as withdrawn BEFORE submitting to prevent double-spend
      // If agent crashes after submit but before mark, deposit could be reused
      const originalWithdrawnState = deposit.withdrawn;
      deposit.withdrawn = true; // Optimistic lock
      
      // Mark in persistent storage FIRST (atomic operation)
      if (deposit.depositCode) {
        await this.storage.markAsWithdrawn(deposit.depositCode, 'PENDING');
        console.log("💾 Deposit pre-marked as pending withdrawal (double-spend protection)");
      }
      
      try {
        // SECURITY: Use AbortController for timeout (prevents hanging)
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout
        
        const response = await fetch(`${relayerUrl}/relayer/submit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            proof,
            recipient: recipient.toBase58(),
            amount,
            chunkId: deposit.chunkId,
          }),
          signal: controller.signal,
        });
        
        clearTimeout(timeoutId);

        if (!response.ok) {
          const error = await response.json();
          throw new Error(`Relayer rejected: ${error.error}`);
        }

        const result = await response.json();
        console.log("✅ Withdraw queued by relayer!");
        console.log("   Queue ID:", result.queueId);
        console.log("   Estimated execution:", new Date(result.estimatedExecutionTime).toISOString());
        
        // Update with actual queue ID
        deposit.relayerQueueId = result.queueId;
        
        // Update persistent storage with queue ID
        if (deposit.depositCode) {
          await this.storage.markAsWithdrawn(deposit.depositCode, result.queueId);
        }
        
        return { 
          success: true, 
          queueId: result.queueId,
          relayerUrl,
          estimatedExecutionTime: result.estimatedExecutionTime,
          nullifierHash,
        };
      } catch (fetchErr) {
        clearTimeout(timeoutId);
        
        // SECURITY FIX: Rollback withdrawn state on error (prevent stuck deposits)
        deposit.withdrawn = originalWithdrawnState;
        if (deposit.depositCode) {
          // TODO: Implement rollback in storage (for now just log)
          console.warn("⚠️  Relayer submit failed - deposit may need manual rollback");
        }
        
        if (fetchErr.name === 'AbortError') {
          throw new Error('Relayer request timed out after 30s');
        }
        throw fetchErr;
      }
    } catch (err) {
      console.error("❌ Relayer submission failed:", err.message);
      throw err;
    }
  }

  /**
   * Execute a withdrawal (called by relayer after delay)
   * 
   * SECURITY FIX: Added this method to fix relayer crash.
   * Relayer queue processing calls this to actually submit the withdraw TX.
   * 
   * @param {string} recipient - Recipient public key (base58)
   * @param {number} amount - Amount to withdraw
   * @param {Object} proof - ZK proof object
   * @param {number} chunkId - Merkle tree chunk ID
   * @returns {Promise<Object>} Transaction result
   */
  async executeWithdraw(recipient, amount, proof, chunkId) {
    console.log("🔓 Executing withdraw via relayer...");
    
    // Convert recipient to PublicKey if string
    const recipientPubkey = typeof recipient === 'string' 
      ? new PublicKey(recipient) 
      : recipient;
    
    // Extract nullifier hash from proof public signals
    const nullifierHash = proof.publicSignals[0];
    
    // Execute the actual withdraw transaction
    const txId = await sendWithdrawTransaction(
      this.connection,
      this.wallet,
      this.programId,
      this.usdcMint,
      proof,
      recipientPubkey,
      chunkId,
      nullifierHash
    );
    
    this.withdrawCount++;
    console.log("✅ Withdraw executed! TX:", txId);
    
    return { txId, success: true };
  }

  /**
   * Select a relayer to use (peer or self)
   */
  async selectRelayer() {
    // Get list of peers
    const peers = Array.from(this.p2p.peers.values());
    
    if (peers.length === 0) {
      // No peers - use self-relay
      console.log("   No peer relayers available, using self-relay");
      return `http://localhost:${this.p2p.port}`;
    }

    // Filter peers that have relayer service (check /relayer/status)
    const relayerPeers = [];
    
    for (const peer of peers) {
      try {
        // Use AbortController for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        
        const response = await fetch(`http://${peer.host}:${peer.port}/relayer/status`, {
          signal: controller.signal,
        });
        
        clearTimeout(timeoutId);
        
        if (response.ok) {
          const status = await response.json();
          relayerPeers.push({
            url: `http://${peer.host}:${peer.port}`,
            queueLength: status.queueLength,
          });
        }
      } catch (err) {
        // Peer doesn't have relayer or unreachable (includes timeout)
        if (process.env.DEBUG && err.name !== 'AbortError') {
          console.debug(`Relayer status check failed for ${peer.host}:${peer.port}:`, err.message);
        }
      }
    }

    if (relayerPeers.length === 0) {
      // No peer relayers available - use self
      console.log("   No peer relayers responding, using self-relay");
      return `http://localhost:${this.p2p.port}`;
    }

    // Select relayer with shortest queue
    relayerPeers.sort((a, b) => a.queueLength - b.queueLength);
    const selected = relayerPeers[0];
    
    console.log(`   Selected relayer: ${selected.url} (queue: ${selected.queueLength})`);
    return selected.url;
  }

  /**
   * Start auto-mixing loop with random delays and fresh wallets
   */
  async start(options = {}) {
    const {
      depositInterval = [5, 15], // [min, max] in minutes
      withdrawInterval = [10, 30], // [min, max] in minutes
      amount = DEPOSIT_AMOUNT,
      mode = 'continuous', // 'continuous' or 'batch'
      generateNewWallets = true,
      minBalance = 2 * DEPOSIT_AMOUNT, // Stop if balance too low
      maxRunTime = null, // Optional max runtime in ms
    } = options;

    console.log("\n🤖 Cipher Agent Starting...");
    console.log("Wallet:", this.wallet.publicKey.toBase58());
    console.log("Network:", this.rpcUrl);
    console.log("Mode:", mode);
    console.log("Deposit interval:", depositInterval, "minutes");
    console.log("Withdraw interval:", withdrawInterval, "minutes");
    console.log("Generate new wallets:", generateNewWallets);
    console.log("");

    // Start P2P server
    await this.startP2P();

    // Load tree for current chunk
    const status = await this.getContractStatus();
    if (status.initialized) {
      await this.loadTree(status.currentChunkId);
    }

    this.isRunning = true;
    const startTime = Date.now();

    // Track pending deposits (for withdraw coordination)
    const pendingDeposits = [];

    // Helper: Random delay in range (cryptographically secure)
    const randomDelay = (minMin, maxMin) => {
      const min = minMin * 60 * 1000;
      const max = maxMin * 60 * 1000;
      const crypto = require('crypto');
      return crypto.randomInt(min, max + 1);
    };

    // Helper: Check if we should stop
    const shouldStop = () => {
      if (!this.isRunning) return true;
      if (maxRunTime && (Date.now() - startTime) >= maxRunTime) {
        console.log("⏱️  Max runtime reached, stopping...");
        return true;
      }
      return false;
    };

    // Mixing loop
    const mixingLoop = async () => {
      while (!shouldStop()) {
        try {
          // 1. Check balance
          const balance = await this.getBalance();
          console.log(`💰 Balance: ${balance / 1e6} USDC`);

          if (balance < minBalance) {
            console.log("⚠️  Insufficient balance, waiting 1 minute...");
            await new Promise(resolve => setTimeout(resolve, 60000));
            continue;
          }

          // 2. Deposit
          console.log(`\n💸 Depositing ${amount / 1e6} USDC...`);
          const depositResult = await this.deposit(amount);
          console.log(`✅ Deposit successful! TX: ${depositResult.txId}`);
          console.log(`   Total deposits: ${this.depositCount}`);

          // Track this deposit
          pendingDeposits.push({
            commitment: depositResult.commitment,
            timestamp: Date.now(),
          });

          // 3. Random delay between deposit and withdraw
          const withdrawDelay = randomDelay(withdrawInterval[0], withdrawInterval[1]);
          console.log(`⏳ Waiting ${Math.floor(withdrawDelay / 60000)} minutes before withdraw...`);
          await new Promise(resolve => setTimeout(resolve, withdrawDelay));

          // 4. Reload tree (might have new deposits)
          console.log(`\n🔄 Reloading tree...`);
          const currentStatus = await this.getContractStatus();
          await this.loadTree(currentStatus.currentChunkId);

          // 5. Generate fresh recipient wallet
          const recipient = generateNewWallets 
            ? Keypair.generate().publicKey
            : this.wallet.publicKey;

          console.log(`\n💸 Withdrawing ${amount / 1e6} USDC to ${recipient.toBase58().substring(0, 8)}...`);

          // 6. Withdraw via relayer (uses oldest pending deposit)
          const withdrawResult = await this.withdraw(recipient, amount);
          console.log(`✅ Withdraw queued! Queue ID: ${withdrawResult.queueId}`);
          console.log(`   Relayer: ${withdrawResult.relayerUrl}`);
          console.log(`   Estimated execution: ${new Date(withdrawResult.estimatedExecutionTime).toISOString()}`);
          console.log(`   Total withdraws: ${this.withdrawCount}`);

          // Remove from pending
          if (pendingDeposits.length > 0) {
            pendingDeposits.shift();
          }

          // 7. Random delay before next cycle
          const nextCycleDelay = randomDelay(depositInterval[0], depositInterval[1]);
          console.log(`\n⏳ Waiting ${Math.floor(nextCycleDelay / 60000)} minutes before next cycle...`);
          await new Promise(resolve => setTimeout(resolve, nextCycleDelay));

        } catch (err) {
          console.error(`\n❌ Mixing error: ${err.message}`);
          console.log("   Retrying in 1 minute...");
          await new Promise(resolve => setTimeout(resolve, 60000));
        }
      }

      console.log("\n🛑 Mixing loop stopped");
    };

    // Start mixing loop
    mixingLoop().catch(err => {
      console.error("\n💥 Fatal error in mixing loop:", err);
      this.stop();
    });

    console.log("✅ Agent running in background...");
    console.log("   Press Ctrl+C to stop\n");

    // Keep process alive
    process.on("SIGINT", () => {
      console.log("\n🛑 Stopping agent...");
      this.stop();
      process.exit(0);
    });
  }

  /**
   * Stop auto-mixing
   */
  stop() {
    this.isRunning = false;
    this.stopP2P();
    console.log("\n📊 Final Stats:");
    console.log("Total Deposits:", this.depositCount);
    console.log("Total Withdraws:", this.withdrawCount);
  }

  /**
   * Validate keypair file security before loading
   * @private
   */
  _validateKeypairFile(filepath) {
    if (!fs.existsSync(filepath)) {
      throw new Error(`Keypair file not found: ${filepath}`);
    }
    
    // Check file permissions (Unix-like systems only)
    try {
      const stats = fs.statSync(filepath);
      const mode = stats.mode & 0o777;
      
      // Warn if file is readable by group or others
      if (mode & 0o077) {
        console.warn(`⚠️  WARNING: Keypair file has insecure permissions (${mode.toString(8)})`);
        console.warn(`   Others can read your private key!`);
        console.warn(`   Run: chmod 600 ${filepath}`);
        // Don't throw - just warn. User might be on Windows or intentionally testing
      }
    } catch (err) {
      // Permission check failed (Windows or other filesystem)
      // Continue anyway - file existence was already verified
    }
  }

  /**
   * Helper: u32 to big-endian bytes
   */
  toU32Bytes(num) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(num, 0);
    return buf;
  }

  /**
   * Helper: u16 to big-endian bytes
   */
  toU16Bytes(num) {
    const buf = Buffer.alloc(2);
    buf.writeUInt16BE(num, 0);
    return buf;
  }

  /**
   * Get contract status
   */
  async getContractStatus() {
    const [masterPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("master")],
      this.programId
    );

    try {
      const masterInfo = await this.connection.getAccountInfo(masterPda);
      if (!masterInfo) {
        return { initialized: false };
      }

      const lastId = masterInfo.data.readUInt32LE(8);
      
      return {
        initialized: true,
        currentChunkId: lastId,
        programId: this.programId.toBase58(),
      };
    } catch (err) {
      return { initialized: false, error: err.message };
    }
  }
}

module.exports = CipherAgent;
