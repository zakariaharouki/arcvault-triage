# Prompt Documentation

Both prompts run on Groq `llama-3.3-70b-versatile`, temperature 0, with `response_format: json_object`. The full text is in [`prompts/`](../prompts) and is built into the n8n Code nodes by `scripts/build-workflow.py`, so the prompt files are the single source of truth.

---

## Prompt 1: Classification

**File:** [`prompts/01-classify.system.txt`](../prompts/01-classify.system.txt)
**User message:** `Source channel: <source>\nMessage:\n"""<message>"""`
**Output:** `{rationale, category, secondary_category, priority, confidence}`

**Why it's structured this way.** Every category has a one-line definition with typical trigger phrases, because labels alone are ambiguous ("Bug" vs "Incident" is the main source of misrouting). I added explicit **tie-breaking rules** for the three known overlaps (bug vs outage, question vs feature, bug vs billing) instead of hoping the model infers them. **Confidence comes with a rubric**, because without one models report 0.9+ for almost everything and the 70% escalation rule would never fire. The rubric also tells the model to lower confidence whenever it needed a tie-breaker. **`rationale` is the first key**, so the model writes a short justification before committing to a label (cheap chain-of-thought inside JSON mode). That also gives reviewers an explanation. `secondary_category` makes ambiguity visible. The two **few-shot examples deliberately don't use the five test messages**, to avoid overfitting to the evaluation set.
**Tradeoffs:** priority is decided by the model with a rubric rather than computed. The prompt is about 600 tokens, which costs a little latency in exchange for consistency.
**With more time:** calibrate confidence against labelled data (or use log-probabilities) instead of trusting self-reported numbers; add more examples taken from real misroutes; and use JSON-schema strict mode where the provider supports it.

---

## Prompt 2: Enrichment & summary

**File:** [`prompts/02-enrich.system.txt`](../prompts/02-enrich.system.txt)
**User message:** `Category: <category>\nSource channel: <source>\nMessage:\n"""<message>"""`
**Output:** `{core_issue, identifiers{account_ids, invoice_numbers, error_codes, urls, products_or_features, other}, amounts{charged, expected, currency}, urgency_signal{level, evidence}, affected_scope, summary}`

**Why it's structured this way.** It uses a **fixed schema with every list always present** (empty rather than missing), so downstream code and receiving teams never handle missing keys. Identifiers must be **copied exactly, never invented**, because a made-up invoice number is worse than none. **Amounts are extracted as numbers but the model is told not to subtract them.** The $500 billing rule is applied in code, since LLM arithmetic isn't reliable enough for money. `urgency_signal.evidence` must quote the message, which makes the urgency judgment checkable instead of a guess. The **category is passed in**, so the summary is written for the team that will receive it, and the summary is told not to promise anything to the customer.
**Tradeoffs:** a second LLM call adds about 1 s and doubles token use compared with one combined prompt. I accepted that for clearer, separately testable prompts, which matter more at this volume.
**With more time:** validate identifiers with regex (for example an invoice must match `#?\d+`); add PII redaction before this call; and evaluate summary quality with an LLM-as-judge rubric (actionable? accurate? no hallucinated facts?).

---

## Non-LLM safeguards (why some logic is *not* in a prompt)

| Concern | Handled in code because… |
|---|---|
| Category / priority values | Allow-list validation; invalid → Human Review |
| Confidence format | Clamped 0–1; "85" is read as 0.85 |
| Billing difference > $500 | Arithmetic on extracted numbers |
| Critical phrases ("outage", "multiple users") | Regex safety net independent of model mood |
| Queue mapping | Lookup table; can change without touching prompts |
