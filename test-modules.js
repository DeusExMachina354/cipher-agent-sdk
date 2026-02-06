/**
 * Quick module loading test
 * Ensures all modules can be required without errors
 */

console.log("🧪 Testing module loading...\n");

const tests = [
  { name: "crypto.js", module: "./lib/crypto" },
  { name: "proof.js", module: "./lib/proof" },
  { name: "tree.js", module: "./lib/tree" },
  { name: "storage.js", module: "./lib/storage" },
  { name: "relayer.js", module: "./lib/relayer" },
  { name: "p2p.js", module: "./lib/p2p" },
  { name: "dht.js", module: "./lib/dht" },
  { name: "index.js (main)", module: "./lib/index" },
];

let passed = 0;
let failed = 0;

for (const test of tests) {
  try {
    require(test.module);
    console.log(`✅ ${test.name}`);
    passed++;
  } catch (err) {
    console.error(`❌ ${test.name}: ${err.message}`);
    failed++;
  }
}

console.log(`\n📊 Results: ${passed}/${tests.length} passed`);

if (failed > 0) {
  process.exit(1);
}

console.log("\n✅ All modules loaded successfully!");
