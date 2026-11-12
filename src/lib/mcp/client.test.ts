import { beforeEach, describe, expect, it, vi } from "vitest";

// Fake SDK client: each test sets what callTool/connect do; close is always observed.
const fake = vi.hoisted(() => ({
  connect: vi.fn(async () => {}),
  callTool: vi.fn(),
  close: vi.fn(async () => {}),
}));
vi.mock("@modelcontextprotocol/client", async (orig) => {
  const real = await orig<typeof import("@modelcontextprotocol/client")>();
  return {
    ...real,
    Client: class {
      connect = fake.connect;
      callTool = fake.callTool;
      close = fake.close;
    },
    StreamableHTTPClientTransport: class {},
  };
});

const { withMcp, SessionExpiredError, McpToolError } = await import("./client");
const { UnauthorizedError } = await import("@modelcontextprotocol/client");
const errorProbe = (await import("./__fixtures__/kite-error-probe.json")).default;

const token = async () => "t";
const run = (result: unknown) => {
  fake.callTool.mockResolvedValueOnce(result);
  return withMcp("https://x/mcp", token, (call) => call("portfolio", { mode: "holdings" }));
};

describe("withMcp", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns structuredContent and closes", async () => {
    await expect(run({ content: [], structuredContent: { data: [] } })).resolves.toEqual({ data: [] });
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it('isError "kite session has expired" → SessionExpiredError', async () => {
    const r = run({ isError: true, content: [{ type: "text", text: "kite session has expired, please login again" }] });
    await expect(r).rejects.toBeInstanceOf(SessionExpiredError);
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("other isError (recorded fixture) → McpToolError naming tool and mode", async () => {
    const e = (await run(errorProbe).catch((x) => x)) as Error;
    expect(e).toBeInstanceOf(McpToolError);
    expect(e.message).toBe("portfolio:holdings: parameter 'instruments': must be an array of 1-500 non-empty strings");
  });

  it("no structuredContent → McpToolError", async () => {
    await expect(run({ content: [{ type: "text", text: "{}" }] })).rejects.toBeInstanceOf(McpToolError);
  });

  it("401 from the transport → SessionExpiredError, still closed", async () => {
    fake.connect.mockRejectedValueOnce(new UnauthorizedError("Authentication failed"));
    await expect(withMcp("https://x/mcp", token, async () => 1)).rejects.toBeInstanceOf(SessionExpiredError);
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("closes when fn throws, and the error passes through", async () => {
    const boom = new Error("boom");
    await expect(
      withMcp("https://x/mcp", token, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(fake.close).toHaveBeenCalledOnce();
  });
});
