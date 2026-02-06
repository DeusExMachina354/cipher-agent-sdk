/**
 * Kademlia DHT for Decentralized Agent Discovery
 * 
 * Like BitTorrent - agents find each other without central servers!
 * 
 * Features:
 * - XOR distance metric
 * - K-buckets for efficient routing
 * - Iterative node lookup
 * - Self-healing network
 */

const dgram = require('dgram');
const crypto = require('crypto');
const EventEmitter = require('events');

// DHT Constants
const K = 20;              // Bucket size (standard Kademlia)
const ALPHA = 3;           // Parallelism factor for lookups
const ID_LENGTH = 32;      // 256-bit node IDs (SHA-256)
const DHT_PORT = 8549;     // UDP port for DHT
const RPC_TIMEOUT = 5000;  // 5 seconds

// Magic network identifier
const CIPHER_NETWORK_ID = "cipher-agent-mainnet-v1";

/**
 * Generate node ID from public key or random
 */
function generateNodeId(seed = null) {
  const data = seed || crypto.randomBytes(32);
  return crypto.createHash('sha256').update(data).digest();
}

/**
 * Calculate XOR distance between two node IDs
 */
function distance(id1, id2) {
  const dist = Buffer.alloc(ID_LENGTH);
  for (let i = 0; i < ID_LENGTH; i++) {
    dist[i] = id1[i] ^ id2[i];
  }
  return dist;
}

/**
 * Compare two distances (for sorting)
 */
function compareDistance(dist1, dist2) {
  for (let i = 0; i < ID_LENGTH; i++) {
    if (dist1[i] < dist2[i]) return -1;
    if (dist1[i] > dist2[i]) return 1;
  }
  return 0;
}

/**
 * Find bucket index for a given distance
 */
function bucketIndex(dist) {
  for (let i = 0; i < ID_LENGTH; i++) {
    for (let j = 7; j >= 0; j--) {
      if (dist[i] & (1 << j)) {
        return (ID_LENGTH * 8 - 1) - (i * 8 + (7 - j));
      }
    }
  }
  return 0;
}

/**
 * K-Bucket for storing peers
 */
class KBucket {
  constructor(k = K) {
    this.k = k;
    this.nodes = [];
    this.lastUpdated = Date.now();
  }

  add(node) {
    // Check if node already exists
    const index = this.nodes.findIndex(n => n.id.equals(node.id));
    
    if (index >= 0) {
      // Move to end (most recently seen)
      this.nodes.splice(index, 1);
      this.nodes.push(node);
      return true;
    }

    if (this.nodes.length < this.k) {
      // Bucket not full, add node
      this.nodes.push(node);
      this.lastUpdated = Date.now();
      return true;
    }

    // Bucket full - could implement replacement logic here
    // For now, just ignore (standard Kademlia behavior)
    return false;
  }

  remove(nodeId) {
    const index = this.nodes.findIndex(n => n.id.equals(nodeId));
    if (index >= 0) {
      this.nodes.splice(index, 1);
      return true;
    }
    return false;
  }

  getNodes() {
    return [...this.nodes];
  }
}

/**
 * DHT Node
 */
class DHTNode extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.id = options.nodeId || generateNodeId();
    this.port = options.port || DHT_PORT;
    this.buckets = Array.from({ length: ID_LENGTH * 8 }, () => new KBucket());
    this.socket = null;
    this.pendingRequests = new Map();
    this.values = new Map(); // Store key-value pairs
    
    console.log(`🔑 DHT Node ID: ${this.id.toString('hex').substring(0, 16)}...`);
  }

  /**
   * Start DHT node
   */
  async start() {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket('udp4');

      this.socket.on('message', (msg, rinfo) => {
        this.handleMessage(msg, rinfo);
      });

      this.socket.on('error', (err) => {
        console.error('DHT socket error:', err);
      });

      this.socket.bind(this.port, () => {
        console.log(`📡 DHT listening on UDP port ${this.port}`);
        resolve();
      });
    });
  }

  /**
   * Stop DHT node
   */
  stop() {
    if (this.socket) {
      this.socket.close();
      console.log('🛑 DHT stopped');
    }
  }

  /**
   * Handle incoming DHT message
   */
  handleMessage(msg, rinfo) {
    try {
      const message = JSON.parse(msg.toString());
      const { type, id, data, txId } = message;

      // Add sender to routing table
      if (id) {
        this.addNode({
          id: Buffer.from(id, 'hex'),
          host: rinfo.address,
          port: rinfo.port,
          lastSeen: Date.now(),
        });
      }

      // Handle response
      if (txId && this.pendingRequests.has(txId)) {
        const { resolve } = this.pendingRequests.get(txId);
        this.pendingRequests.delete(txId);
        resolve({ type, data, sender: { host: rinfo.address, port: rinfo.port } });
        return;
      }

      // Handle request
      switch (type) {
        case 'PING':
          this.handlePing(txId, rinfo);
          break;
        case 'FIND_NODE':
          this.handleFindNode(data.target, txId, rinfo);
          break;
        case 'STORE':
          this.handleStore(data.key, data.value, txId, rinfo);
          break;
        case 'FIND_VALUE':
          this.handleFindValue(data.key, txId, rinfo);
          break;
      }
    } catch (err) {
      // Ignore malformed messages (log in DEBUG mode for troubleshooting)
      if (process.env.DEBUG) {
        console.debug(`DHT: Malformed message from ${rinfo.address}:${rinfo.port}:`, err.message);
      }
    }
  }

  /**
   * Send DHT message
   */
  sendMessage(message, host, port) {
    const msg = Buffer.from(JSON.stringify(message));
    this.socket.send(msg, port, host);
  }

  /**
   * Send DHT request with response
   */
  async sendRequest(message, host, port) {
    return new Promise((resolve, reject) => {
      const txId = crypto.randomBytes(8).toString('hex');
      message.txId = txId;

      this.pendingRequests.set(txId, { resolve, reject });

      this.sendMessage(message, host, port);

      // Timeout
      setTimeout(() => {
        if (this.pendingRequests.has(txId)) {
          this.pendingRequests.delete(txId);
          reject(new Error('Request timeout'));
        }
      }, RPC_TIMEOUT);
    });
  }

  /**
   * PING - Check if node is alive
   */
  handlePing(txId, rinfo) {
    this.sendMessage({
      type: 'PONG',
      id: this.id.toString('hex'),
      txId,
    }, rinfo.address, rinfo.port);
  }

  async ping(node) {
    try {
      await this.sendRequest({
        type: 'PING',
        id: this.id.toString('hex'),
      }, node.host, node.port);
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * FIND_NODE - Find K closest nodes to target
   */
  handleFindNode(targetHex, txId, rinfo) {
    const target = Buffer.from(targetHex, 'hex');
    const closest = this.findClosestNodes(target, K);

    this.sendMessage({
      type: 'NODES',
      id: this.id.toString('hex'),
      data: {
        nodes: closest.map(n => ({
          id: n.id.toString('hex'),
          host: n.host,
          port: n.port,
        })),
      },
      txId,
    }, rinfo.address, rinfo.port);
  }

  async findNode(target, node) {
    const response = await this.sendRequest({
      type: 'FIND_NODE',
      id: this.id.toString('hex'),
      data: { target: target.toString('hex') },
    }, node.host, node.port);

    return response.data.nodes.map(n => ({
      id: Buffer.from(n.id, 'hex'),
      host: n.host,
      port: n.port,
      lastSeen: Date.now(),
    }));
  }

  /**
   * STORE - Store key-value pair
   */
  handleStore(key, value, txId, rinfo) {
    this.values.set(key, value);
    
    this.sendMessage({
      type: 'STORED',
      id: this.id.toString('hex'),
      txId,
    }, rinfo.address, rinfo.port);
  }

  async store(key, value, node) {
    await this.sendRequest({
      type: 'STORE',
      id: this.id.toString('hex'),
      data: { key, value },
    }, node.host, node.port);
  }

  /**
   * FIND_VALUE - Find value for key
   */
  handleFindValue(key, txId, rinfo) {
    if (this.values.has(key)) {
      this.sendMessage({
        type: 'VALUE',
        id: this.id.toString('hex'),
        data: { value: this.values.get(key) },
        txId,
      }, rinfo.address, rinfo.port);
    } else {
      // Return closest nodes instead
      const target = crypto.createHash('sha256').update(key).digest();
      this.handleFindNode(target.toString('hex'), txId, rinfo);
    }
  }

  /**
   * Add node to routing table
   */
  addNode(node) {
    if (node.id.equals(this.id)) return; // Don't add ourselves

    const dist = distance(this.id, node.id);
    const index = bucketIndex(dist);
    
    this.buckets[index].add(node);
  }

  /**
   * Find K closest nodes to target
   */
  findClosestNodes(target, k = K) {
    const allNodes = [];
    
    for (const bucket of this.buckets) {
      allNodes.push(...bucket.getNodes());
    }

    // Sort by distance to target
    allNodes.sort((a, b) => {
      const distA = distance(target, a.id);
      const distB = distance(target, b.id);
      return compareDistance(distA, distB);
    });

    return allNodes.slice(0, k);
  }

  /**
   * Iterative node lookup (Kademlia algorithm)
   */
  async iterativeFindNode(target) {
    const shortlist = this.findClosestNodes(target, ALPHA);
    const queried = new Set();
    const closest = new Set();

    let round = 0;
    const maxRounds = 10; // Prevent infinite loops

    while (round < maxRounds) {
      // Find unqueried nodes from shortlist
      const toQuery = shortlist
        .filter(n => !queried.has(n.id.toString('hex')))
        .slice(0, ALPHA);

      if (toQuery.length === 0) break;

      // Query nodes in parallel
      const results = await Promise.allSettled(
        toQuery.map(node => this.findNode(target, node))
      );

      // Mark as queried
      toQuery.forEach(n => queried.add(n.id.toString('hex')));

      // Add successful results to shortlist
      for (const result of results) {
        if (result.status === 'fulfilled') {
          result.value.forEach(node => {
            if (!closest.has(node.id.toString('hex'))) {
              closest.add(node.id.toString('hex'));
              shortlist.push(node);
              this.addNode(node);
            }
          });
        }
      }

      // Re-sort shortlist by distance
      shortlist.sort((a, b) => {
        const distA = distance(target, a.id);
        const distB = distance(target, b.id);
        return compareDistance(distA, distB);
      });

      round++;
    }

    return shortlist.slice(0, K);
  }

  /**
   * Bootstrap from known peer
   * 
   * SECURITY NOTE: In production, this should verify node identity
   * via signed announcements (Ed25519). Current implementation only
   * validates basic connectivity and sanity checks.
   * 
   * TODO for production:
   * - Require signed node announcements
   * - Maintain trusted bootstrap node list
   * - Verify node signatures before adding to routing table
   */
  async bootstrap(peer) {
    console.log(`🔗 Bootstrapping from ${peer.host}:${peer.port}...`);
    
    try {
      // SECURITY: Validate peer before trusting
      if (!this._validatePeer(peer)) {
        throw new Error('Bootstrap peer failed validation');
      }
      
      // Ping bootstrap peer
      const alive = await this.ping(peer);
      if (!alive) {
        throw new Error('Bootstrap peer unreachable');
      }

      this.addNode(peer);

      // Find nodes close to ourselves
      const nodes = await this.iterativeFindNode(this.id);
      console.log(`✅ Bootstrap complete! Found ${nodes.length} nodes`);
      
      return nodes;
    } catch (err) {
      console.error('❌ Bootstrap failed:', err.message);
      throw err;
    }
  }
  
  /**
   * Validate peer before adding to routing table
   * Basic sanity checks to prevent obvious attacks
   * @private
   */
  _validatePeer(peer) {
    // Validate host
    if (!peer.host || typeof peer.host !== 'string') {
      console.warn('⚠️  Invalid peer: missing or invalid host');
      return false;
    }
    
    // Block private/local IPs in production (except localhost for testing)
    const isPrivate = /^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.)/.test(peer.host);
    const isLocalhost = peer.host === 'localhost' || peer.host === '127.0.0.1';
    
    if (isPrivate && !isLocalhost) {
      console.warn('⚠️  Rejecting private IP:', peer.host);
      return false;
    }
    
    // Validate port range
    if (!peer.port || peer.port < 1024 || peer.port > 65535) {
      console.warn('⚠️  Invalid peer: port out of range:', peer.port);
      return false;
    }
    
    // Check if we already have too many nodes from this /24
    const subnet = peer.host.split('.').slice(0, 3).join('.');
    let countFromSubnet = 0;
    for (const bucket of this.buckets) {
      for (const node of bucket.nodes) {
        const nodeSubnet = node.host.split('.').slice(0, 3).join('.');
        if (nodeSubnet === subnet) {
          countFromSubnet++;
        }
      }
    }
    
    const MAX_NODES_PER_SUBNET = 5;
    if (countFromSubnet >= MAX_NODES_PER_SUBNET) {
      console.warn(`⚠️  Too many nodes from subnet ${subnet}.0/24 (${countFromSubnet})`);
      return false;
    }
    
    return true;
  }

  /**
   * Announce presence in DHT (store our info under network ID)
   */
  async announce(httpPort) {
    const target = crypto.createHash('sha256').update(CIPHER_NETWORK_ID).digest();
    const nodes = await this.iterativeFindNode(target);

    const value = {
      id: this.id.toString('hex'),
      httpPort,
      timestamp: Date.now(),
    };

    // Store on closest nodes
    await Promise.allSettled(
      nodes.slice(0, K).map(node => this.store(CIPHER_NETWORK_ID, value, node))
    );

    console.log(`📢 Announced presence to ${nodes.length} DHT nodes`);
  }

  /**
   * Find agents in network
   */
  async findAgents() {
    const target = crypto.createHash('sha256').update(CIPHER_NETWORK_ID).digest();
    const nodes = await this.iterativeFindNode(target);

    // Query nodes for stored agent values
    const agents = new Set();
    
    for (const node of nodes) {
      try {
        const response = await this.sendRequest({
          type: 'FIND_VALUE',
          id: this.id.toString('hex'),
          data: { key: CIPHER_NETWORK_ID },
        }, node.host, node.port);

        if (response.type === 'VALUE') {
          agents.add(JSON.stringify(response.data.value));
        }
      } catch (err) {
        // Node didn't respond
      }
    }

    return Array.from(agents).map(a => JSON.parse(a));
  }
}

module.exports = { DHTNode, generateNodeId, CIPHER_NETWORK_ID };
