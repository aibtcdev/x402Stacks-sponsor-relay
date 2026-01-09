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

const APP_ID = "x402-relay";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();

    // Health check endpoint
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", network: env.STACKS_NETWORK }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // TODO: Implement sponsor relay endpoint
    if (url.pathname === "/relay" && request.method === "POST") {
      // Cast LOGS to RPC interface (Service binding with entrypoint)
      const logs = env.LOGS as unknown as LogsRPC;

      // Log the incoming request (fire-and-forget)
      ctx.waitUntil(
        logs.info(APP_ID, "Relay request received", {
          request_id: requestId,
          method: request.method,
          url: request.url,
        })
      );

      // TODO: Implement relay logic
      return new Response(JSON.stringify({ error: "Not implemented" }), {
        status: 501,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("x402 Stacks Sponsor Relay", {
      headers: { "Content-Type": "text/plain" },
    });
  },
};
