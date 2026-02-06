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
  }

  /**
   * Add relayer endpoints to HTTP server
   */
  addEndpoints(server) {
    const originalRequestHandler = server.listeners('request')[0];
    
    server.removeAllListeners('request');
    
    server.on('request', (req, res) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
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
   * Handle withdraw submission
   */
  async handleSubmit(req, res) {
    let body = '';
    
    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        const { proof, recipient, amount, chunkId } = JSON.parse(body);

        // Validate inputs
        if (!proof || !recipient || !amount || chunkId === undefined) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required fields' }));
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
   * Random delay for privacy
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
