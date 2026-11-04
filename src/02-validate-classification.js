// Validates the classifier output (never trust raw LLM JSON) and builds the
// request for STEP 3 (Enrichment).
// Mode: Run Once for Each Item.

const MODEL = 'llama-3.3-70b-versatile';
const CATEGORIES = ['Bug Report', 'Feature Request', 'Billing Issue', 'Technical Question', 'Incident/Outage'];
const PRIORITIES = ['Low', 'Medium', 'High'];

const ENRICH_PROMPT = `{{ENRICH_PROMPT}}`;

const req = $('Prepare Classification').item.json;
const errors = [];

let parsed = {};
try {
  parsed = JSON.parse($json.choices?.[0]?.message?.content ?? '');
} catch (e) {
  errors.push('classifier returned invalid JSON');
}

const category = CATEGORIES.includes(parsed.category) ? parsed.category : null;
if (!category) errors.push(`unknown category: ${JSON.stringify(parsed.category ?? null)}`);

const priority = PRIORITIES.includes(parsed.priority) ? parsed.priority : 'Medium';
if (!PRIORITIES.includes(parsed.priority)) errors.push('priority missing/invalid, defaulted to Medium');

let confidence = Number(parsed.confidence);
if (!Number.isFinite(confidence)) {
  confidence = 0;
  errors.push('confidence missing, set to 0');
}
if (confidence > 1 && confidence <= 100) confidence = confidence / 100; // model answered in %
confidence = Math.round(Math.min(Math.max(confidence, 0), 1) * 100) / 100;

const secondary = CATEGORIES.includes(parsed.secondary_category) ? parsed.secondary_category : null;

const classification = {
  category,
  secondary_category: secondary,
  priority,
  confidence,
  rationale: String(parsed.rationale ?? ''),
  validation_errors: errors,
};

return {
  json: {
    request_id: req.request_id,
    source: req.source,
    received_at: req.received_at,
    raw_message: req.raw_message,
    classification,
    llm_request: {
      model: MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: ENRICH_PROMPT },
        {
          role: 'user',
          content: `Category: ${category ?? 'Unclassified'}\nSource channel: ${req.source}\nMessage:\n"""\n${req.raw_message}\n"""`,
        },
      ],
    },
  },
};
