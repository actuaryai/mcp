// Smoke test: start the server over stdio, list the tools, call the agent tools.
// Usage: ACTUARY_API=http://127.0.0.1:5179 node smoke.mjs [token] [webhook_url]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const token = process.argv[2] ?? "0x73d8da1a6d9d21afdf8618dc5aacdff4ee1f29ba";
const hook = process.argv[3];
const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["server.mjs"], env: { ...process.env } }));
const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content[0].text ?? "";
  console.log(`\n# ${name}${r.isError ? " (error)" : ""}\n${t.slice(0, 420)}`);
  return r.isError ? null : JSON.parse(t);
};
await call("gate_facts", {});
const g = await call("gate", { token });
await call("gate", { token, policy: { policy: "strict-v1", deny_if: ["ticker_clone_of_older", "first_hour_swaps < 20"] } });
await call("gate", { token, policy: { policy: "typo", deny_if: ["first_hour_swap < 20"] } });
if (g) await call("verify_receipt", { receipt: g.receipt_id });
if (hook) {
  const m = await call("create_mandate", { token, webhook_url: hook });
  if (m) {
    await call("mandate_status", { id: m.id, secret: m.secret });
    await call("cancel_mandate", { id: m.id, secret: m.secret });
  }
}
await client.close();
