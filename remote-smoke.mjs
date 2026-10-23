// Smoke test for the REMOTE MCP endpoint (Streamable HTTP), using the official MCP client.
// Usage: node remote-smoke.mjs [url]    default https://actuaryai.pro/mcp
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.argv[2] ?? "https://actuaryai.pro/mcp");
const client = new Client({ name: "remote-smoke", version: "0" });
await client.connect(new StreamableHTTPClientTransport(url));
console.log("server:", client.getServerVersion()?.name, client.getServerVersion()?.version);
const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content?.[0]?.text ?? "";
  console.log(`\n# ${name}${r.isError ? " (error)" : ""}\n${t.slice(0, 300)}`);
  return r.isError ? null : r.structuredContent ?? JSON.parse(t);
};
const g = await call("gate", { token: "0x92de9d3888953f3c6a55840f189c409976d9bba1" });
await call("gate", { token: "0x92de9d3888953f3c6a55840f189c409976d9bba1", policy: { policy: "typo", deny_if: ["first_hour_swap < 20"] } });
await call("gate_batch", { tokens: ["0x92de9d3888953f3c6a55840f189c409976d9bba1", "0x73d8da1a6d9d21afdf8618dc5aacdff4ee1f29ba"], policy: "no-clones-v1" });
if (g) await call("verify_receipt", { receipt: g.receipt_id });
const m = await call("create_mandate", { token: "0x92de9d3888953f3c6a55840f189c409976d9bba1" });
if (m) {
  await call("mandate_events", { id: m.id, secret: m.secret, since: 0 });
  await call("mandate_status", { id: m.id, secret: m.secret });
  await call("cancel_mandate", { id: m.id, secret: m.secret });
  await call("mandate_events", { id: m.id, secret: m.secret, since: 0 });
}
await client.close();
