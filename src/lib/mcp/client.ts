// Per-request MCP client: connect → run → close, with no LLM on the data path (ADR-0001).
// Raw MCP results never leave lib/mcp; broker modules parse them into domain shapes.
import { Client, SdkHttpError, StreamableHTTPClientTransport, UnauthorizedError } from "@modelcontextprotocol/client";

/** The broker session behind the MCP token is gone (401, or Kite's "session expired"). Caller marks the connection stale. */
export class SessionExpiredError extends Error {
  override name = "SessionExpiredError";
}

/** A tool returned `isError`, no structured result, or a result that failed its schema. */
export class McpToolError extends Error {
  override name = "McpToolError";
  constructor(
    public tool: string,
    public mode: string,
    message: string,
  ) {
    super(`${tool}:${mode}: ${message}`);
  }
}

/** Calls one tool and returns its `structuredContent`; `isError` results throw. */
export type ToolCaller = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

// Kite: "kite session has expired" once the underlying Kite session dies (06:00 IST or a server restart).
const SESSION_EXPIRED = /session (has )?expired|session is (invalid|expired)|token (is )?(invalid|expired)/i;

const isUnauthorized = (e: unknown) =>
  e instanceof UnauthorizedError || (e instanceof SdkHttpError && e.status === 401);

export async function withMcp<T>(
  url: string,
  token: () => Promise<string | undefined>,
  fn: (call: ToolCaller) => Promise<T>,
): Promise<T> {
  // "auto" negotiates the stateless 2026-07-28 protocol Kite speaks (U1 spike).
  const client = new Client({ name: "stockboard", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { authProvider: { token } }));
    return await fn(async (tool, args) => {
      const r = await client.callTool({ name: tool, arguments: args });
      const mode = String(args.mode ?? "");
      if (r.isError) {
        const text = (r.content as { text?: string }[] | undefined)?.[0]?.text ?? "tool error";
        if (SESSION_EXPIRED.test(text)) throw new SessionExpiredError(`${tool}:${mode}: ${text}`);
        throw new McpToolError(tool, mode, text);
      }
      if (r.structuredContent === undefined) throw new McpToolError(tool, mode, "no structuredContent");
      return r.structuredContent;
    });
  } catch (e) {
    if (isUnauthorized(e)) throw new SessionExpiredError("MCP server rejected the token (401)", { cause: e });
    throw e;
  } finally {
    await client.close().catch(() => {});
  }
}
