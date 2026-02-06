/**
 * Relayer Service for Cipher Agents
 * 
 * Every agent is a relayer:
 * - Accepts withdraw requests via HTTP
 * - Queues transactions with delay
 * - Signs and submits after delay (privacy)
 * - No Redis needed (in-memory queue)
 */

const crypto = require('crypto');

const DEFAULT_DELAY = 60000; // 1 minute default delay
const RELAYER_FEE = 0; // No fees for now

class RelayerService {
  constructor(agent, options = {}) {
    this.agent = agent;
    this.maxDelay = options.maxDelay || DEFAULT_DELAY;
    this.minDelay = options.minDelay || DEFAULT_DELAY / 2;
    
    this.queue = []; // In-memory queue
    this.processing = false;
    this.processTimer = null;
    
    // Rate limiting
    this.rateLimit = options.rateLimit || { requests: 10, window: 60000 }; // 10 req/min
    this.requestCounts = new Map(); // IP -> [timestamps]
  }

  /**
   * Add relayer endpoints to HTTP server
   */
  addEndpoints(server) {
    const originalRequestHandler = server.listeners('request')[0];
    
    server.removeAllListeners('request');
    
    server.on('request', (req, res) => {
      // CORS headers (restricted for security)
      // SECURITY: Only allow localhost and same-origin in production
      const origin = req.headers.origin;
      const allowedOrigins = ['http://localhost', 'http://127.0.0.1'];
      
      if (origin && allowedOrigins.some(allowed => origin.startsWith(allowed))) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      } else if (!origin) {
        // Allow requests without origin header (same-origin, curl, etc.)
        res.setHeader('Access-Control-Allow-Origin', 'http://localhost');
      }
      
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      // POST /relayer/submit - Submit withdraw request
      if (req.url === '/relayer/submit' && req.method === 'POST') {
        this.handleSubmit(req, res);
        return;
      }

      // GET /relayer/status - Get relayer status
      if (req.url === '/relayer/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          queueLength: this.queue.length,
          processing: this.processing,
          fee: RELAYER_FEE,
          maxDelay: this.maxDelay,
        }));
        return;
      }

      // Fallback to original handler
      originalRequestHandler(req, res);
    });
  }

  /**
   * Handle withdraw submission with input validation
   */
  async handleSubmit(req, res) {
    // Rate limiting check
    const clientIp = req.socket.remoteAddress || 'unknown';
    if (!this._checkRateLimit(clientIp)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Rate limit exceeded. Try again later.' }));
      return;
    }
    
    let body = '';
    let bodySize = 0;
    const MAX_BODY_SIZE = 1024 * 1024; // 1MB limit
    
    req.on('data', chunk => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_SIZE) {
        req.destroy();
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request too large' }));
        return;
      }
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { proof, recipient, amount, chunkId } = data;

        // Comprehensive input validation
        const validation = this._validateWithdrawRequest(proof, recipient, amount, chunkId);
        if (!validation.valid) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: validation.error }));
          return;
        }

        // Add to queue
        const queueItem = {
          id: crypto.randomBytes(16).toString('hex'),
          proof,
          recipient,
          amount,
          chunkId,
          submittedAt: Date.now(),
          executeAt: Date.now() + this.randomDelay(),
        };

        this.queue.push(queueItem);
        console.log(`📝 Relayer: Queued withdraw for ${recipient.substring(0, 8)}... (${this.queue.length} in queue)`);

        // Start processing if not already running
        if (!this.processing) {
          this.startProcessing();
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          queueId: queueItem.id,
          estimatedExecutionTime: queueItem.executeAt,
        }));

      } catch (err) {
        console.error('❌ Relayer submit error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });
  }

  /**
   * Check rate limit for IP address
   * @private
   */
  _checkRateLimit(ip) {
    const now = Date.now();
    const windowStart = now - this.rateLimit.window;
    
    // Get or initialize request timestamps for this IP
    if (!this.requestCounts.has(ip)) {
      this.requestCounts.set(ip, []);
    }
    
    const timestamps = this.requestCounts.get(ip);
    
    // Remove old timestamps outside the window
    const validTimestamps = timestamps.filter(ts => ts > windowStart);
    
    // Check if limit exceeded
    if (validTimestamps.length >= this.rateLimit.requests) {
      return false; // Rate limit exceeded
    }
    
    // Add current timestamp
    validTimestamps.push(now);
    this.requestCounts.set(ip, validTimestamps);
    
    // Cleanup old entries periodically
    if (this.requestCounts.size > 1000) {
      for (const [oldIp, oldTimestamps] of this.requestCounts.entries()) {
        if (oldTimestamps.every(ts => ts <= windowStart)) {
          this.requestCounts.delete(oldIp);
        }
      }
    }
    
    return true;
  }

  /**
   * Validate withdraw request inputs
   * @private
   */
  _validateWithdrawRequest(proof, recipient, amount, chunkId) {
    // Check presence
    if (!proof || !recipient || !amount || chunkId === undefined) {
      return { valid: false, error: 'Missing required fields' };
    }
    
    // Validate proof structure
    if (typeof proof !== 'object') {
      return { valid: false, error: 'Invalid proof format' };
    }
    
    // Proof must have pi_a, pi_b, pi_c, protocol, curve
    if (!proof.pi_a || !proof.pi_b || !proof.pi_c || !proof.protocol || !proof.curve) {
      return { valid: false, error: 'Incomplete proof structure' };
    }
    
    // Validate recipient (should be base58 Solana address)
    if (typeof recipient !== 'string' || recipient.length < 32 || recipient.length > 44) {
      return { valid: false, error: 'Invalid recipient address' };
    }
    
    // Basic base58 check (no 0, O, I, l)
    if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(recipient)) {
      return { valid: false, error: 'Invalid base58 in recipient' };
    }
    
    // Validate amount
    if (typeof amount !== 'number' || !Number.isInteger(amount)) {
      return { valid: false, error: 'Amount must be an integer' };
    }
    
    if (amount <= 0 || amount > 1_000_000_000_000) { // 1 million USDC max
      return { valid: false, error: 'Amount out of valid range' };
    }
    
    // Validate chunkId
    if (typeof chunkId !== 'number' || !Number.isInteger(chunkId)) {
      return { valid: false, error: 'ChunkId must be an integer' };
    }
    
    if (chunkId < 0 || chunkId > 1000) {
      return { valid: false, error: 'ChunkId out of valid range' };
    }
    
    return { valid: true };
  }

  /**
   * Random delay for privacy
   * 
   * SECURITY NOTE: Uses Math.random() which is not cryptographically secure.
   * For better privacy, should use crypto.randomInt(). However, the exact
   * delay value is not security-critical here since we add a large base delay.
   */
  randomDelay() {
    return Math.floor(Math.random() * (this.maxDelay - this.minDelay + 1)) + this.minDelay;
  }

  /**
   * Start processing queue
   */
  startProcessing() {
    if (this.processing) return;
    
    this.processing = true;
    console.log('🔄 Relayer: Starting queue processor...');

    this.processQueue();
  }

  /**
   * Process queue continuously
   */
  async processQueue() {
    while (this.processing && this.queue.length > 0) {
      const now = Date.now();
      
      // Find items ready to execute
      const readyItems = this.queue.filter(item => now >= item.executeAt);

      if (readyItems.length === 0) {
        // Wait until next item is ready
        const nextItem = this.queue.sort((a, b) => a.executeAt - b.executeAt)[0];
        const waitTime = nextItem.executeAt - now;
        
        console.log(`⏳ Relayer: Waiting ${Math.ceil(waitTime / 1000)}s for next transaction...`);
        
        await new Promise(resolve => {
          this.processTimer = setTimeout(resolve, waitTime);
        });
        continue;
      }

      // Process ready items
      for (const item of readyItems) {
        try {
          console.log(`\n💸 Relayer: Processing withdraw for ${item.recipient.substring(0, 8)}...`);
          
          // Execute withdraw
          const result = await this.agent.executeWithdraw(
            item.recipient,
            item.amount,
            item.proof,
            item.chunkId
          );

          console.log(`✅ Relayer: TX submitted! ${result.txId}`);
          
          // Remove from queue
          this.queue = this.queue.filter(i => i.id !== item.id);

        } catch (err) {
          console.error(`❌ Relayer: Failed to process ${item.id}:`, err.message);
          
          // Retry later (add delay)
          item.executeAt = Date.now() + 60000; // Retry in 1 minute
        }
      }
    }

    this.processing = false;
    console.log('🛑 Relayer: Queue empty, processor stopped');
  }

  /**
   * Stop processing
   */
  stop() {
    this.processing = false;
    if (this.processTimer) {
      clearTimeout(this.processTimer);
    }
    console.log('🛑 Relayer service stopped');
  }
}

module.exports = RelayerService;
