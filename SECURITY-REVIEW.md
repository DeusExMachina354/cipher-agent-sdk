# 🔒 Security Code Review: cipher-agent-sdk

**Initial Review:** 2025-02-06 11:17 PST  
**Fixes Completed:** 2025-02-06 11:31 PST  
**Reviewer:** Opus (Clawdbot Security Agent)  
**Scope:** Full codebase security review for production deployment

## ✅ UPDATE: All Critical/High Issues FIXED

**Performance & Code Quality improvements also completed!**

See git commits:
- `61d79e4` - CRITICAL + HIGH security fixes
- `359660c` - MEDIUM + LOW issues + security docs
- `fb29606` - Security notes for remaining issues
- `e25f534` - P1 (sparse tree) + P2 (async I/O)
- `0bf1e5c` - Q1 (shared Poseidon) + Q2 (DEBUG logging)
- `59b2e18` - Fetch timeouts + Poseidon pre-init

---

---

## 📊 Executive Summary

| Severity | Count |
|----------|-------|
| 🔴 Critical | 3 |
| 🟠 High | 6 |
| 🟡 Medium | 8 |
| 🔵 Low | 5 |

**Overall Risk Level:** HIGH — Must fix Critical/High issues before production!

---

## 🔴 CRITICAL ISSUES

### C1: Deposit Secrets Stored in Plaintext
**File:** `lib/storage.js` + `lib/index.js`
**Lines:** storage.js:54-59, index.js:248

**Issue:** Deposit codes (containing secret + nullifier) are stored in plaintext JSON at `~/.cipher/deposits.json`. Anyone with filesystem access can steal funds.

```javascript
// storage.js:54
fs.writeFileSync(
  this.storageFile,
  JSON.stringify(deposits, null, 2),  // ← PLAINTEXT!
  "utf-8"
);
```

**Impact:** Complete loss of funds if attacker gains file access
**Fix:** 
1. Encrypt storage file with user-provided password (argon2 + AES-GCM)
2. Use OS keychain (macOS Keychain, Windows Credential Manager)
3. At minimum: chmod 600 on file + warn users

---

### C2: Private Key Logged on Generation
**File:** `lib/index.js`
**Line:** 48

**Issue:** When generating a new keypair, the PUBLIC key is logged (which is fine), BUT the secret key is stored in memory without secure handling.

```javascript
console.log("⚠️  Generated new keypair:", this.wallet.publicKey.toBase58());
```

**More Critical:** The keypair JSON loading has no validation:
```javascript
// lib/index.js:44
const keypairData = JSON.parse(fs.readFileSync(config.keypair, "utf-8"));
this.wallet = Keypair.fromSecretKey(Uint8Array.from(keypairData));
```

**Impact:** No file permission checks, no format validation
**Fix:**
1. Check file permissions before reading keypair (should be 600)
2. Validate keypair format before use
3. Clear keypair from memory when not needed
4. Never log anything derivable from private keys

---

### C3: DHT Bootstrap Without Authentication
**File:** `lib/dht.js`
**Lines:** 414-436

**Issue:** DHT bootstrap accepts ANY node without verification. Attacker can poison the DHT, redirect all traffic, and intercept/modify trees.

```javascript
// dht.js:414
async bootstrap(peer) {
  // No authentication! Attacker node accepted blindly
  const alive = await this.ping(peer);
  if (!alive) throw new Error('Bootstrap peer unreachable');
  this.addNode(peer);  // ← Trusted immediately
}
```

**Impact:** Complete network takeover via Sybil attack
**Fix:**
1. Require signed node announcements (Ed25519)
2. Maintain trusted bootstrap node list with known pubkeys
3. Verify node identity before adding to routing table

---

## 🟠 HIGH ISSUES

### H1: No Input Validation on Relayer Endpoint
**File:** `lib/relayer.js`
**Lines:** 82-92

**Issue:** `/relayer/submit` accepts any JSON without schema validation. Malformed proof data can crash the agent or cause undefined behavior.

```javascript
const { proof, recipient, amount, chunkId } = JSON.parse(body);

// Only checks for existence, not type/format
if (!proof || !recipient || !amount || chunkId === undefined) {
  // ...
}
```

**Impact:** DoS, potential code injection via crafted input
**Fix:**
```javascript
// Add strict validation
if (typeof amount !== 'number' || amount <= 0 || amount > MAX_AMOUNT) {
  throw new Error('Invalid amount');
}
if (typeof recipient !== 'string' || !isValidBase58(recipient)) {
  throw new Error('Invalid recipient');
}
// Validate proof structure matches expected format
```

---

### H2: No Rate Limiting on P2P/Relayer Endpoints
**File:** `lib/p2p.js`, `lib/relayer.js`
**Lines:** p2p.js:106-180

**Issue:** HTTP server accepts unlimited requests. Easy DoS vector.

**Impact:** Agent can be knocked offline by flooding
**Fix:**
1. Implement per-IP rate limiting (e.g., 10 req/min)
2. Use sliding window counter
3. Consider proof-of-work for expensive operations

---

### H3: Peer List Persistence Without Validation
**File:** `lib/p2p.js`
**Lines:** 66-77, 94-100

**Issue:** `known-peers.json` is loaded without validation. Attacker can modify file to inject malicious peers.

```javascript
const data = JSON.parse(fs.readFileSync(PEERS_FILE, 'utf-8'));
data.forEach(p => {
  this.peers.set(`${p.host}:${p.port}`, {
    // No validation of host/port!
  });
});
```

**Impact:** Redirect traffic to attacker nodes
**Fix:**
1. Validate host is valid IP/hostname
2. Validate port is in valid range (1024-65535)
3. Optionally sign peer list

---

### H4: Race Condition in Deposit Storage
**File:** `lib/storage.js`
**Lines:** 55-61, 71-79

**Issue:** `loadDeposits()` → modify → `saveDeposits()` is not atomic. Two concurrent deposits can overwrite each other.

```javascript
addDeposit(code, txId, metadata = {}) {
  const deposits = this.loadDeposits();  // ← Read
  deposits.push({...});                   // ← Modify
  this.saveDeposits(deposits);            // ← Write (not atomic!)
}
```

**Impact:** Lost deposit records
**Fix:**
1. Use file locking (e.g., `proper-lockfile`)
2. Or use SQLite with transactions
3. Or use atomic write pattern (write to temp, rename)

---

### H5: Timing Attack on Commitment Search
**File:** `lib/index.js`
**Lines:** 293-304

**Issue:** Sequential search through tree reveals timing information about leaf index.

```javascript
const leafIndex = treeData.leaves.findIndex(leaf => leaf === commitmentBigInt);
```

**Impact:** Attacker can correlate deposits with withdrawals via timing
**Fix:**
1. Add constant-time delay after search
2. Or randomize search order
3. Or use hash table for O(1) lookup

---

### H6: No TLS/Encryption for P2P Communication
**File:** `lib/p2p.js`, `lib/dht.js`
**Lines:** Entire files

**Issue:** All P2P traffic is plaintext HTTP/UDP. Anyone on the network can:
- See which agents are mixing
- Intercept tree data
- Perform MITM attacks

**Impact:** Complete privacy loss on untrusted networks
**Fix:**
1. Wrap HTTP in TLS (self-signed certs with cert pinning)
2. Use Noise Protocol or WireGuard for DHT
3. At minimum: Document that VPN/Tor is required

---

## 🟡 MEDIUM ISSUES

### M1: Sensitive Data in Logs
**File:** `lib/index.js`, `lib/relayer.js`
**Lines:** index.js:235-237, 349

**Issue:** Logs partial commitment and nullifier hash, which reduces anonymity set.

```javascript
console.log("   Commitment:", commitment.substring(0, 40) + "...");
console.log("   Nullifier hash:", nullifierHash.substring(0, 20) + "...");
```

**Impact:** Log correlation can deanonymize users
**Fix:** Remove or make configurable with `DEBUG` flag

---

### M2: Deposit Code Includes chunkId (Fingerprinting)
**File:** `lib/deposit-code.js`
**Lines:** 35-47

**Issue:** Deposit code encodes `chunkId` which reveals deposit timing window.

**Impact:** Reduces anonymity set
**Fix:** Consider not including chunkId, derive from tree search instead

---

### M3: No Proof Verification Before Queue
**File:** `lib/relayer.js`
**Lines:** 82-107

**Issue:** Relayer queues withdraw requests without verifying ZK proof locally first. Attacker can flood queue with invalid proofs.

**Impact:** Resource exhaustion, delayed legitimate transactions
**Fix:** Call snarkjs.groth16.verify() before queuing

---

### M4: Console.log Contains IP Addresses
**File:** `lib/p2p.js`
**Line:** 367

**Issue:** `console.log(\`✨ Discovered peer: ${host}:${port}\`)` logs peer IPs.

**Impact:** Log analysis reveals network topology
**Fix:** Hash or redact IPs in production mode

---

### M5: No Verification of Circuit Files
**File:** `lib/proof.js`
**Lines:** 15-19

**Issue:** Circuit files (`.wasm`, `.zkey`) loaded without integrity check.

```javascript
const DEPOSIT_WASM = path.join(CIRCUITS_DIR, "deposit.wasm");
// No hash verification!
```

**Impact:** Attacker can replace circuits with malicious versions
**Fix:** Verify SHA-256 hash of circuit files at startup

---

### M6: Math.random() Used for Delays (Not Secure)
**File:** `lib/relayer.js`
**Line:** 134

**Issue:** `Math.random()` is not cryptographically secure for timing randomization.

```javascript
randomDelay() {
  return Math.floor(Math.random() * (this.maxDelay - this.minDelay + 1)) + this.minDelay;
}
```

**Impact:** Predictable delays reduce privacy
**Fix:** Use `crypto.randomInt()` instead

---

### M7: Tree Cache Not Validated
**File:** `lib/p2p.js`
**Lines:** 586-618

**Issue:** Tree cache loaded from disk without Merkle root verification against on-chain data.

**Impact:** Attacker can corrupt cache to cause incorrect proofs
**Fix:** Verify cached root matches on-chain root before using

---

### M8: No Connection Limit for HTTP Server
**File:** `lib/p2p.js`
**Line:** 106+

**Issue:** HTTP server has no `maxConnections` limit.

**Impact:** Resource exhaustion DoS
**Fix:** Set `server.maxConnections = 100` or similar

---

## 🔵 LOW ISSUES

### L1: Error Messages Reveal Internal State
**File:** `lib/index.js`
**Lines:** Various

**Issue:** Error messages like `"Commitment not found in tree"` reveal operational details.

**Fix:** Use generic error messages in production

---

### L2: No Timeout on RPC Calls
**File:** `lib/index.js`
**Lines:** Various Solana calls

**Issue:** Solana RPC calls have no explicit timeout, can hang indefinitely.

**Fix:** Add AbortController with timeout

---

### L3: Package Has No package-lock.json
**File:** Project root

**Issue:** No lockfile means dependency versions can drift.

**Impact:** Supply chain attack risk
**Fix:** Run `npm install` and commit `package-lock.json`

---

### L4: circomlibjs Loaded Lazily
**File:** `lib/proof.js`
**Line:** 23

**Issue:** `buildPoseidon()` called lazily, first proof takes longer.

**Impact:** Timing fingerprint on first operation
**Fix:** Pre-initialize on agent start

---

### L5: No CORS Restriction
**File:** `lib/p2p.js`, `lib/relayer.js`
**Lines:** p2p.js:110, relayer.js:58

**Issue:** `Access-Control-Allow-Origin: *` allows any origin.

**Impact:** Cross-origin attacks if agent runs on public network
**Fix:** Restrict to known origins or localhost

---

## 📋 Recommended Fix Priority

### Before Hackathon Demo (Must Have)
1. **C1** - Encrypt deposit storage (or at minimum chmod 600)
2. **C3** - Add basic node verification for DHT
3. **H1** - Input validation on relayer endpoint
4. **H2** - Basic rate limiting

### Before Production (Should Have)
5. **C2** - Secure keypair handling
6. **H3** - Validate peer list on load
7. **H4** - Atomic file writes
8. **H6** - TLS for P2P (or document VPN requirement)
9. **M5** - Circuit file integrity check
10. **L3** - Add package-lock.json

### Nice to Have
11. **M1-M4** - Reduce log verbosity
12. **M6** - Crypto random for delays
13. **H5** - Constant-time search
14. All Low issues

---

## 🛡️ P2P/DHT Specific Vulnerabilities

### Sybil Attack Resistance
**Current Status:** ❌ NONE
- Any node can join DHT without cost
- Attacker can create thousands of fake nodes
- Can eclipse honest nodes

**Mitigation:**
1. Require stake/deposit to join DHT
2. Rate-limit node additions
3. Prefer long-lived nodes over new ones

### DHT Poisoning
**Current Status:** ❌ VULNERABLE
- No authentication on stored values
- `STORE` operation accepts anything

**Mitigation:**
1. Sign all stored values
2. Verify signatures before trusting

### Eclipse Attack
**Current Status:** ❌ VULNERABLE
- No diversity requirements for bucket
- All peers from same /16 could be added

**Mitigation:**
1. Limit nodes per IP range
2. Require geographic diversity

---

## 🔐 ZK Proof Handling Assessment

### ✅ Good Practices Found
- Uses Node.js `crypto.randomBytes()` for secrets (CSPRNG)
- Poseidon hash used correctly (matches circuit)
- Nullifier hash prevents double-spend

### ⚠️ Areas for Improvement
- No local proof verification before submission
- Circuit files not integrity-checked
- Path indices not validated against tree height

---

## 📁 File Permission Recommendations

```bash
# Secrets directory
chmod 700 ~/.cipher/
chmod 600 ~/.cipher/deposits.json
chmod 600 ~/.cipher/known-peers.json

# Circuit files (read-only)
chmod 444 circuits/*.wasm circuits/*.zkey
```

---

## 🔄 Dependency Analysis

| Package | Version | Known Issues |
|---------|---------|--------------|
| @solana/web3.js | ^1.95.8 | Check for updates |
| snarkjs | ^0.7.5 | Trusted, widely used |
| @coral-xyz/anchor | ^0.30.1 | Minor issues, generally safe |
| circomlibjs | (peer) | Trusted |
| bs58 | (peer) | Trusted |

**Recommendation:** Run `npm audit` after creating package-lock.json

---

## ✅ What's Done Well

1. **Proper CSPRNG usage** - `crypto.randomBytes()` for all secrets
2. **Correct Poseidon implementation** - Matches circuit exactly
3. **Merkle path calculation** - Follows standard algorithm
4. **Nullifier tracking** - Prevents double-spend
5. **Clean separation** - Modular code structure
6. **Relayer privacy** - Delays reduce timing correlation

---

## 📝 Summary

The SDK has a solid cryptographic foundation but lacks defensive security measures typical for production systems:

1. **Storage security** is the #1 priority - secrets in plaintext is a deal-breaker
2. **P2P layer** needs authentication to prevent network attacks
3. **Input validation** missing throughout
4. **Rate limiting** non-existent

For a hackathon demo: Fix C1, C3, H1, H2 minimum.
For production: All Critical and High issues must be resolved.

---

*Report generated by Clawdbot Security Review - 2025-02-06*
