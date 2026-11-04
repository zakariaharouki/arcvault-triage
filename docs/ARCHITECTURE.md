# ArcVault Intake & Triage: Architecture Write-Up

## 1. System design

```
Email / Web form / Portal adapter
        │  POST {id, source, message}
        ▼
[n8n Webhook] → [Prepare Classification] → [LLM: Classify] → [Validate Classification]
   → [LLM: Enrich & Summarize] → [Route & Escalate] → [Needs Human Review?]
        ├── yes → Deliver: Escalation Queue (Human Review)
        └── no  → Deliver: Team Queue (Engineering / Product / Billing / Technical Support)
                                   ▼
                         [Return Record] → JSON response (saved to output/records.json)
```

- **Trigger.** A webhook starts one workflow run per message. Each channel (an email parser, a web form, a support-portal hook) only has to POST `{id, source, message}`. That keeps ingestion separate from triage, and adding a channel doesn't touch the pipeline. In the demo, `scripts/send-samples.mjs` acts as those three channels.
- **Two LLM calls, each with one job.** Classification is a narrow decision and enrichment is an extraction task. Splitting them keeps each prompt short and lets each be tested and tuned on its own. Enrichment also receives the category, so its summary is written for the right team.
- **Code decides, the LLM proposes.** Validation, routing, escalation and the billing arithmetic all run in plain JavaScript Code nodes. The model's output is treated as untrusted input: categories are checked against an allow-list, confidence is clamped to 0–1 (and converted if the model answers in percent), and invalid JSON gives `category: null`, which escalates.
- **State.** The workflow keeps no state between runs. Each run carries its context forward through the items, and the final record is (a) posted to the destination queue endpoint, a webhook.site mock of a ticketing system, (b) returned to the caller and written to `output/records.json`, and (c) kept in n8n's execution history for auditing.
- **Model.** Groq `llama-3.3-70b-versatile` at temperature 0 with JSON mode. It's free with no credit card, fast (about 1 s per call), and a 70B model is reliable at following a fixed JSON schema. The free tier's rate limit (about 30 requests/minute) is far above what this needs.

## 2. Routing logic

| Category | Standard queue | Why |
|---|---|---|
| Bug Report | Engineering | Needs a code fix or investigation |
| Incident/Outage | Engineering On-Call | Live service problem, not a backlog item |
| Feature Request | Product | Product owns prioritisation of new capability |
| Billing Issue | Billing | Needs access to invoices and contracts |
| Technical Question | Technical Support | How-to and configuration; nothing is broken |
| (unknown / invalid) | **Human Review** (fallback) | Never drop a ticket just because the model failed |

The mapping is one lookup table (`CONFIG.ROUTES`) inside the *Route & Escalate* node, so ops can change it without touching any prompt. Every record keeps both `destination_queue`, where it actually went, and `standard_queue`, where it would have gone. That means a reviewer can forward an escalated ticket in one click.

## 3. Escalation logic

A record goes to **Human Review** instead of its standard queue if **any** of these is true. Every rule that fires is listed in `escalation.reasons`.

1. **Confidence < 0.70** (the threshold in the brief). The classifier prompt gives the model a rubric for confidence bands, so the number means something rather than defaulting to 0.95.
2. **Category is Incident/Outage.** Outages affect many customers, and a person should confirm them and start incident comms. Priority is also forced to High.
3. **Escalation phrases** checked with regex on the raw message: "outage", "down for all users/everyone", "multiple/many/all users", data loss, security breach. These are a deterministic safety net: they catch a critical message even when the model misclassifies it.
4. **Billing discrepancy > $500.** The LLM only extracts the `charged` and `expected` amounts. Code does the subtraction, because LLMs are unreliable at arithmetic. Sample #3 ($1,240 − $980 = $260) correctly stays in Billing.
5. **Invalid classification**, meaning the fallback described above.

Expected result for the samples: #5 is escalated (category + "Multiple users"). #1–#4 go to their team queues, unless the model's confidence on the ambiguous #4 ("not sure if this is the right place") falls under 0.70.

## 4. At production scale

- **Reliability.** Use queue-mode n8n with Redis workers. Put an idempotency key (`request_id`) on delivery so retries never create duplicate tickets. Send failed runs to a dead-letter queue. LLM nodes already retry 3× with backoff, and the delivery step continues on error so a record is never lost.
- **Confidence.** Self-reported confidence isn't well calibrated. In production I'd calibrate it against a labelled set of real tickets, or use agreement between two cheap samples or token log-probabilities, and tune the 0.70 threshold to a target precision per queue.
- **Cost.** Merge the two LLM calls into one for short messages, send obvious cases to a small model (`llama-3.1-8b`) and use the 70B model only when confidence is low, and cache the system prompts. Cost per ticket is already a fraction of a cent.
- **Latency.** It's about 2–3 s end to end today, which is fine for asynchronous intake. Respond to the channel right away (202 Accepted) and process in the background so customers never wait on the LLM.
- **Security and privacy.** Redact PII (emails, phone numbers, card numbers) before the LLM call, keep secrets in n8n credentials, sign webhook requests, and log prompts and outputs for auditing with a retention policy.
- **Quality.** Track the human-review override rate per category. Every correction becomes a labelled example for regression tests and prompt updates.

## 5. Phase 2 (one more week)

1. **Real connectors:** a Gmail/IMAP trigger, Jira/Zendesk ticket creation per queue, Slack alerts for escalations.
2. **Customer context:** look up the account (plan, SLA tier, open incidents) and use it in priority. An enterprise customer reporting a 403 matters more than a trial user. Group duplicate outage reports into one incident.
3. **Human-in-the-loop UI:** a review queue where agents accept or correct the classification, with corrections logged as training data.
4. **Evaluation harness:** about 100 labelled synthetic and real tickets, run in CI on every prompt change, reporting accuracy, a confusion matrix and escalation precision and recall.
5. **Auto-acknowledgement:** a drafted first reply to the customer with the ticket number and expected response time.
