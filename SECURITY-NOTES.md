# Security Notes & Limitations

**Last Updated:** 2026-02-06  
**Status:** Hackathon Demo / Beta

This document describes security limitations and known issues that are **accepted for the hackathon demo** but should be addressed before production deployment.

---

## ✅ Fixed Issues

See git history for detailed fixes:
- **CRITICAL (3):** All fixed ✅
- **HIGH (3/6):** Input validation, rate limiting, peer validation ✅
- **MEDIUM (3/8):** Sensitive logging removed, crypto random, CORS restricted ✅
- **LOW (2/5):** package-lock.json added, CORS fixed ✅

---

## ⚠️ Known Limitations (Accepted for Demo)

### H5: Timing Attack on Commitment Search
**Status:** 🟡 Documented (not fixed)

**Issue:** Sequential search through Merkle tree leaks timing information about leaf position.

```javascript
// lib/index.js:~295
const leafIndex = treeData.leaves.findIndex(leaf => leaf === commitmentBigInt);
```

**Impact:** Attacker can correlate deposits with withdrawals via timing analysis.

**Why not fixed:** Constant-time search would require either:
1. Always searching entire tree (slow)
2. Hash table index (memory overhead)
3. Random ordering (breaks merkle structure)

**Mitigation for demo:** 
- Small tree sizes reduce attack surface
- Network latency adds noise
- Production should use option 2 (hash table)

---

### H6: No TLS/Encryption for P2P Communication
**Status:** 🟡 Documented (not fixed)

**Issue:** All P2P traffic (HTTP + UDP) is unencrypted. Network observers can:
- See which agents are mixing
- Intercept tree data
- Perform MITM attacks

**Impact:** Complete privacy loss on untrusted networks.

**Why not fixed:** TLS implementation would require:
1. Certificate generation/management
2. Self-signed cert pinning infrastructure
3. Significant testing time

**Mitigation for demo:**
- **Require VPN or Tor** for all P2P communication
- Document in README (done)
- Run on trusted networks only (local/VPN)

**Production solution:**
- Use Noise Protocol or WireGuard for DHT
- TLS with self-signed certs + pinning for HTTP
- Or integrate with libp2p (built-in encryption)

---

### M2: Deposit Code Includes chunkId (Fingerprinting)
**Status:** 🟡 Accepted

**Issue:** `chunkId` in deposit code reveals deposit timing window (chunk == time period).

**Impact:** Slightly reduces anonymity set.

**Why not fixed:** chunkId is necessary for efficient tree lookup. Removing it would require:
1. Searching all historical chunks (slow)
2. Or storing chunk-to-leaf mapping (storage overhead)

**Mitigation:** 
- Chunks cover large time windows (many deposits per chunk)
- Still better than no mixing at all

---

### M3: No Local Proof Verification Before Queue
**Status:** 🟡 Accepted for demo

**Issue:** Relayer queues withdraws without verifying ZK proof locally first.

**Impact:** Invalid proofs consume queue space and waste gas on failed TX.

**Why not fixed:** Proof verification is slow (~1-2 seconds). Would create bottleneck on relayer.

**Production solution:**
- Add optional local verification (configurable)
- Implement proof caching with LRU
- Charge small bond that's returned on valid proof

---

### M5: Circuit Files Not Integrity-Checked
**Status:** 🟡 Accepted for demo

**Issue:** No SHA-256 hash verification of `.wasm` and `.zkey` files at startup.

**Impact:** Attacker could replace circuit files with backdoored versions.

**Why not fixed:** Would require:
1. Embedding known-good hashes in code
2. Hash verification on every agent start
3. Handling hash mismatches gracefully

**Mitigation:**
- Circuits bundled in npm package (harder to modify)
- `npm audit` checks package integrity
- Production should add hash verification

---

### M7: Tree Cache Not Validated Against Chain
**Status:** 🟡 Accepted for demo

**Issue:** Cached tree (`~/.cipher/trees/*.json`) loaded without verifying Merkle root matches on-chain.

**Impact:** Corrupted cache causes incorrect proofs (TX will fail but no fund loss).

**Why not fixed:** Would require RPC call on every tree load (slow).

**Mitigation:**
- Cache is regenerated if proof fails
- Agent auto-recovers by rebuilding tree
- Production should add root check with caching

---

### L1: Error Messages Reveal Internal State
**Status:** 🟡 Accepted

**Issue:** Error messages like "Commitment not found in tree" leak operational details.

**Impact:** Minor information leakage. Helps attackers understand system state.

**Why not fixed:** Helpful for debugging during hackathon. Production should use error codes.

---

### L2: No Timeout on RPC Calls
**Status:** 🟡 Accepted

**Issue:** Solana RPC calls can hang indefinitely if network/RPC issues occur.

**Impact:** Agent can become unresponsive.

**Why not fixed:** Would require refactoring all Solana calls to use AbortController.

**Production solution:**
- Wrap all RPC calls with timeout utility
- Add retry logic with exponential backoff

---

### L4: circomlibjs Loaded Lazily
**Status:** 🟡 Accepted

**Issue:** `buildPoseidon()` called on first use, making first proof slower.

**Impact:** Timing fingerprint on first operation (minor).

**Why not fixed:** Minimal impact, adds complexity to initialization.

**Production solution:** Pre-initialize in constructor.

---

## 🚧 Future Improvements (Post-Hackathon)

### 1. Storage Encryption
**Priority:** HIGH  
**Effort:** Medium

Encrypt `~/.cipher/deposits.json` with:
- User-provided password (argon2 + AES-GCM)
- Or OS keychain integration (macOS Keychain, Windows Credential Manager)

### 2. DHT Signed Announcements
**Priority:** HIGH  
**Effort:** High

Implement proper DHT authentication:
- Ed25519 signed node announcements
- Trusted bootstrap node list with known pubkeys
- Node identity verification before adding to routing table

### 3. TLS for P2P
**Priority:** MEDIUM  
**Effort:** High

Add encryption layer:
- Option 1: TLS with self-signed certs + pinning
- Option 2: Noise Protocol
- Option 3: Migrate to libp2p

### 4. Proof Verification in Relayer
**Priority:** MEDIUM  
**Effort:** Medium

Add configurable local proof verification:
- Optional (for performance)
- Cached (LRU cache for repeated proofs)
- With small bond system

### 5. Circuit Integrity Checks
**Priority:** MEDIUM  
**Effort:** Low

Add SHA-256 verification:
```javascript
const CIRCUIT_HASHES = {
  'deposit.wasm': 'abc123...',
  'deposit_final.zkey': 'def456...',
  // ...
};

function verifyCircuit(name) {
  const hash = sha256(fs.readFileSync(name));
  if (hash !== CIRCUIT_HASHES[name]) {
    throw new Error('Circuit integrity check failed!');
  }
}
```

---

## 📋 Security Checklist for Production

Before deploying to mainnet:

### Critical
- [ ] Fix H5 (timing attack) - implement hash table index
- [ ] Fix H6 (TLS) - add encryption for P2P traffic
- [ ] Implement H4 properly - use SQLite with transactions
- [ ] Add M5 (circuit integrity checks)
- [ ] Encrypt M1 storage with password/keychain

### Important
- [ ] Fix M3 - add proof verification in relayer
- [ ] Fix M7 - validate tree cache against on-chain root
- [ ] Fix L2 - add timeouts to all RPC calls
- [ ] Run full security audit by external firm
- [ ] Bug bounty program

### Nice to Have
- [ ] Fix L4 - pre-initialize circomlibjs
- [ ] Fix L1 - use error codes instead of descriptive messages
- [ ] Add comprehensive logging/monitoring
- [ ] Add metrics/telemetry

---

## 🔒 Current Security Posture

**For Hackathon Demo:** ✅ Acceptable
- Core crypto is sound (ZK proofs, CSPRNG)
- Major attack vectors mitigated (input validation, rate limiting)
- Known limitations documented
- VPN requirement clearly stated

**For Production:** ❌ Not Ready
- Must implement TLS/encryption
- Must add DHT authentication
- Must encrypt storage
- Must add all timeouts and proper error handling

---

## 📞 Security Disclosure

Found a security issue? Please report responsibly:
- **Email:** md@metamize.me
- **GPG Key:** [To be added]
- **Response Time:** 48 hours

We appreciate responsible disclosure and will credit researchers in our security hall of fame.

---

*Security is a journey, not a destination. This document will be updated as issues are addressed.*
