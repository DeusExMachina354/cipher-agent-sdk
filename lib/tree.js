/**
 * Merkle Tree Builder for Cipher Agents
 * 
 * Builds tree from on-chain data using EXACT same logic as backend/contract
 */

const { Connection, PublicKey } = require("@solana/web3.js");
const { buildPoseidon } = require("circomlibjs");

const TREE_HEIGHT = 20;
const LEAVES_CAPACITY = 1_048_576; // 2^20
const ZERO = BigInt(0);

// Pre-computed zero hashes (MUST match contract/backend exactly!)
const ZERO_HASHES = [
  BigInt('14744269619966411208579211824598458697587494354926760081771325075741142829156'),
  BigInt('7423237065226347324353380772367382631490014989348495481811164164159255474657'),
  BigInt('11286972368698509976183087595462810875513684078608517520839298933882497716792'),
  BigInt('3607627140608796879659380071776844901612302623152076817094415224584923813162'),
  BigInt('19712377064642672829441595136074946683621277828620209496774504837737984048981'),
  BigInt('20775607673010627194014556968476266066927294572711034918890206699356394921336'),
  BigInt('3396914609616007258851405644437304192397291162432396347162513310381425243293'),
  BigInt('21551820661461729022865262380882070649935529853313286572328683688269863701601'),
  BigInt('6573136701248752079028194407151022595060682063033565181951145966236778420039'),
  BigInt('12413880268183407374852357075976609371175688755676981206018884971008854919922'),
  BigInt('14271763308400718165336499097156975241954733520325982997864342600795471836726'),
  BigInt('20066985985293572387227381049700832219069292839614107140851619262827735677018'),
  BigInt('9394776414966240069580838672673694685292165040808226440647796406499139370960'),
  BigInt('11331146992410411304059858900317123658895005918277453009197229807340014528524'),
  BigInt('15819538789928229930262697811477882737253464456578333862691129291651619515538'),
  BigInt('19217088683336594659449020493828377907203207941212636669271704950158751593251'),
  BigInt('21035245323335827719745544373081896983162834604456827698288649288827293579666'),
  BigInt('6939770416153240137322503476966641397417391950902474480970945462551409848591'),
  BigInt('10941962436777715901943463195175331263348098796018438960955633645115430874314'),
  BigInt('15019797232609675441998260052101280400536945603062888308240081994073687793470'),
];

class MerkleTreeBuilder {
  constructor(programId, connection) {
    this.programId = programId;
    this.connection = connection;
    this.poseidon = null;
    this.trees = {}; // { chunkId: { leaves: [], tree: [] } }
  }

  async init() {
    if (!this.poseidon) {
      console.log("🔧 Initializing Poseidon hash...");
      this.poseidon = await buildPoseidon();
      console.log("✅ Poseidon ready");
    }
  }

  /**
   * Fetch all leaves for a chunk from on-chain storage
   * Uses Anchor to properly decode account data
   */
  async fetchLeavesFromChain(chunkId) {
    console.log(`📥 Fetching leaves for chunk ${chunkId} from chain...`);
    
    // We need Anchor to decode properly
    const anchor = require("@coral-xyz/anchor");
    const fs = require("fs");
    const path = require("path");
    
    // Load IDL
    const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "cipher.json"), "utf-8"));
    const provider = new anchor.AnchorProvider(this.connection, {}, {});
    const program = new anchor.Program(idl, provider);
    
    const leaves = [];
    
    // Find chunk to get currentStorageId
    const [chunkAddress] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("merkle_chunk"),
        Buffer.from(this.toU32Bytes(chunkId)),
      ],
      this.programId
    );
    
    let maxStorageId = 10; // fallback
    try {
      const chunkAccount = await program.account.merkleTreeChunk.fetch(chunkAddress);
      maxStorageId = chunkAccount.currentStorageId;
    } catch (e) {
      console.log(`  Warning: Could not fetch chunk account, using fallback`);
    }
    
    // Fetch all storage accounts for this chunk
    for (let storageId = 1; storageId <= maxStorageId; storageId++) {
      const [storageAddress] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("leave_storage"),
          Buffer.from(this.toU32Bytes(chunkId)),
          Buffer.from(this.toU16Bytes(storageId)),
        ],
        this.programId
      );

      try {
        // Use Anchor to fetch and decode
        const storage = await program.account.leaveStorage.fetch(storageAddress);
        
        // storage.leaves is an array of number arrays
        for (const leaf of storage.leaves) {
          const leafBuf = Buffer.from(leaf);
          leaves.push(this.bufferToBigInt(leafBuf));
        }
        
        console.log(`  Storage ${storageId}: ${storage.leaves.length} leaves`);
      } catch (err) {
        // Storage account doesn't exist, we're done
        break;
      }
    }

    console.log(`✅ Fetched ${leaves.length} leaves for chunk ${chunkId}`);
    return leaves;
  }

  /**
   * Update tree incrementally (only add new leaves)
   * MUCH faster than full rebuild!
   */
  async updateTree(chunkId, newLeaves) {
    if (!this.poseidon) await this.init();
    
    const treeData = this.trees[chunkId];
    if (!treeData) {
      // No existing tree, do full build
      return await this.buildTree(chunkId, newLeaves);
    }
    
    const previousLeafCount = treeData.leaves.length;
    const currentLeafCount = newLeaves.length;
    
    if (currentLeafCount === previousLeafCount) {
      console.log(`✅ No new leaves for chunk ${chunkId}`);
      return treeData.tree;
    }
    
    if (currentLeafCount < previousLeafCount) {
      console.log(`⚠️ Leaf count decreased, rebuilding...`);
      return await this.buildTree(chunkId, newLeaves);
    }
    
    console.log(`🔄 Updating tree for chunk ${chunkId} (${previousLeafCount} -> ${currentLeafCount} leaves)...`);
    const start = Date.now();
    
    const tree = treeData.tree;
    const leafCapacity = LEAVES_CAPACITY;
    
    // Add only NEW leaves incrementally
    for (let i = previousLeafCount; i < currentLeafCount; i++) {
      if (i >= leafCapacity) {
        throw new Error(`Leaf index ${i} exceeds capacity`);
      }
      
      tree[i] = newLeaves[i];
      let currentIndex = i;
      let currentLevelOffset = 0;
      
      // Update path from this leaf to root
      for (let level = 0; level < TREE_HEIGHT; level++) {
        const levelNodeCount = 2 ** (TREE_HEIGHT - level);
        const parentLevelOffset = currentLevelOffset + levelNodeCount;
        const parentIndexInTree = parentLevelOffset + Math.floor(currentIndex / 2);
        
        if (parentIndexInTree >= tree.length) {
          throw new Error(`Update OOB PIndex ${parentIndexInTree}`);
        }
        
        const isRight = currentIndex % 2 === 1;
        const siblingIndexInLevel = isRight ? currentIndex - 1 : currentIndex + 1;
        const siblingIndexInTree = currentLevelOffset + siblingIndexInLevel;
        const currentIndexInTree = currentLevelOffset + currentIndex;
        
        const left = isRight ? tree[siblingIndexInTree] : tree[currentIndexInTree];
        const right = isRight
          ? tree[currentIndexInTree]
          : (siblingIndexInLevel < levelNodeCount && tree[siblingIndexInTree] !== ZERO
              ? tree[siblingIndexInTree]
              : (level === 0 ? ZERO : ZERO_HASHES[level - 1]));
        
        if (left === undefined || right === undefined) {
          throw new Error(`Update undefined L${level} i=${currentIndex}`);
        }
        
        const hash = await this.poseidon([left, right]);
        tree[parentIndexInTree] = BigInt(this.poseidon.F.toObject(hash));
        
        currentIndex = Math.floor(currentIndex / 2);
        currentLevelOffset = parentLevelOffset;
      }
    }
    
    const root = tree[tree.length - 1];
    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    
    console.log(`✅ Tree updated in ${elapsed}s`);
    console.log(`   Root: ${root.toString().substring(0, 20)}...`);
    
    // Update stored data
    this.trees[chunkId] = {
      leaves: newLeaves,
      tree: tree,
      root: root,
    };
    
    return tree;
  }

  /**
   * Build Merkle tree from leaves (full build)
   * Use updateTree() for incremental updates!
   */
  async buildTree(chunkId, currentLeaves) {
    if (!this.poseidon) await this.init();
    
    const numLeaves = currentLeaves.length;
    console.log(`🌳 Building Merkle tree for chunk ${chunkId} (${numLeaves} leaves)...`);
    const start = Date.now();
    
    if (numLeaves > LEAVES_CAPACITY) {
      throw new Error(`Too many leaves: ${numLeaves} > ${LEAVES_CAPACITY}`);
    }

    // Full binary tree size
    const treeSize = 2 ** (TREE_HEIGHT + 1) - 1;
    const tree = new Array(treeSize).fill(ZERO);

    // 1. Fill leaf nodes (bottom level)
    for (let i = 0; i < numLeaves; i++) {
      tree[i] = currentLeaves[i];
    }

    // 2. Build intermediate nodes level by level (EXACTLY like backend!)
    let nodeOffset = 0;
    let currentLevelNodeCount = LEAVES_CAPACITY;

    for (let level = 0; level < TREE_HEIGHT; level++) {
      const parentLevelOffset = nodeOffset + currentLevelNodeCount;
      
      for (let i = 0; i < currentLevelNodeCount; i += 2) {
        const leftIndex = nodeOffset + i;
        const rightIndex = nodeOffset + i + 1;
        
        const left = tree[leftIndex];
        const right = (rightIndex < nodeOffset + currentLevelNodeCount && tree[rightIndex] !== ZERO)
          ? tree[rightIndex]
          : (level === 0 ? ZERO : ZERO_HASHES[level - 1]);
        
        if (left === undefined || right === undefined) {
          throw new Error(`Build undefined L${level} i=${i}`);
        }
        
        const parentIndex = parentLevelOffset + Math.floor(i / 2);
        if (parentIndex >= treeSize) {
          throw new Error(`Build OOB PIndex ${parentIndex}`);
        }
        
        const hash = await this.poseidon([left, right]);
        tree[parentIndex] = BigInt(this.poseidon.F.toObject(hash));
      }
      
      nodeOffset = parentLevelOffset;
      currentLevelNodeCount /= 2;
    }

    const root = tree[treeSize - 1];
    const elapsed = ((Date.now() - start) / 1000).toFixed(2);
    
    console.log(`✅ Tree built in ${elapsed}s`);
    console.log(`   Root: ${root.toString().substring(0, 20)}...`);
    
    // Store for later
    this.trees[chunkId] = {
      leaves: currentLeaves,
      tree: tree,
      root: root,
    };
    
    return tree;
  }

  /**
   * Get Merkle path for a leaf (EXACTLY matching backend logic!)
   */
  getMerklePath(chunkId, leafIndex) {
    const treeData = this.trees[chunkId];
    if (!treeData) {
      throw new Error(`Tree for chunk ${chunkId} not loaded`);
    }

    const { tree } = treeData;
    const pathElements = [];
    const pathIndices = [];

    let currentIndex = leafIndex;
    let levelOffset = 0;

    // EXACT backend logic
    for (let level = 0; level < TREE_HEIGHT; level++) {
      const isRight = currentIndex % 2 === 1;
      const siblingIndex = isRight ? currentIndex - 1 : currentIndex + 1;
      const levelStart = levelOffset;
      const levelSize = 2 ** (TREE_HEIGHT - level);
      levelOffset += levelSize;

      let sibling;
      if (level === 0) {
        // At leaf level
        sibling = (siblingIndex >= 0 && siblingIndex < LEAVES_CAPACITY) 
          ? tree[siblingIndex] 
          : ZERO;
      } else {
        // At intermediate levels
        const siblingNodeIndex = levelStart + siblingIndex;
        sibling = (siblingNodeIndex >= levelStart && siblingNodeIndex < levelOffset) 
          ? tree[siblingNodeIndex] 
          : ZERO_HASHES[level - 1];
      }

      pathElements.push(sibling.toString());  // As string!
      pathIndices.push(isRight ? 1 : 0);
      currentIndex = Math.floor(currentIndex / 2);
    }

    const rootIndex = tree.length - 1;
    const root = tree[rootIndex] || ZERO_HASHES[TREE_HEIGHT - 1];

    return {
      pathElements,
      pathIndices,
      root: root.toString(),  // As string!
    };
  }

  // Helper methods
  hash(left, right) {
    const result = this.poseidon([left, right]);
    return BigInt(this.poseidon.F.toObject(result));
  }

  bufferToBigInt(buffer) {
    if (buffer.length === 0) return BigInt(0);
    return BigInt('0x' + buffer.toString('hex'));
  }

  toU32Bytes(num) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(num);  // ← BIG ENDIAN (matches contract!)
    return buf;
  }

  toU16Bytes(num) {
    const buf = Buffer.alloc(2);
    buf.writeUInt16BE(num);  // ← BIG ENDIAN (matches contract!)
    return buf;
  }
}

module.exports = MerkleTreeBuilder;
