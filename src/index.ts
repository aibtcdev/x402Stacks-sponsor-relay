import {
  sponsorTransaction,
  deserializeTransaction,
  broadcastTransaction,
  AuthType,
} from "@stacks/transactions";
import { STACKS_MAINNET, STACKS_TESTNET } from "@stacks/network";

// Augment Env with secrets (set via wrangler secret put)
declare global {
  interface Env {
    SPONSOR_PRIVATE_KEY: string;
  }
}

/**
 * LogsRPC interface (from worker-logs service)
 * Defined locally since worker-logs isn't a published package
 */
interface LogsRPC {
  info(appId: string, message: string, context?: Record<string, unknown>): Promise<void>;
  warn(appId: string, message: string, context?: Record<string, unknown>): Promise<void>;
  error(appId: string, message: string, context?: Record<string, unknown>): Promise<void>;
  debug(appId: string, message: string, context?: Record<string, unknown>): Promise<void>;
}

/**
 * Request body for /relay endpoint
 */
interface RelayRequest {
  /** Hex-encoded signed sponsored transaction */
  transaction: string;
}

/**
 * Response from /relay endpoint
 */
interface RelayResponse {
  /** Transaction ID if successful */
  txid?: string;
  /** Error message if failed */
  error?: string;
  /** Additional details */
  details?: string;
}

const APP_ID = "x402-relay";

/**
 * Get network instance from env
 */
function getNetwork(env: Env) {
  return env.STACKS_NETWORK === "mainnet" ? STACKS_MAINNET : STACKS_TESTNET;
}

/**
 * Simple rate limiting using in-memory map
 * In production, use Durable Objects or KV for distributed rate limiting
 */
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 10; // requests per window
const RATE_WINDOW_MS = 60 * 1000; // 1 minute

function checkRateLimit(address: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(address);

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(address, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }

  if (entry.count >= RATE_LIMIT) {
    return false;
  }

  entry.count++;
  return true;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();
    const logs = env.LOGS as unknown as LogsRPC;

    // CORS headers for all responses
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check endpoint
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          network: env.STACKS_NETWORK,
          version: "0.1.0",
        }),
        {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        }
      );
    }

    // Sponsor relay endpoint
    if (url.pathname === "/relay" && request.method === "POST") {
      ctx.waitUntil(
        logs.info(APP_ID, "Relay request received", {
          request_id: requestId,
        })
      );

      try {
        // Parse request body
        const body = (await request.json()) as RelayRequest;

        if (!body.transaction) {
          return new Response(
            JSON.stringify({ error: "Missing transaction field" } as RelayResponse),
            { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }

        // Remove 0x prefix if present
        const txHex = body.transaction.startsWith("0x")
          ? body.transaction.slice(2)
          : body.transaction;

        // Deserialize the transaction
        let transaction;
        try {
          transaction = deserializeTransaction(txHex);
        } catch (e) {
          ctx.waitUntil(
            logs.warn(APP_ID, "Failed to deserialize transaction", {
              request_id: requestId,
              error: e instanceof Error ? e.message : "Unknown error",
            })
          );
          return new Response(
            JSON.stringify({
              error: "Invalid transaction",
              details: "Could not deserialize transaction hex",
            } as RelayResponse),
            { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }

        // Verify it's a sponsored transaction
        if (transaction.auth.authType !== AuthType.Sponsored) {
          ctx.waitUntil(
            logs.warn(APP_ID, "Transaction not sponsored", {
              request_id: requestId,
              auth_type: transaction.auth.authType,
            })
          );
          return new Response(
            JSON.stringify({
              error: "Transaction must be sponsored",
              details: "Build transaction with sponsored: true",
            } as RelayResponse),
            { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }

        // Get sender address for rate limiting
        const senderAddress = transaction.auth.spendingCondition.signer;
        const senderHex = Buffer.from(senderAddress).toString("hex");

        // Check rate limit
        if (!checkRateLimit(senderHex)) {
          ctx.waitUntil(
            logs.warn(APP_ID, "Rate limit exceeded", {
              request_id: requestId,
              sender: senderHex,
            })
          );
          return new Response(
            JSON.stringify({
              error: "Rate limit exceeded",
              details: `Maximum ${RATE_LIMIT} requests per minute`,
            } as RelayResponse),
            { status: 429, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }

        // Check for sponsor private key
        if (!env.SPONSOR_PRIVATE_KEY) {
          ctx.waitUntil(logs.error(APP_ID, "Sponsor key not configured", { request_id: requestId }));
          return new Response(
            JSON.stringify({
              error: "Service not configured",
              details: "Sponsor key missing",
            } as RelayResponse),
            { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }

        const network = getNetwork(env);

        // Sponsor the transaction
        let sponsoredTx;
        try {
          sponsoredTx = await sponsorTransaction({
            transaction,
            sponsorPrivateKey: env.SPONSOR_PRIVATE_KEY,
            network,
          });
        } catch (e) {
          ctx.waitUntil(
            logs.error(APP_ID, "Failed to sponsor transaction", {
              request_id: requestId,
              error: e instanceof Error ? e.message : "Unknown error",
            })
          );
          return new Response(
            JSON.stringify({
              error: "Failed to sponsor transaction",
              details: e instanceof Error ? e.message : "Unknown error",
            } as RelayResponse),
            { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }

        // Broadcast the transaction
        let broadcastResult: { txid?: string; error?: string; reason?: string };
        try {
          const result = await broadcastTransaction({ transaction: sponsoredTx, network });
          // Cast to simple object to avoid type inference issues
          broadcastResult = result as { txid?: string; error?: string; reason?: string };
        } catch (e) {
          ctx.waitUntil(
            logs.error(APP_ID, "Failed to broadcast transaction", {
              request_id: requestId,
              error: e instanceof Error ? e.message : "Unknown error",
            })
          );
          return new Response(
            JSON.stringify({
              error: "Failed to broadcast transaction",
              details: e instanceof Error ? e.message : "Unknown error",
            } as RelayResponse),
            { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }

        // Check for broadcast errors (rejected results have 'error' property)
        if (broadcastResult.error) {
          ctx.waitUntil(
            logs.error(APP_ID, "Broadcast rejected", {
              request_id: requestId,
              error: broadcastResult.error,
              reason: broadcastResult.reason,
            })
          );
          return new Response(
            JSON.stringify({
              error: "Broadcast rejected",
              details: broadcastResult.reason || broadcastResult.error,
            } as RelayResponse),
            { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }

        // Success
        const txid = broadcastResult.txid!;
        ctx.waitUntil(
          logs.info(APP_ID, "Transaction sponsored and broadcast", {
            request_id: requestId,
            txid,
            sender: senderHex,
          })
        );

        return new Response(JSON.stringify({ txid } as RelayResponse), {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      } catch (e) {
        ctx.waitUntil(
          logs.error(APP_ID, "Unexpected error", {
            request_id: requestId,
            error: e instanceof Error ? e.message : "Unknown error",
          })
        );
        return new Response(
          JSON.stringify({
            error: "Internal server error",
            details: e instanceof Error ? e.message : "Unknown error",
          } as RelayResponse),
          { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
    }

    // Default response
    return new Response("x402 Stacks Sponsor Relay\n\nPOST /relay - Submit sponsored transaction\nGET /health - Health check", {
      headers: { "Content-Type": "text/plain", ...corsHeaders },
    });
  },
};
