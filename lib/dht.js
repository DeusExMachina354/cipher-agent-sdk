/**
 * Kademlia DHT for Decentralized Agent Discovery (TCP Version)
 * 
 * Like BitTorrent - agents find each other without central servers!
 * Now using TCP instead of UDP for better reliability and firewall traversal.
 * 
 * Features:
 * - XOR distance metric
 * - K-buckets for efficient routing
 * - Iterative node lookup
 * - Self-healing network
 * - TCP transport with length-prefixed messages
 */

const net = require('net');
const crypto = require('crypto');
const EventEmitter = require('events');

// DHT Constants
const K = 20;              // Bucket size (standard Kademlia)
const ALPHA = 3;           // Parallelism factor for lookups
const ID_LENGTH = 32;      // 256-bit node IDs (SHA-256)
const DHT_PORT = 8549;     // TCP port for DHT
const RPC_TIMEOUT = 5000;  // 5 seconds
const MAX_CONNECTIONS = 100; // Max concurrent TCP connections

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
 * TCP Message Framing
 * Format: [4 bytes length][JSON message]
 */
class MessageFramer {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  /**
   * Encode message with length prefix
   */
  static encode(message) {
    const json = JSON.stringify(message);
    const jsonBuf = Buffer.from(json, 'utf8');
    const lengthBuf = Buffer.alloc(4);
    lengthBuf.writeUInt32BE(jsonBuf.length, 0);
    return Buffer.concat([lengthBuf, jsonBuf]);
  }

  /**
   * Decode messages from incoming data
   */
  decode(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    const messages = [];

    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      
      // Check if we have the complete message
      if (this.buffer.length < 4 + length) {
        break;
      }

      // Extract message
      const messageBuf = this.buffer.slice(4, 4 + length);
      this.buffer = this.buffer.slice(4 + length);

      try {
        const message = JSON.parse(messageBuf.toString('utf8'));
        messages.push(message);
      } catch (err) {
        // Ignore malformed messages
      }
    }

    return messages;
  }

  reset() {
    this.buffer = Buffer.alloc(0);
  }
}

/**
 * DHT Node (TCP Version)
 */
class DHTNode extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.id = options.nodeId || generateNodeId();
    this.port = options.port || DHT_PORT;
    this.buckets = Array.from({ length: ID_LENGTH * 8 }, () => new KBucket());
    this.server = null;
    this.connections = new Map(); // Active connections
    this.pendingRequests = new Map();
    this.values = new Map(); // Store key-value pairs
    
    console.log(`🔑 DHT Node ID: ${this.id.toString('hex').substring(0, 16)}...`);
  }

  /**
   * Start DHT node
   */
  async start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on('error', (err) => {
        console.error('DHT server error:', err);
        reject(err);
      });

      this.server.listen(this.port, '0.0.0.0', () => {
        console.log(`📡 DHT listening on TCP port ${this.port}`);
        resolve();
      });

      // Cleanup old connections periodically
      setInterval(() => {
        const now = Date.now();
        for (const [key, conn] of this.connections.entries()) {
          if (now - conn.lastUsed > 60000) { // 1 minute idle
            conn.socket.destroy();
            this.connections.delete(key);
          }
        }
      }, 30000);
    });
  }

  /**
   * Stop DHT node
   */
  stop() {
    if (this.server) {
      // Close all connections
      for (const [key, conn] of this.connections.entries()) {
        conn.socket.destroy();
      }
      this.connections.clear();

      this.server.close();
      console.log('🛑 DHT stopped');
    }
  }

  /**
   * Handle incoming TCP connection
   */
  handleConnection(socket) {
    const framer = new MessageFramer();
    const remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`;

    socket.on('data', (data) => {
      const messages = framer.decode(data);
      
      for (const message of messages) {
        this.handleMessage(message, socket);
      }
    });

    socket.on('error', (err) => {
      // Silently ignore connection errors
    });

    socket.on('close', () => {
      // Connection closed
    });
  }

  /**
   * Handle incoming DHT message
   */
  handleMessage(message, socket) {
    try {
      const { type, id, data, txId } = message;

      // Add sender to routing table
      if (id) {
        const host = socket.remoteAddress.replace('::ffff:', '');
        this.addNode({
          id: Buffer.from(id, 'hex'),
          host: host,
          port: this.port, // DHT nodes use same port
          lastSeen: Date.now(),
        });
      }

      // Handle response
      if (txId && this.pendingRequests.has(txId)) {
        const { resolve } = this.pendingRequests.get(txId);
        this.pendingRequests.delete(txId);
        resolve({ type, data, sender: { socket } });
        return;
      }

      // Handle request
      switch (type) {
        case 'PING':
          this.handlePing(txId, socket);
          break;
        case 'FIND_NODE':
          this.handleFindNode(data.target, txId, socket);
          break;
        case 'STORE':
          this.handleStore(data.key, data.value, txId, socket);
          break;
        case 'FIND_VALUE':
          this.handleFindValue(data.key, txId, socket);
          break;
      }
    } catch (err) {
      // Ignore malformed messages
    }
  }

  /**
   * Get or create connection to remote node
   */
  async getConnection(host, port) {
    const key = `${host}:${port}`;
    
    // Return existing connection if available
    if (this.connections.has(key)) {
      const conn = this.connections.get(key);
      conn.lastUsed = Date.now();
      return conn.socket;
    }

    // Create new connection
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, host);
      const framer = new MessageFramer();

      socket.on('connect', () => {
        this.connections.set(key, {
          socket,
          framer,
          lastUsed: Date.now(),
        });
        resolve(socket);
      });

      socket.on('data', (data) => {
        const messages = framer.decode(data);
        for (const message of messages) {
          this.handleMessage(message, socket);
        }
      });

      socket.on('error', (err) => {
        this.connections.delete(key);
        reject(err);
      });

      socket.on('close', () => {
        this.connections.delete(key);
      });

      // Timeout
      socket.setTimeout(RPC_TIMEOUT, () => {
        socket.destroy();
        reject(new Error('Connection timeout'));
      });
    });
  }

  /**
   * Send DHT message
   */
  async sendMessage(message, host, port) {
    try {
      const socket = await this.getConnection(host, port);
      const encoded = MessageFramer.encode(message);
      socket.write(encoded);
    } catch (err) {
      // Connection failed, silently ignore
    }
  }

  /**
   * Send DHT request with response
   */
  async sendRequest(message, host, port) {
    return new Promise(async (resolve, reject) => {
      const txId = crypto.randomBytes(8).toString('hex');
      message.txId = txId;

      this.pendingRequests.set(txId, { resolve, reject });

      try {
        await this.sendMessage(message, host, port);
      } catch (err) {
        this.pendingRequests.delete(txId);
        reject(err);
        return;
      }

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
  handlePing(txId, socket) {
    const encoded = MessageFramer.encode({
      type: 'PONG',
      id: this.id.toString('hex'),
      txId,
    });
    socket.write(encoded);
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
  handleFindNode(targetHex, txId, socket) {
    const target = Buffer.from(targetHex, 'hex');
    const closest = this.findClosestNodes(target, K);

    const encoded = MessageFramer.encode({
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
    });
    socket.write(encoded);
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
  handleStore(key, value, txId, socket) {
    // Augment value with sender's host (for agent discovery)
    const host = socket.remoteAddress.replace('::ffff:', '');
    const augmentedValue = {
      ...value,
      host, // Add host IP to stored value
    };
    
    this.values.set(key, augmentedValue);
    
    const encoded = MessageFramer.encode({
      type: 'STORED',
      id: this.id.toString('hex'),
      txId,
    });
    socket.write(encoded);
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
  handleFindValue(key, txId, socket) {
    if (this.values.has(key)) {
      const encoded = MessageFramer.encode({
        type: 'VALUE',
        id: this.id.toString('hex'),
        data: { value: this.values.get(key) },
        txId,
      });
      socket.write(encoded);
    } else {
      // Return closest nodes instead
      const target = crypto.createHash('sha256').update(key).digest();
      this.handleFindNode(target.toString('hex'), txId, socket);
    }
  }

  /**
   * Add node to routing table
   */
  addNode(node) {
    // Validate node has required fields
    if (!node || !node.id || !node.host || !node.port) return;
    
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
   */
  async bootstrap(peer) {
    console.log(`🔗 Bootstrapping from ${peer.host}:${peer.port}...`);
    
    try {
      // Ping bootstrap peer - response will add peer to routing table via handleMessage
      const alive = await this.ping(peer);
      if (!alive) {
        throw new Error('Bootstrap peer unreachable');
      }

      // Peer is now in routing table (added during PING/PONG exchange)

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
   * Announce presence in DHT (store our info under network ID)
   */
  async announce(httpPort, publicHost = null) {
    const target = crypto.createHash('sha256').update(CIPHER_NETWORK_ID).digest();
    const nodes = await this.iterativeFindNode(target);

    const value = {
      id: this.id.toString('hex'),
      httpPort,
      timestamp: Date.now(),
      // Include host if provided (for public IP announcements)
      ...(publicHost && { host: publicHost }),
    };

    // Store on closest nodes
    await Promise.allSettled(
      nodes.slice(0, K).map(node => this.store(CIPHER_NETWORK_ID, value, node))
    );

    console.log(`📢 Announced presence to ${nodes.length} DHT nodes${publicHost ? ` (host: ${publicHost})` : ''}`);
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
