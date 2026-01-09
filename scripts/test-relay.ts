/**
 * Test script for the sponsor relay endpoint
 *
 * Usage:
 *   npx tsx scripts/test-relay.ts <private-key> [relay-url]
 *
 * Examples:
 *   # Test against local dev server
 *   npx tsx scripts/test-relay.ts your-private-key-hex http://localhost:8787
 *
 *   # Test against deployed staging
 *   npx tsx scripts/test-relay.ts your-private-key-hex https://x402-relay-staging.your-domain.workers.dev
 */

import {
  makeSTXTokenTransfer,
  getAddressFromPrivateKey,
  TransactionVersion,
  AnchorMode,
} from "@stacks/transactions";

const TESTNET_FAUCET = "ST000000000000000000002AMW42H"; // Testnet faucet address

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.error("Usage: npx tsx scripts/test-relay.ts <private-key> [relay-url]");
    console.error("");
    console.error("Arguments:");
    console.error("  private-key  Hex-encoded private key for signing");
    console.error("  relay-url    Relay endpoint URL (default: http://localhost:8787)");
    process.exit(1);
  }

  const privateKey = args[0];
  const relayUrl = args[1] || "http://localhost:8787";

  // Derive sender address
  const senderAddress = getAddressFromPrivateKey(privateKey, TransactionVersion.Testnet);
  console.log(`Sender address: ${senderAddress}`);

  // Build a sponsored STX transfer (small amount to faucet)
  console.log("\nBuilding sponsored transaction...");
  const transaction = await makeSTXTokenTransfer({
    recipient: TESTNET_FAUCET,
    amount: 1000n, // 0.001 STX in microSTX
    senderKey: privateKey,
    network: "testnet",
    memo: "test-relay",
    anchorMode: AnchorMode.Any,
    sponsored: true,
    fee: 0n, // Sponsor will pay
  });

  // Serialize to hex
  const txHex = Buffer.from(transaction.serialize()).toString("hex");
  console.log(`Transaction hex: ${txHex.slice(0, 50)}...`);
  console.log(`Transaction length: ${txHex.length} chars`);

  // Send to relay
  console.log(`\nSending to relay: ${relayUrl}/relay`);
  try {
    const response = await fetch(`${relayUrl}/relay`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ transaction: txHex }),
    });

    const result = await response.json();

    if (response.ok) {
      console.log("\n=== SUCCESS ===");
      console.log(`Transaction ID: ${result.txid}`);
      console.log(`Explorer: https://explorer.stacks.co/txid/${result.txid}?chain=testnet`);
    } else {
      console.error("\n=== ERROR ===");
      console.error(`Status: ${response.status}`);
      console.error(`Error: ${result.error}`);
      if (result.details) {
        console.error(`Details: ${result.details}`);
      }
      process.exit(1);
    }
  } catch (e) {
    console.error("\n=== NETWORK ERROR ===");
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

main();
