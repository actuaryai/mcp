# Actuary MCP

A pre-trade gate for AI agents on Robinhood Chain. Before your agent buys a token, it asks Actuary. Actuary applies **your policy** to on-chain and open-collector facts and answers **ALLOW**, **DENY** or **REVIEW**, with the rules that fired, the facts they read, and a **signed receipt**.

**Status: live, rule-based.** Answers come from the open rule engine (`engine: "rules-v1"`). The model is not answering yet; when it does, the receipt will say so. Not financial advice.

## Connect by URL (no install)

```
claude mcp add --transport http actuary https://actuaryai.pro/mcp
```

The hosted server has the agent tools (gate, gate_batch, gate_facts, get_receipt, verify_receipt, mandates). Run this local server instead when your agent should pay on its own: past the free Gate calls, and for every Mandate (see below).

## Install locally

```
git clone https://github.com/actuaryai/mcp.git
cd mcp && npm install
claude mcp add actuary -- node /absolute/path/to/mcp/server.mjs
```

Needs Node 20+. Set `ACTUARY_API` to use another server (default `https://actuaryai.pro`).

## Tools

| Tool | What it does |
|---|---|
| `gate` | Token + policy → ALLOW / DENY / REVIEW, every check with the fact it read, a plain-words explanation and a signed receipt |
| `gate_facts` | The facts a policy may use, the rule syntax and the presets |
| `verify_receipt` | Checks a receipt's signature and that nothing in it was changed |
| `gate_batch` | Up to 10 tokens against one policy, one receipt each |
| `create_mandate` | Keep checking a held token for 7 days ($0.05); poll events, or a webhook when the decision or the contract changes |
| `renew_mandate` | 7 more days on a mandate ($0.05) |
| `mandate_events` | Poll the events a mandate recorded |
| `mandate_status` | Current decision, last check, expiry, delivery failures |
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

Signed with EIP-712, domain `{ name: "Actuary", version: "1", chainId: 4663 }`, type `Receipt(string id, address token, string decision, bytes32 policyHash, bytes32 bodyHash, uint64 issuedAt)`. `bodyHash` covers every check, fact, reason and source, and the `explanation` when there is one. The signer address is published at `GET /api/v1/receipts/signer`.

The `explanation` puts the checks into two plain sentences. A model writes it (`explanation_model`, on Cloudflare Workers AI) from the checks and the published fact meanings only; answers that add numbers, talk about prices or advice are dropped, and the receipt is then issued without one. The explanation never changes the decision.

With `"judge": "advisory"` or `"resolve"` in a policy (or the preset `actuary-judged-v1`), a model reads a REVIEW and leans ALLOW, REVIEW or DENY with a confidence, the facts it relied on and one sentence. ALLOW and DENY from the rules are final. `advisory` only records the lean; `resolve` applies it at 75% confidence or more, and an ALLOW only when every deny rule read false. The receipt keeps `rule_decision`, the final `decision` and the signed `judgement`.

## Mandate webhooks

`POST` to your https URL with `X-Actuary-Event`, `X-Actuary-Timestamp` and `X-Actuary-Signature: sha256=<HMAC-SHA256(secret, "<timestamp>.<body>")>`. Events: `mandate.decision_changed`, `mandate.contract_changed` (owner, implementation, mint/pause/blacklist, supply moved 1%+), `mandate.expiring` (a day before the end), `mandate.expired`, `mandate.test`. Checks run about every 30 minutes. A mandate stops after 20 failed deliveries.

## Mandate pricing

A mandate costs **$0.05 for 7 days** in USDG on Robinhood Chain over x402: `POST /api/v1/mandates` answers 402 with the quote, the signed payment goes in `PAYMENT-SIGNATURE`, and the mandate is created before the payment settles, so nothing is charged if it can't be created. `POST /api/v1/mandates/{id}/renew` (with `Authorization: Bearer <secret>`) adds 7 days from the current end. With `ACTUARY_PAY_KEY_FILE` set, `create_mandate` and `renew_mandate` pay on their own.

## Paying per call (optional)

After the free daily Gate calls, a Gate call costs $0.002; a Mandate costs $0.05 for 7 days. The server answers 402 with an x402 quote in USDG on Robinhood Chain. To let this server pay on its own:

```
ACTUARY_PAY_KEY_FILE=/path/to/agent-wallet.key   # a file holding the paying wallet's private key; never paste it in chat
ACTUARY_MAX_USD=0.05                               # the most it will ever sign for one call (default 0.05)
```

Set `ACTUARY_MAX_USD=0.002` if the agent should pay for Gate calls but never for mandates.

Use a dedicated wallet with a small USDG balance. Without the key file, nothing is ever signed.
