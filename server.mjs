#!/usr/bin/env node
// Actuary MCP server (stdio). A pre-trade gate for AI agents on Robinhood Chain.
// Tools: gate, gate_facts, verify_receipt, create_mandate, mandate_status, cancel_mandate,
// plus check_token, premortem and autopsy_token from the original engine.
//
// Market and holder data are read from THIS machine (Blockscout and GeckoTerminal block cloud servers),
// then sent with the address to the Actuary API, which reads the contract and applies the open rule engine.
// Answers are rule-based today. Each reply says which engine produced it. Not financial advice.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import { privateKeyToAccount } from "viem/accounts";

const API = (process.env.ACTUARY_API ?? "https://actuaryai.pro").replace(/\/$/, "");
const BS = "https://robinhoodchain.blockscout.com/api/v2";
const GT = "https://api.geckoterminal.com/api/v2/networks/robinhood";
const SHARDS = "https://raw.githubusercontent.com/actuaryai/data/main/data/shards";
const DEAD = new Set(["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead"]);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UA = { "user-agent": "actuary-mcp/0.1", accept: "application/json" };

// Optional x402 pay-per-call. After the free daily Gate calls, the server answers 402 with a quote in USDG on
// Robinhood Chain. If ACTUARY_PAY_KEY_FILE points to a file holding a wallet's private key, the gate tool signs that
// quote (EIP-3009) and resends, never above ACTUARY_MAX_USD per call (default 0.01). No file, no payments.
const MAX_USD = Number(process.env.ACTUARY_MAX_USD ?? 0.01);
let payer = null;
if (process.env.ACTUARY_PAY_KEY_FILE) {
  try {
    payer = privateKeyToAccount(fs.readFileSync(process.env.ACTUARY_PAY_KEY_FILE, "utf8").trim());
  } catch {
    console.error("actuary-mcp: could not read ACTUARY_PAY_KEY_FILE; paid calls are off");
  }
}
const b64 = (s) => Buffer.from(s).toString("base64");

async function signQuote(quote) {
  const req = (quote.accepts ?? []).find((r) => r.network === "eip155:4663");
  if (!req) throw new Error("The server did not offer Robinhood Chain for this call.");
  const usd = Number(req.amount) / 1e6;
  if (usd > MAX_USD) throw new Error(`Quoted $${usd} is above ACTUARY_MAX_USD ($${MAX_USD}).`);
  const nonce = "0x" + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + Math.min(req.maxTimeoutSeconds || 120, 300));
  const authorization = { from: payer.address, to: req.payTo, value: req.amount, validAfter: "0", validBefore: validBefore.toString(), nonce };
  const signature = await payer.signTypedData({
    domain: { name: req.extra.name, version: req.extra.version, chainId: 4663, verifyingContract: req.asset },
    types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
    primaryType: "TransferWithAuthorization",
    message: { from: payer.address, to: req.payTo, value: BigInt(req.amount), validAfter: 0n, validBefore, nonce },
  });
  return b64(JSON.stringify({ x402Version: 2, resource: quote.resource, accepted: req, payload: { signature, authorization } }));
}

async function getJSON(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function api(method, path, body, bearer) {
  const headers = { ...UA };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const send = () => fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000) });
  let r = await send();
  if (r.status === 402) {
    const quote = await r.json().catch(() => ({}));
    if (!quote.accepts?.length) throw new Error(`Actuary API 402: ${quote.code ?? quote.error ?? "payment failed"}${quote.detail ? ` (${quote.detail})` : ""}`);
    if (!payer) throw new Error(`The free Gate calls for today are used up. Paid calls cost $${Number(quote.accepts[0].amount) / 1e6} in USDG on Robinhood Chain over x402: set ACTUARY_PAY_KEY_FILE to enable them.`);
    headers["PAYMENT-SIGNATURE"] = await signQuote(quote);
    r = await send();
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Actuary API ${r.status}: ${data.error ?? "error"}${data.detail ? ` (${data.detail})` : ""}${data.hint ? ` (${data.hint})` : ""}`);
  return data;
}
const postJSON = (path, body) => api("POST", path, body);

/** Market and holder facts, read locally. Returns what could be read and which parts could not. */
export async function readExt(address) {
  const [tok, hold, pools] = await Promise.allSettled([
    getJSON(`${BS}/tokens/${address}`),
    getJSON(`${BS}/tokens/${address}/holders`),
    getJSON(`${GT}/tokens/${address}/pools`),
  ]);
  const ext = {};
  const gaps = [];
  if (pools.status === "fulfilled") {
    const list = pools.value.data ?? [];
    ext.market = { poolCount: list.length };
    if (list.length) {
      const top = list.reduce((a, b) => (Number(b.attributes.reserve_in_usd) > Number(a.attributes.reserve_in_usd) ? b : a)).attributes;
      const tx = top.transactions?.h24 ?? {};
      Object.assign(ext.market, {
        topPoolName: top.name,
        poolCreated: top.pool_created_at,
        liqUsd: Number(top.reserve_in_usd),
        vol24Usd: Number(top.volume_usd?.h24),
        fdvUsd: top.fdv_usd ? Number(top.fdv_usd) : null,
        buys24: tx.buys ?? null,
        sells24: tx.sells ?? null,
      });
    }
  } else gaps.push("market");
  if (tok.status === "fulfilled" && hold.status === "fulfilled" && tok.value.total_supply) {
    const supply = BigInt(tok.value.total_supply);
    const items = (hold.value.items ?? []).filter((h) => !DEAD.has(String(h.address?.hash).toLowerCase()));
    const pct = (v) => (supply > 0n ? Number((BigInt(v) * 10000n) / supply) / 100 : null);
    const top10 = items.slice(0, 10).reduce((s, h) => s + BigInt(h.value), 0n);
    ext.holders = {
      count: Number(tok.value.holders_count ?? tok.value.holders ?? NaN),
      top1Pct: items[0] ? pct(items[0].value) : null,
      top10Pct: pct(top10),
      top1IsContract: items[0] ? Boolean(items[0].address?.is_contract) : null,
      top1Address: items[0]?.address?.hash ?? null,
    };
  } else gaps.push("holders");
  return { ext, gaps };
}

const text = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ isError: true, content: [{ type: "text", text: msg }] });

function summarize(d, gaps = []) {
  const v = d.verdict ?? {};
  return {
    engine: d.engine ?? "rules",
    model: d.model ?? null,
    address: d.address,
    risk_class: v.risk_class,
    status: v.status,
    cause_pattern: v.cause_pattern,
    flags: (v.flags ?? []).map((f) => ({ code: f.code, text: f.text, evidence: f.evidence_ids })),
    fixes: v.fixes,
    confidence: v.confidence,
    narrative: d.narrative,
    notes: [...(d.notes ?? []), ...(gaps.length ? [`Could not read ${gaps.join(" and ")} data from this machine, so those checks were skipped.`] : [])],
    disclaimer: v.disclaimer,
  };
}

const server = new McpServer({ name: "actuary", version: "0.1.0" });

// ---------- Gate ----------
const policySchema = z
  .union([
    z.string().describe('A preset name: "actuary-default-v1" or "no-clones-v1"'),
    z.object({
      policy: z.string().describe("A short name for your policy, e.g. my-agent-v1"),
      deny_if: z.array(z.string()).default([]).describe('Rules that block the trade, e.g. "mint_with_live_owner", "first_hour_swaps < 20", "!in_collector"'),
      review_if: z.array(z.string()).default([]).describe("Rules that ask for a closer look instead of blocking"),
      unknown: z.enum(["review", "deny", "allow"]).optional().describe("What a deny rule with missing data means. Default review."),
    }),
  ])
  .optional()
  .describe("Your policy, or a preset name. Call gate_facts for the facts a rule may use. Default: actuary-default-v1");

server.registerTool(
  "gate",
  {
    title: "Gate a token against a policy",
    description:
      "Call BEFORE buying a token on Robinhood Chain. Applies your policy to on-chain and open-collector facts and returns ALLOW, DENY or REVIEW, the rules that fired with the facts they read, and a signed receipt you can keep as proof of why you traded or did not. Rule-based; missing data never results in ALLOW unless your policy says so. Not financial advice.",
    inputSchema: { token: z.string().describe("Token contract address (0x...)"), policy: policySchema },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async ({ token, policy }) => {
    if (!ADDRESS.test(String(token).trim())) return fail("That is not a valid 0x address (40 hex characters).");
    try {
      const d = await api("POST", "/api/v1/gate", { token: token.trim(), policy: policy ?? "actuary-default-v1" });
      const r = d.receipt;
      return text({
        decision: d.decision,
        reasons: d.reasons,
        checks: r.checks.map((c) => ({ rule: `${c.list}: ${c.rule}`, result: c.result, read: c.facts })),
        receipt_id: r.id,
        receipt_url: `${API}${d.receipt_url}`,
        signed_by: r.signer,
        engine: r.engine,
        payment: d.payment ?? null,
        receipt: r,
      });
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  },
);

server.registerTool(
  "gate_facts",
  {
    title: "List the facts a policy can use",
    description: "Returns every fact the Gate can read (name, type, meaning), the rule syntax and the built-in presets. Use it to write a policy.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    try {
      const [facts, presets] = await Promise.all([api("GET", "/api/v1/gate/facts"), api("GET", "/api/v1/gate/presets")]);
      return text({ ...facts, presets: presets.presets });
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  },
);

server.registerTool(
  "verify_receipt",
  {
    title: "Verify a decision receipt",
    description: "Checks that a receipt was signed by Actuary and that nothing in it was changed. Pass the full receipt object, or a receipt id to fetch and check it.",
    inputSchema: { receipt: z.union([z.string(), z.record(z.any())]).describe("A receipt object, or its id (rcpt_...)") },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ receipt }) => {
    try {
      const r = typeof receipt === "string" ? await api("GET", `/api/v1/receipts/${receipt.trim()}`) : receipt;
      return text({ receipt_id: r.id, decision: r.decision, ...(await api("POST", "/api/v1/receipts/verify", { receipt: r })) });
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  },
);

// ---------- Mandates ----------
server.registerTool(
  "create_mandate",
  {
    title: "Keep checking a held token",
    description:
      'For a token you already hold: Actuary re-checks it against your policy about every 30 minutes and POSTs to your https webhook when the decision changes or the contract changes (owner, implementation, mint/pause/blacklist, supply). Returns a mandate id and a secret. Store the secret: it verifies webhook signatures (X-Actuary-Signature = sha256 HMAC of "<timestamp>.<body>") and is needed to read or cancel the mandate. It is not shown again.',
    inputSchema: { token: z.string(), webhook_url: z.string().url().optional().describe("Optional public https URL. Leave out and poll mandate_events instead."), policy: policySchema },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async ({ token, webhook_url, policy }) => {
    if (!ADDRESS.test(String(token).trim())) return fail("That is not a valid 0x address (40 hex characters).");
    try {
      return text(await api("POST", "/api/v1/mandates", { token: token.trim(), ...(webhook_url ? { webhook_url } : {}), policy: policy ?? "actuary-default-v1" }));
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  },
);

server.registerTool(
  "mandate_events",
  {
    title: "Poll a mandate",
    description: "Events a mandate recorded since a unix time (0 = all): decision changes, contract changes, created, cancelled. Use next_since for the next poll.",
    inputSchema: { id: z.string(), secret: z.string(), since: z.number().optional() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ id, secret, since }) => {
    try {
      return text(await api("GET", `/api/v1/mandates/${id.trim()}/events?since=${Math.max(0, Math.floor(since ?? 0))}`, undefined, secret.trim()));
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  },
);

server.registerTool(
  "gate_batch",
  {
    title: "Gate several tokens",
    description: "Gate up to 10 tokens against one policy in one call, one receipt each. Counts as one Gate call per token; past the free tier it pays one x402 payment for the total (when a pay key is set).",
    inputSchema: { tokens: z.array(z.string()).min(1).max(10), policy: policySchema },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async ({ tokens, policy }) => {
    try {
      const d = await api("POST", "/api/v1/gate/batch", { tokens, policy: policy ?? "actuary-default-v1" });
      return text({ count: d.count, results: d.results.map(({ receipt, ...r }) => r), payment: d.payment ?? null });
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  },
);

server.registerTool(
  "mandate_status",
  {
    title: "Read a mandate",
    description: "Current decision, last check, last event and delivery failures of a mandate.",
    inputSchema: { id: z.string().describe("mnd_..."), secret: z.string().describe("The secret returned by create_mandate") },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ id, secret }) => {
    try {
      return text(await api("GET", `/api/v1/mandates/${id.trim()}`, undefined, secret.trim()));
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  },
);

server.registerTool(
  "cancel_mandate",
  {
    title: "Stop a mandate",
    description: "Stops the checks and webhooks for a mandate, e.g. after you sold the token.",
    inputSchema: { id: z.string(), secret: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async ({ id, secret }) => {
    try {
      return text(await api("DELETE", `/api/v1/mandates/${id.trim()}`, undefined, secret.trim()));
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  },
);


server.registerTool(
  "check_token",
  {
    title: "Check a token (verdict)",
    description:
      "Risk verdict for a deployed token on Robinhood Chain: reads the contract, market and holders, and returns a risk class with each flag tied to its evidence. Rule-based today; never a price call or an accusation. Use before trading or listing a token.",
    inputSchema: { address: z.string().describe("Token contract address (0x...)") },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ address }) => {
    if (!ADDRESS.test(address.trim())) return fail("That is not a valid 0x address (40 hex characters).");
    const a = address.trim().toLowerCase();
    try {
      const { ext, gaps } = await readExt(a);
      const d = await postJSON("/api/v1/verdict", { address: a, ext });
      return text(summarize(d, gaps));
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  },
);

server.registerTool(
  "premortem",
  {
    title: "Pre-mortem of a launch draft",
    description:
      "Before launching a token: describe the draft and get the risks the market will see, the death patterns it invites, and concrete fixes. Rule-based today. Provide as many fields as you know.",
    inputSchema: {
      name: z.string().optional(),
      symbol: z.string().optional(),
      description: z.string().optional().describe("What it is and who runs it, in a sentence or two"),
      buyTaxPct: z.number().optional(),
      sellTaxPct: z.number().optional(),
      teamAllocationPct: z.number().optional(),
      allocationSplit: z.enum(["one_wallet", "several_wallets", "vesting"]).optional(),
      liquidityUsd: z.number().optional(),
      liquidityLock: z.enum(["none", "short", "long"]).optional().describe("none, short (<6 months), long (6+ months, burned or launchpad-locked)"),
      taxChangeable: z.boolean().optional(),
      hasMint: z.boolean().optional(),
      ownerRenounce: z.boolean().optional(),
      hasBlacklist: z.boolean().optional(),
      hasPause: z.boolean().optional(),
      source: z.string().max(24000).optional().describe("Solidity source of the token contract"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (draft) => {
    try {
      return text(summarize(await postJSON("/api/v1/premortem", draft)));
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  },
);

server.registerTool(
  "autopsy_token",
  {
    title: "Autopsy of a watched token",
    description:
      "What happened to a token the open collector watched for at least 24 hours: still trading, or dead and the pattern (liquidity pulled, bled out, never lived, clone). Only tokens recorded since 14 Oct 2026 can be examined. Patterns consistent with the numbers, never accusations.",
    inputSchema: { address: z.string().describe("Token contract address (0x...)") },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ address }) => {
    if (!ADDRESS.test(address.trim())) return fail("That is not a valid 0x address (40 hex characters).");
    const a = address.trim().toLowerCase();
    try {
      const shard = await getJSON(`${SHARDS}/${a.slice(2, 4)}.json`);
      const recs = (shard[a] ?? []).filter((r) => r.first && r.outcome);
      if (!recs.length) return fail("No autopsy record for this address. The collector has not watched it for 24 hours yet, or it was never recorded.");
      const rec = recs.sort((x, y) => String(y.created).localeCompare(String(x.created)))[0];
      const record = { symbol: rec.symbol, created: rec.created, first: rec.first, outcome: rec.outcome };
      return text(summarize(await postJSON("/api/v1/autopsy", { address: a, record })));
    } catch (e) {
      return fail(String(e.message ?? e));
    }
  },
);

if (process.argv.includes("--check")) {
  console.log(JSON.stringify({ ok: true, api: API }));
} else {
  await server.connect(new StdioServerTransport());
}
