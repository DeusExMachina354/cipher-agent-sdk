/**
 * P2P Tree Sharing for Cipher Agents
 * 
 * Hybrid Decentralized Discovery:
 * - Each agent runs an HTTP server (tree sharing)
 * - UDP broadcast for local network (fast)
 * - Kademlia DHT for internet discovery (decentralized)
 * - Peer exchange (agents share their peer lists)
 */

const http = require("http");
const dgram = require("dgram");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { DHTNode } = require("./dht");

const DEFAULT_PORT = 8547; // Cipher HTTP port
const DISCOVERY_PORT = 8548; // UDP broadcast port
const DHT_PORT = 8549; // DHT UDP port
const BROADCAST_INTERVAL = 30000; // 30 seconds
const PEER_CLEANUP_INTERVAL = 60000; // 1 minute
const PEER_TIMEOUT = 120000; // 2 minutes (consider peer dead)
const DHT_ANNOUNCE_INTERVAL = 300000; // 5 minutes (re-announce in DHT)

const CACHE_DIR = path.join(os.homedir(), ".cipher", "trees");
const PEERS_FILE = path.join(os.homedir(), ".cipher", "known-peers.json");

// Bootstrap DHT nodes (for initial DHT bootstrap)
// These are DHT nodes, not HTTP peers!
const DHT_BOOTSTRAP_NODES = [
  // Community-maintained list - add known DHT nodes here
  // { host: 'dht-node-1.cipher.network', port: 8549, id: '...' },
];

class TreeP2P {
  constructor(builder, options = {}) {
    this.builder = builder;
    this.port = options.port || DEFAULT_PORT;
    this.discoveryPort = options.discoveryPort || DISCOVERY_PORT;
    this.dhtPort = options.dhtPort || DHT_PORT;
    this.enableBroadcast = options.enableBroadcast !== false;
    this.enableDHT = options.enableDHT !== false;
    
    this.server = null;
    this.broadcastSocket = null;
    this.dht = null;
    this.peers = new Map(); // { "host:port" => { host, port, lastSeen, trees: [] } }
    this.broadcastTimer = null;
    this.cleanupTimer = null;
    this.dhtAnnounceTimer = null;
    
    // Ensure cache directory exists
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }

    // Load persistent peers
    this.loadPersistentPeers();
  }

  /**
   * Load persistent peers from disk with validation (async)
   * 
   * PERFORMANCE: Async to avoid blocking event loop
   */
  async loadPersistentPeers() {
    if (fs.existsSync(PEERS_FILE)) {
      try {
        const data = JSON.parse(await fs.promises.readFile(PEERS_FILE, 'utf-8'));
        let validCount = 0;
        let invalidCount = 0;
        
        data.forEach(p => {
          // SECURITY: Validate peer data before loading
          if (!this._isValidPeer(p)) {
            invalidCount++;
            return;
          }
          
          this.peers.set(`${p.host}:${p.port}`, {
            host: p.host,
            port: p.port,
            lastSeen: p.lastSeen || Date.now() - PEER_TIMEOUT + 10000, // Mark as old but valid
            trees: p.trees || [],
          });
          validCount++;
        });
        
        console.log(`📂 Loaded ${validCount} persistent peer(s)${invalidCount > 0 ? ` (${invalidCount} invalid)` : ''}`);
      } catch (err) {
        console.log('⚠️  Failed to load persistent peers:', err.message);
      }
    }
  }
  
  /**
   * Validate peer data structure
   * @private
   */
  _isValidPeer(peer) {
    // Check required fields
    if (!peer || typeof peer !== 'object') {
      return false;
    }
    
    if (!peer.host || typeof peer.host !== 'string') {
      return false;
    }
    
    if (!peer.port || typeof peer.port !== 'number') {
      return false;
    }
    
    // Validate port range
    if (peer.port < 1024 || peer.port > 65535) {
      return false;
    }
    
    // Validate host format (basic check)
    // Allow: IP addresses, localhost, domain names
    const validHost = /^(localhost|[\w\-.]+|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.test(peer.host);
    if (!validHost) {
      return false;
    }
    
    return true;
  }

  /**
   * Save persistent peers to disk
   */
  savePersistentPeers() {
    const peers = Array.from(this.peers.values())
      .filter(p => Date.now() - p.lastSeen < PEER_TIMEOUT)
      .map(p => ({
        host: p.host,
        port: p.port,
        trees: p.trees,
        lastSeen: p.lastSeen,
      }));

    try {
      fs.writeFileSync(PEERS_FILE, JSON.stringify(peers, null, 2));
    } catch (err) {
      // Silently ignore save errors
    }
  }

  /**
   * Start HTTP server to share trees + peer discovery
   */
  async startServer() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        // CORS headers
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        
        if (req.method === "OPTIONS") {
          res.writeHead(200);
          res.end();
          return;
        }

        // GET /tree/:chunkId - Return COMPLETE tree
        const treeMatch = req.url.match(/^\/tree\/(\d+)$/);
        if (treeMatch && req.method === "GET") {
          const chunkId = parseInt(treeMatch[1]);
          const treeData = this.builder.trees[chunkId];
          
          if (!treeData) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Tree not found" }));
            return;
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            chunkId,
            leaves: treeData.leaves.map(l => l.toString()),
            tree: treeData.tree.map(n => n.toString()),
            root: treeData.root.toString(),
            leafCount: treeData.leaves.length,
          }));
          return;
        }

        // GET /health - Health check
        if (req.url === "/health" && req.method === "GET") {
          const chunks = Object.keys(this.builder.trees);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            status: "ok",
            chunks: chunks.map(Number),
            port: this.port,
            timestamp: Date.now(),
          }));
          return;
        }

        // GET /peers - Return peer list
        if (req.url === "/peers" && req.method === "GET") {
          const peerList = Array.from(this.peers.values()).map(p => ({
            host: p.host,
            port: p.port,
            lastSeen: p.lastSeen,
            trees: p.trees || [],
          }));
          
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            peers: peerList,
            count: peerList.length,
          }));
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      });

      this.server.listen(this.port, () => {
        console.log(`🌐 P2P server running on port ${this.port}`);
        resolve();
      });

      this.server.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
          console.log(`⚠️  Port ${this.port} in use, trying ${this.port + 1}...`);
          this.port++;
          this.server.listen(this.port);
        } else {
          reject(err);
        }
      });
    });
  }

  /**
   * Start DHT for internet discovery
   */
  async startDHT() {
    if (!this.enableDHT) {
      console.log("🌐 DHT disabled");
      return;
    }

    try {
      this.dht = new DHTNode({ port: this.dhtPort });
      await this.dht.start();

      // Try to bootstrap from persistent peers first
      const persistentPeers = Array.from(this.peers.values())
        .filter(p => Date.now() - p.lastSeen < PEER_TIMEOUT);

      let bootstrapped = false;

      // Try persistent peers
      for (const peer of persistentPeers) {
        try {
          console.log(`🔗 Trying to bootstrap from ${peer.host}:${this.dhtPort}...`);
          await this.dht.bootstrap({
            host: peer.host,
            port: this.dhtPort,
            id: Buffer.alloc(32), // We don't know their DHT ID yet
          });
          bootstrapped = true;
          break;
        } catch (err) {
          // Try next peer
        }
      }

      // Try DHT bootstrap nodes if persistent peers failed
      if (!bootstrapped && DHT_BOOTSTRAP_NODES.length > 0) {
        for (const node of DHT_BOOTSTRAP_NODES) {
          try {
            await this.dht.bootstrap(node);
            bootstrapped = true;
            break;
          } catch (err) {
            // Try next bootstrap node
          }
        }
      }

      if (bootstrapped) {
        console.log("✅ DHT bootstrapped successfully");

        // Announce ourselves in DHT
        await this.dht.announce(this.port);

        // Re-announce periodically
        this.dhtAnnounceTimer = setInterval(async () => {
          try {
            await this.dht.announce(this.port);
            console.log("📢 Re-announced in DHT");
          } catch (err) {
            console.log("⚠️  DHT re-announce failed:", err.message);
          }
        }, DHT_ANNOUNCE_INTERVAL);
      } else {
        console.log("⚠️  DHT bootstrap failed - running in isolation mode");
        console.log("   Waiting for other agents to connect...");
      }
    } catch (err) {
      console.error("❌ DHT start failed:", err.message);
    }
  }

  /**
   * Start UDP broadcast for local network discovery
   */
  async startBroadcast() {
    if (!this.enableBroadcast) {
      console.log("📡 UDP broadcast disabled");
      return;
    }

    return new Promise((resolve, reject) => {
      this.broadcastSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      // Listen for broadcasts from other agents
      this.broadcastSocket.on('message', (msg, rinfo) => {
        try {
          const data = JSON.parse(msg.toString());
          
          // Ignore our own broadcasts
          if (data.port === this.port && this.isLocalAddress(rinfo.address)) {
            return;
          }

          // Add/update peer
          if (data.type === 'announce' && data.port) {
            this.addPeer(rinfo.address, data.port, data.trees || []);
          }
        } catch (err) {
          // Ignore malformed messages
        }
      });

      this.broadcastSocket.on('error', (err) => {
        console.log(`⚠️  Broadcast socket error: ${err.message}`);
      });

      this.broadcastSocket.bind(this.discoveryPort, () => {
        this.broadcastSocket.setBroadcast(true);
        console.log(`📡 UDP broadcast listening on port ${this.discoveryPort}`);
        
        // Start broadcasting our presence
        this.startBroadcastLoop();
        
        // Start peer cleanup loop
        this.startPeerCleanup();
        
        resolve();
      });
    });
  }

  /**
   * Broadcast our presence periodically
   */
  startBroadcastLoop() {
    const broadcast = () => {
      const message = JSON.stringify({
        type: 'announce',
        port: this.port,
        trees: Object.keys(this.builder.trees).map(Number),
        timestamp: Date.now(),
      });

      const broadcastAddresses = this.getBroadcastAddresses();
      
      broadcastAddresses.forEach(addr => {
        this.broadcastSocket.send(message, this.discoveryPort, addr, (err) => {
          if (err) {
            // Silently ignore broadcast errors
          }
        });
      });
    };

    // Broadcast immediately
    broadcast();

    // Then broadcast periodically
    this.broadcastTimer = setInterval(broadcast, BROADCAST_INTERVAL);
  }

  /**
   * Clean up stale peers
   */
  startPeerCleanup() {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      const stale = [];

      this.peers.forEach((peer, key) => {
        if (now - peer.lastSeen > PEER_TIMEOUT) {
          stale.push(key);
        }
      });

      stale.forEach(key => {
        const peer = this.peers.get(key);
        console.log(`🗑️  Removing stale peer: ${peer.host}:${peer.port}`);
        this.peers.delete(key);
      });
    }, PEER_CLEANUP_INTERVAL);
  }

  /**
   * Get broadcast addresses for local network
   */
  getBroadcastAddresses() {
    const addresses = ['255.255.255.255']; // Global broadcast
    
    const interfaces = os.networkInterfaces();
    Object.values(interfaces).forEach(iface => {
      iface.forEach(addr => {
        if (addr.family === 'IPv4' && !addr.internal) {
          // Calculate broadcast address
          const ip = addr.address.split('.').map(Number);
          const mask = addr.netmask.split('.').map(Number);
          const broadcast = ip.map((octet, i) => octet | (~mask[i] & 255));
          addresses.push(broadcast.join('.'));
        }
      });
    });

    return addresses;
  }

  /**
   * Check if address is local
   */
  isLocalAddress(addr) {
    if (addr === '127.0.0.1' || addr === 'localhost') return true;
    
    const interfaces = os.networkInterfaces();
    for (const iface of Object.values(interfaces)) {
      for (const info of iface) {
        if (info.address === addr) return true;
      }
    }
    return false;
  }

  /**
   * Add or update a peer
   */
  addPeer(host, port, trees = []) {
    const key = `${host}:${port}`;
    const existing = this.peers.get(key);

    if (!existing) {
      // PRIVACY: Don't log full IP in production (enables network analysis)
      const displayHost = process.env.DEBUG ? host : this._redactIp(host);
      console.log(`✨ Discovered peer: ${displayHost}:${port} (trees: ${trees.join(', ') || 'none'})`);
    }

    this.peers.set(key, {
      host,
      port,
      lastSeen: Date.now(),
      trees,
    });
  }
  
  /**
   * Redact IP address for privacy
   * @private
   */
  _redactIp(host) {
    if (host === 'localhost' || host === '127.0.0.1') {
      return host; // Don't redact localhost
    }
    
    // Hash the IP for consistent redaction
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(host).digest('hex');
    return `peer_${hash.substring(0, 8)}`;
  }

  /**
   * Stop server and broadcasting
   */
  stopServer() {
    // Save peers before stopping
    this.savePersistentPeers();

    if (this.server) {
      this.server.close();
      console.log("🛑 P2P server stopped");
    }

    if (this.broadcastSocket) {
      this.broadcastSocket.close();
      console.log("🛑 UDP broadcast stopped");
    }

    if (this.dht) {
      this.dht.stop();
      console.log("🛑 DHT stopped");
    }

    if (this.broadcastTimer) {
      clearInterval(this.broadcastTimer);
    }

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    if (this.dhtAnnounceTimer) {
      clearInterval(this.dhtAnnounceTimer);
    }
  }

  /**
   * Discover peers (DHT + broadcast + peer exchange)
   */
  async discoverPeers() {
    console.log("🔍 Discovering peers...");

    // 1. Check if we already have peers
    if (this.peers.size > 0) {
      console.log(`   Using ${this.peers.size} known peer(s)`);
      return Array.from(this.peers.values());
    }

    // 2. Try DHT discovery (internet-wide)
    if (this.enableDHT && this.dht) {
      console.log("   Searching DHT for agents...");
      try {
        const agents = await this.dht.findAgents();
        console.log(`   Found ${agents.length} agent(s) in DHT`);
        
        agents.forEach(agent => {
          if (agent.httpPort) {
            // Try to extract host from agent info
            // For now, we need to ping them to verify
            this.addPeer(agent.host || 'unknown', agent.httpPort, []);
          }
        });
      } catch (err) {
        console.log("   DHT search failed:", err.message);
      }
    }

    // 3. Wait a moment for UDP broadcast discovery (LAN)
    if (this.enableBroadcast && this.peers.size === 0) {
      console.log("   Waiting for UDP broadcasts...");
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    const peerCount = this.peers.size;
    if (peerCount === 0) {
      console.log("   No peers found, will build tree from chain");
      console.log("   💡 Tip: Make sure at least one agent is publicly reachable");
    } else {
      console.log(`   Found ${peerCount} peer(s)`);
      // Save discovered peers
      this.savePersistentPeers();
    }

    return Array.from(this.peers.values());
  }

  /**
   * Try to fetch COMPLETE tree from peers
   */
  async fetchCompleteTreeFromPeers(chunkId) {
    const peers = Array.from(this.peers.values());
    
    if (peers.length === 0) {
      console.log("ℹ️  No peers available, will build tree from chain");
      return null;
    }

    console.log(`📥 Fetching COMPLETE tree for chunk ${chunkId} from peers...`);

    // Try peers that have this tree first
    const peersWithTree = peers.filter(p => p.trees && p.trees.includes(chunkId));
    const peersToTry = peersWithTree.length > 0 ? peersWithTree : peers;

    for (const peer of peersToTry) {
      try {
        const url = `http://${peer.host}:${peer.port}/tree/${chunkId}`;
        const response = await fetch(url, { timeout: 10000 });
        
        if (response.ok) {
          const data = await response.json();
          console.log(`✅ Fetched complete tree from peer ${peer.host}:${peer.port}`);
          console.log(`   Leaves: ${data.leafCount}, Tree nodes: ${data.tree.length}`);
          
          // Convert strings back to BigInt
          const leaves = data.leaves.map(l => BigInt(l));
          const tree = data.tree.map(n => BigInt(n));
          const root = BigInt(data.root);
          
          // Store directly in builder
          this.builder.trees[chunkId] = {
            leaves,
            tree,
            root,
          };
          
          console.log(`🚀 Tree ready instantly! Root: ${root.toString().substring(0, 20)}...`);
          return true;
        }
      } catch (err) {
        console.log(`⚠️  Failed to fetch from ${peer.host}:${peer.port}:`, err.message);
        continue;
      }
    }

    console.log("❌ No peers had the tree, will build from chain");
    return null;
  }

  /**
   * Save COMPLETE tree to local cache
   */
  saveTreeCache(chunkId) {
    const treeData = this.builder.trees[chunkId];
    if (!treeData) return;

    const cachePath = path.join(CACHE_DIR, `chunk-${chunkId}.json`);
    const cacheData = {
      chunkId,
      leaves: treeData.leaves.map(l => l.toString()),
      tree: treeData.tree.map(n => n.toString()),
      root: treeData.root.toString(),
      leafCount: treeData.leaves.length,
      timestamp: Date.now(),
    };

    fs.writeFileSync(cachePath, JSON.stringify(cacheData));
    console.log(`💾 Cached tree for chunk ${chunkId}`);
  }

  /**
   * Load COMPLETE tree from local cache
   */
  loadTreeCache(chunkId) {
    const cachePath = path.join(CACHE_DIR, `chunk-${chunkId}.json`);
    
    if (!fs.existsSync(cachePath)) {
      return null;
    }

    try {
      const cacheData = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
      
      const age = Date.now() - cacheData.timestamp;
      const ageMinutes = Math.floor(age / 60000);
      
      console.log(`📂 Loaded cached tree for chunk ${chunkId} (age: ${ageMinutes} minutes)`);
      
      // If we have the complete tree cached, load it directly
      if (cacheData.tree && cacheData.root) {
        const leaves = cacheData.leaves.map(l => BigInt(l));
        const tree = cacheData.tree.map(n => BigInt(n));
        const root = BigInt(cacheData.root);
        
        // Store directly in builder
        this.builder.trees[chunkId] = {
          leaves,
          tree,
          root,
        };
        
        console.log(`🚀 Complete tree loaded from cache! (instant, no build needed)`);
        return true;
      }
      
      // Legacy: only leaves cached
      const leaves = cacheData.leaves.map(l => BigInt(l));
      return leaves;
    } catch (err) {
      console.log(`⚠️  Failed to load cache:`, err.message);
      return null;
    }
  }
}

module.exports = TreeP2P;
