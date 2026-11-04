# ArcVault Triage

This is my submission for the Valsoft AI Engineer assessment.

ArcVault is a made-up B2B software company. Customer messages come in by email, web form and the support portal, all mixed together: bugs, feature ideas, billing complaints, questions and sometimes a real outage. Right now a person sorts them by hand and some end up with the wrong team. This workflow does the sorting automatically and sends anything risky to a person.

## What it does

For each incoming message, the workflow:

1. **Receives it** on an n8n webhook.
2. **Classifies it** with an LLM: category, priority and a confidence score.
3. **Enriches it** with a second LLM call: the core issue in one sentence, any IDs, amounts and dates in the message, how urgent it sounds, and a short summary for the team that receives it.
4. **Routes it** to a queue: Engineering, Engineering On-Call, Product, Billing or Technical Support.
5. **Escalates it** to a separate **Human Review** queue if confidence is below 70%, it's an outage, it mentions things like "multiple users" or "outage", or a billing difference is over $500.
6. **Saves the result** as a clean JSON record.

```
Webhook → Classify (LLM) → Validate → Enrich + summary (LLM) → Route & Escalate (code) → Human Review? → Deliver → JSON
```

One decision I want to point out: **the LLM never decides where a ticket goes.** It reads the message and extracts information; plain code makes the routing and escalation decisions. That makes them predictable, testable, and easy to change without touching a prompt. The same applies to the $500 billing rule: the model pulls out the amounts and the code does the subtraction.

## Results on the 5 sample messages

| # | Message | Category | Goes to |
|---|---|---|---|
| 1 | 403 error on login | Bug Report, High | Engineering |
| 2 | Bulk export for audit logs | Feature Request, Low | Product |
| 3 | Invoice #8821, $1,240 vs $980 | Billing Issue, Medium | Billing (a $260 difference, under the $500 rule) |
| 4 | SSO with Okta? | Technical Question, Low | Technical Support |
| 5 | Dashboard down, multiple users | Incident/Outage, High | **Human Review** (escalated) |

The full records are in [`output/records.json`](output/records.json).

## What's in the repo

- [`workflow/arcvault-triage.n8n.json`](workflow/arcvault-triage.n8n.json): the n8n workflow, ready to import
- [`prompts/`](prompts): the two prompts as plain text
- [`docs/PROMPTS.md`](docs/PROMPTS.md): why each prompt is written the way it is
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): design, routing, escalation, scaling and Phase 2
- [`output/records.json`](output/records.json): output for the 5 samples
- [`docs/screenshots/`](docs/screenshots): screenshots of each step
- `test/`: offline tests for the routing and escalation rules (no API key needed)

## Running it

Everything here is free.

1. Start n8n: `npx n8n` and open http://localhost:5678
2. Import `workflow/arcvault-triage.n8n.json`
3. Get a free API key from [console.groq.com](https://console.groq.com). In n8n, create a **Header Auth** credential with Name `Authorization` and Value `Bearer <your key>`, and select it on both LLM nodes.
4. Optional: paste a [webhook.site](https://webhook.site) URL into the two *Deliver* nodes to watch records arrive in their queues.
5. Activate the workflow and run:
   ```bash
   node scripts/send-samples.mjs
   ```

To run the logic tests: `node test/logic.test.mjs`

**Model:** Groq `openai/gpt-oss-120b` at temperature 0 in JSON mode. It's free, fast and follows a fixed JSON format reliably.

## How I used AI

I built this with Claude as a pair programmer, as the brief encouraged. Claude drafted the workflow, the prompts and the first version of the docs. I set up and ran everything, checked every output record, and made the decisions about what to keep and what to change.

Two things the AI got wrong that I had to fix:

- **It picked a retired model.** The first version used `llama-3.3-70b-versatile`, which Groq shut down for free accounts in August 2026. My first real run failed with `model_not_found`. I switched to Groq's recommended replacement, `openai/gpt-oss-120b`.
- **Identifier extraction was inconsistent.** On the first run the model put the account `arcvault.io/user/jsmith` under `urls` instead of `account_ids`, missed product features on two messages (SSO/Okta, bulk export/audit logs), and dropped the "2pm EST" time from the outage report. I added rules for each field to the enrichment prompt and ran it again; all five records came out consistent.

## What I'd do next

With more time I'd add real connectors (Gmail in, Jira or Zendesk out), look up the customer's account and SLA before setting priority, calibrate the confidence score on real labelled tickets, and build a small review screen where people can correct the AI. Every correction would become test data. There's more on this in the [architecture doc](docs/ARCHITECTURE.md).

— Zakaria Harouki
