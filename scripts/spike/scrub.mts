// U1 spike: turn scripts/spike/out/ (raw, gitignored) into committed, scrubbed fixtures, then leak-check
// every non-ignored repo file. Keeps field names, types, nesting and pagination exactly; replaces symbols,
// ids, PII and numbers. Run after kite-headless.mts: pnpm tsx scripts/spike/scrub.mts
// Prints counts only — never a real value.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

process.loadEnvFile(".env.spike.local");
const OUT = "scripts/spike/out";
const MCP_FX = "src/lib/mcp/__fixtures__";
const KITE_FX = "src/lib/mcp/kite/__fixtures__";
mkdirSync(MCP_FX, { recursive: true });
mkdirSync(KITE_FX, { recursive: true });
const read = (f: string) => JSON.parse(readFileSync(`${OUT}/${f}`, "utf8"));
const write = (path: string, v: unknown) => writeFileSync(path, typeof v === "string" ? v : JSON.stringify(v, null, 2) + "\n");

// Deterministic PRNG so re-runs produce identical fixtures.
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

const real = new Map<string, string>(); // real string → fake (also drives the leak check)
const realSymbols = new Set<string>();
const symName = (n: number) => String.fromCharCode(65 + (n % 26)).repeat(4) + (n >= 26 ? Math.floor(n / 26) : "");
let symCount = 0;
const fakeSymbol = (s: string) => {
  if (!real.has(s)) real.set(s, symName(symCount++));
  realSymbols.add(s);
  return real.get(s)!;
};
// Same length and character classes: digits → digits, letters → letters of the same case.
const fakeId = (s: string) => {
  if (!s) return s;
  if (!real.has(s))
    real.set(s, s.replace(/[0-9]/g, () => String(int(0, 9))).replace(/[A-Z]/g, () => String.fromCharCode(int(65, 90))).replace(/[a-z]/g, () => String.fromCharCode(int(97, 122))));
  return real.get(s)!;
};
const realNums = new Set<number>();

const SYMBOL_KEYS = /^(tradingsymbol|symbol)$/;
const ID_KEYS = /^(trade_id|order_id|exchange_order_id|parent_order_id|guid|account_id|placed_by|user_id|isin|instrument_token|exchange_token|request_id|client_id|session_id|tag|auction_number|kite_user_id)$/;
const PII: Record<string, string> = { user_name: "Test User", user_shortname: "Test", email: "user@example.com", avatar_url: "https://example.com/avatar.png", pan: "AAAAA0000A", phone: "0000000000", mobile: "0000000000" };
const KEEP_NUM = /^(from|limit|total|returned|has_more|multiplier|requested_count|returned_count|validity_ttl|lot_size|tick_size)$/;
const INSTR = /^(NSE|BSE|NFO|BFO|MCX|CDS|BCD):(.+)$/;

function scrubString(key: string, s: string): string {
  if (SYMBOL_KEYS.test(key)) return fakeSymbol(s);
  if (ID_KEYS.test(key)) return fakeId(s);
  if (key in PII) {
    if (s) real.set(s, PII[key]);
    return s ? PII[key] : s;
  }
  const m = INSTR.exec(s);
  if (m) return `${m[1]}:${fakeSymbol(m[2])}`;
  return s;
}
function scrubNumber(key: string, n: number): number {
  if (KEEP_NUM.test(key) || n === 0) return n;
  realNums.add(n);
  if (ID_KEYS.test(key)) return Number(fakeId(String(n)).replace(/^0/, "1"));
  const sign = Math.sign(n);
  if (/quantity/.test(key) || Number.isInteger(n) && Math.abs(n) < 10000 && /qty|count/.test(key)) return sign * int(1, 200);
  if (/percentage/.test(key)) return sign * +(rnd() * 5).toFixed(2);
  return sign * +(10 + rnd() * 3000).toFixed(2);
}
function scrub(v: unknown, key = ""): unknown {
  if (Array.isArray(v)) return v.map((x) => scrub(x, key));
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [INSTR.test(k) ? (scrubString("", k) as string) : k, scrub(x, k)]));
  if (typeof v === "string") return scrubString(key, v);
  if (typeof v === "number") return scrubNumber(key, v);
  return v;
}
type Row = Record<string, number>;
// Re-impose the quantity relations observed live (see docs/spikes/mcp-findings.md).
function fixInvariants(sc: { data?: Row[] }) {
  for (const r of Array.isArray(sc.data) ? sc.data : []) {
    if ("opening_quantity" in r && "used_quantity" in r) {
      if (r.used_quantity > r.opening_quantity) r.opening_quantity = r.used_quantity + int(1, 50);
      r.quantity = r.opening_quantity - r.used_quantity;
      r.realised_quantity = r.quantity;
      if (r.authorised_quantity) r.authorised_quantity = r.opening_quantity;
    }
    if ("buy_quantity" in r && "sell_quantity" in r) r.quantity = r.buy_quantity - r.sell_quantity;
    if ("filled_quantity" in r) r.filled_quantity = r.quantity - r.pending_quantity - r.cancelled_quantity;
  }
}
// Whole-token replacement of any real value that slipped into free text.
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sweep = (text: string) => {
  for (const [r, f] of real) if (r.length >= 3) text = text.replace(new RegExp(`(?<![A-Za-z0-9])${escape(r)}(?![A-Za-z0-9])`, "g"), f);
  return text;
};

// ---- MCP tool results → src/lib/mcp/__fixtures__/kite-<label>.json
const files = readdirSync(OUT).filter((f) => /^mcp-.*\.json$/.test(f) && f !== "mcp-tools-list.json");
const scrubbed: [string, Record<string, unknown>][] = [];
for (const f of files) {
  const raw = read(f);
  const out = scrub(raw) as { structuredContent?: { data?: Row[] }; content?: { type: string; text?: string }[] };
  if (out.structuredContent) fixInvariants(out.structuredContent);
  // content[0].text is JSON.stringify(structuredContent) on the live server — keep that equality.
  for (const c of out.content ?? [])
    if (c.type === "text" && c.text) {
      try {
        JSON.parse(c.text);
        c.text = JSON.stringify(out.structuredContent ?? scrub(JSON.parse(c.text)));
      } catch {
        /* plain error text: swept below */
      }
    }
  scrubbed.push([f, out as Record<string, unknown>]);
}
for (const [f, out] of scrubbed) write(`${MCP_FX}/${f.replace(/^mcp-/, "kite-")}`, sweep(JSON.stringify(out, null, 2)) + "\n");
write(`${MCP_FX}/kite-tools-list.json`, read("mcp-tools-list.json")); // public server metadata

// ---- U7 HTTP-chain fixtures → src/lib/mcp/kite/__fixtures__/
const S = read("summary.json");
const flowIds = new Set<string>();
const hops = (S.hops as { setCookies: string[] }[]).map((h) => ({
  ...h,
  setCookies: h.setCookies.map((c) => c.replace(/^(__Host-kite-(?:consent|state)-)(.+)$/, (_, p, id) => (flowIds.add(id), `${p}<flow>`))),
}));
for (const id of flowIds) real.set(id, "<flow>");
write(`${KITE_FX}/headless-chain.json`, {
  note: "Observed 2026-11-12 (U1). Hosts/paths/status/cookie names and query param NAMES only; no values.",
  steps: S.steps,
  hops,
  dcr: S.dcr,
  mcpCallback: S.mcpCallback,
  tokenResponse: { keys: S.mcpToken?.responseKeys, token_type: S.mcpToken?.token_type, scope: S.mcpToken?.scope, expires_in: S.mcpToken?.expires_in, claimNames: S.mcpToken?.claimNames },
  zerodhaLoginShape: read("zerodha-login.shape.json"),
  zerodhaTwofaShape: read("zerodha-twofa.shape.json"),
});
write(`${KITE_FX}/mcp-consent.html`, readFileSync(`${OUT}/mcp-consent.html`, "utf8"));
for (const f of readdirSync(OUT).filter((f) => /^connect-.*\.json$/.test(f))) write(`${KITE_FX}/${f}`, sweep(JSON.stringify(scrub(read(f)), null, 2)) + "\n");

// ---- Leak check over every file git would commit (tracked + untracked, not ignored)
const secrets = ["KITE_API_KEY", "KITE_API_SECRET", "KITE_USER_ID", "KITE_PASSWORD", "KITE_TOTP_SECRET"].map((k) => process.env[k]!).filter(Boolean);
const dcr = existsSync(`${OUT}/dcr.json`) ? read("dcr.json").client_id : undefined;
// Whole repo: credentials, api-key prefix, DCR client id, PII and ids >= 7 chars. Symbols (public tickers
// that also appear in app code, e.g. NIFTYBEES) and short ids are checked against fixtures/findings only.
const apiKeyPrefix = (process.env.KITE_API_KEY ?? "").slice(0, 8);
const strict = [...secrets, ...(dcr ? [dcr] : []), ...[...real.keys()].filter((r) => !realSymbols.has(r) && r.length >= 7), ...[...real.entries()].filter(([r, f]) => Object.values(PII).includes(f) && r.length >= 3).map(([r]) => r)];
const loose = [...real.keys()].filter((r) => r.length >= 3);
// kite-tools-list.json is Zerodha's public schema (its examples name public tickers); LICENSE carries the
// owner's own copyright name by design.
const spikeDocs = (f: string) => (f.startsWith(MCP_FX) && !f.endsWith("kite-tools-list.json")) || f.startsWith(KITE_FX) || f.startsWith("docs/spikes/");
const allowPii = (f: string) => f === "LICENSE";
const repoFiles = execSync("git ls-files --cached --others --exclude-standard", { encoding: "utf8" }).split("\n").filter((f) => f && existsSync(f));
let hits = 0;
const hitFiles = new Set<string>();
for (const f of repoFiles) {
  const text = readFileSync(f, "utf8");
  const found = (spikeDocs(f) ? loose.concat(strict) : allowPii(f) ? secrets : strict).filter((n) => new RegExp(`(?<![A-Za-z0-9])${escape(n)}(?![A-Za-z0-9])`).test(text)).length + (apiKeyPrefix && text.includes(apiKeyPrefix) ? 1 : 0);
  if (found) {
    hits += found;
    hitFiles.add(f);
  }
}
// Real numbers (non-trivial) reappearing verbatim in fixtures.
const fxText = [...readdirSync(MCP_FX).map((f) => `${MCP_FX}/${f}`), ...readdirSync(KITE_FX).map((f) => `${KITE_FX}/${f}`)].map((f) => readFileSync(f, "utf8")).join("\n");
const numHits = [...realNums].filter((n) => String(n).replace(/[-.]/g, "").length >= 4 && new RegExp(`(?<![0-9.])${escape(String(n))}(?![0-9])`).test(fxText)).length;
console.log(JSON.stringify({ fixtures: scrubbed.length + 1, mappedValues: real.size, scannedFiles: repoFiles.length, needles: strict.length + loose.length + 1, leakHits: hits, leakFiles: [...hitFiles], realNumberReuseInFixtures: numHits }, null, 2));
if (hits) process.exitCode = 1;
