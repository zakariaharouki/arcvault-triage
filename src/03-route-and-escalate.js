// STEP 4 (Routing) + STEP 5 (Structured output) + STEP 6 (Escalation flag)
// Deterministic rules only: no LLM decides where a ticket goes.
// Mode: Run Once for Each Item.

const CONFIG = {
  MODEL: 'llama-3.3-70b-versatile',
  PIPELINE_VERSION: '1.0.0',
  CONFIDENCE_THRESHOLD: 0.7,
  BILLING_ESCALATION_USD: 500,
  ESCALATION_QUEUE: 'Human Review',
  ROUTES: {
    'Bug Report': 'Engineering',
    'Incident/Outage': 'Engineering On-Call',
    'Feature Request': 'Product',
    'Billing Issue': 'Billing',
    'Technical Question': 'Technical Support',
  },
  // Phrases that always need a human, regardless of what the model said.
  ESCALATION_PATTERNS: [
    { label: 'outage', re: /\boutage\b/i },
    { label: 'down for all users', re: /\bdown for (all|every(one|body))\b/i },
    { label: 'multiple users affected', re: /\b(multiple|many|all) users\b/i },
    { label: 'data loss', re: /\bdata (loss|lost|deleted)\b/i },
    { label: 'security breach', re: /\b(breach|compromised|unauthori[sz]ed access)\b/i },
  ],
};

const prev = $('Validate Classification').item.json;
const c = prev.classification;
const notes = [...c.validation_errors];

// ---- parse + sanitise enrichment output ---------------------------------
let e = {};
try {
  e = JSON.parse($json.choices?.[0]?.message?.content ?? '');
} catch (err) {
  notes.push('enrichment returned invalid JSON');
}
const list = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const ids = e.identifiers ?? {};
const level = ['low', 'medium', 'high'].includes(e.urgency_signal?.level) ? e.urgency_signal.level : 'medium';

const enrichment = {
  core_issue: String(e.core_issue ?? ''),
  identifiers: {
    account_ids: list(ids.account_ids),
    invoice_numbers: list(ids.invoice_numbers),
    error_codes: list(ids.error_codes),
    urls: list(ids.urls),
    products_or_features: list(ids.products_or_features),
    other: list(ids.other),
  },
  amounts: {
    charged: num(e.amounts?.charged),
    expected: num(e.amounts?.expected),
    currency: e.amounts?.currency ?? null,
  },
  urgency_signal: { level, evidence: e.urgency_signal?.evidence ?? null },
  affected_scope: String(e.affected_scope ?? 'unknown'),
};

// ---- escalation rules (STEP 6) --------------------------------------------
const reasons = [];
if (!c.category) reasons.push('classification failed validation');
if (c.confidence < CONFIG.CONFIDENCE_THRESHOLD) {
  reasons.push(`confidence ${c.confidence} is below ${CONFIG.CONFIDENCE_THRESHOLD}`);
}
if (c.category === 'Incident/Outage') reasons.push('category is Incident/Outage');
for (const p of CONFIG.ESCALATION_PATTERNS) {
  if (p.re.test(prev.raw_message)) reasons.push(`message matches escalation phrase "${p.label}"`);
}
// Billing: the model extracts the numbers, code does the arithmetic.
let billingDiscrepancy = null;
const { charged, expected } = enrichment.amounts;
if (charged !== null && expected !== null) {
  billingDiscrepancy = Math.round((charged - expected) * 100) / 100;
  if (Math.abs(billingDiscrepancy) > CONFIG.BILLING_ESCALATION_USD) {
    reasons.push(`billing discrepancy $${Math.abs(billingDiscrepancy)} exceeds $${CONFIG.BILLING_ESCALATION_USD}`);
  }
}

// ---- routing (STEP 4) -----------------------------------------------------
const standardQueue = CONFIG.ROUTES[c.category] ?? null; // null => fallback
const escalate = reasons.length > 0 || !standardQueue;
const queue = escalate ? CONFIG.ESCALATION_QUEUE : standardQueue;

// Outages are always High, whatever the model said.
let priority = c.priority;
if (c.category === 'Incident/Outage' && priority !== 'High') {
  priority = 'High';
  notes.push('priority raised to High for Incident/Outage');
}

// ---- final record (STEP 5) ------------------------------------------------
return {
  json: {
    request_id: prev.request_id,
    source: prev.source,
    received_at: prev.received_at,
    raw_message: prev.raw_message,
    category: c.category,
    priority,
    confidence: c.confidence,
    classification_rationale: c.rationale,
    secondary_category: c.secondary_category,
    core_issue: enrichment.core_issue,
    identifiers: enrichment.identifiers,
    amounts: { ...enrichment.amounts, discrepancy: billingDiscrepancy },
    urgency_signal: enrichment.urgency_signal,
    affected_scope: enrichment.affected_scope,
    routing: {
      destination_queue: queue,
      standard_queue: standardQueue,
      reason: escalate
        ? `Escalated for human review; would otherwise go to ${standardQueue ?? 'no queue (unclassified)'}.`
        : `${c.category} -> ${standardQueue}`,
    },
    escalation: { flagged: escalate, reasons },
    summary: String(e.summary ?? ''),
    processing_notes: notes,
    meta: {
      model: CONFIG.MODEL,
      pipeline_version: CONFIG.PIPELINE_VERSION,
      processed_at: new Date().toISOString(),
    },
  },
};
