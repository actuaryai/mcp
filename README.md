# Actuary MCP

A pre-trade gate for AI agents on Robinhood Chain. Before your agent buys a token, it asks Actuary. Actuary applies **your policy** to on-chain and open-collector facts and answers **ALLOW**, **DENY** or **REVIEW**, with the rules that fired, the facts they read, and a **signed receipt**.

**Status: live, rule-based.** Answers come from the open rule engine (`engine: "rules-v1"`). The model is not answering yet; when it does, the receipt will say so. Not financial advice.

## Install

```
git clone https://github.com/actuaryai/mcp.git
cd mcp && npm install
claude mcp add actuary -- node /absolute/path/to/mcp/server.mjs
```

Needs Node 20+. Set `ACTUARY_API` to use another server (default `https://actuaryai.pro`).

## Tools

| Tool | What it does |
|---|---|
| `gate` | Token + policy → ALLOW / DENY / REVIEW, every check with the fact it read, and a signed receipt |
| `gate_facts` | The facts a policy may use, the rule syntax and the presets |
| `verify_receipt` | Checks a receipt's signature and that nothing in it was changed |
| `create_mandate` | Keep checking a held token; webhook when the decision or the contract changes |
| `mandate_status` | Current decision, last check, delivery failures |
| `cancel_mandate` | Stop a mandate |
| `check_token`, `premortem`, `autopsy_token` | The original verdict, launch pre-mortem and autopsy tools |

## A policy

```json
{
  "policy": "my-agent-v1",
  "deny_if": ["mint_with_live_owner", "ticker_clone_of_older", "first_hour_swaps < 20"],
  "review_if": ["is_proxy", "liquidity_not_reported"],
  "unknown": "review"
}
```

Rules: `fact`, `!fact`, or `fact < number` (`<`, `<=`, `>`, `>=`, `==`, `!=`). A rule whose fact is missing is *unknown*; by default an unknown deny rule gives REVIEW, so missing data never lets a token through. Presets: `actuary-default-v1`, `no-clones-v1`.

## Receipts

Signed with EIP-712, domain `{ name: "Actuary", version: "1", chainId: 4663 }`, type `Receipt(string id, address token, string decision, bytes32 policyHash, bytes32 bodyHash, uint64 issuedAt)`. `bodyHash` covers every check, fact, reason and source. The signer address is published at `GET /api/v1/receipts/signer`.

## Mandate webhooks

`POST` to your https URL with `X-Actuary-Event`, `X-Actuary-Timestamp` and `X-Actuary-Signature: sha256=<HMAC-SHA256(secret, "<timestamp>.<body>")>`. Events: `mandate.decision_changed`, `mandate.contract_changed` (owner, implementation, mint/pause/blacklist, supply moved 1%+), `mandate.test`. Checks run about every 30 minutes. A mandate stops after 20 failed deliveries.

## Paying per call (optional)

After the free daily Gate calls, the server answers 402 with an x402 quote ($0.002 in USDG on Robinhood Chain). To let the `gate` tool pay on its own:

```
ACTUARY_PAY_KEY_FILE=/path/to/agent-wallet.key   # a file holding the paying wallet's private key; never paste it in chat
ACTUARY_MAX_USD=0.01                               # the most it will ever sign for one call (default 0.01)
```

Use a dedicated wallet with a small USDG balance. Without the key file, nothing is ever signed.
