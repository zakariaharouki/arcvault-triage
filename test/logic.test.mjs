// Offline test of the n8n Code nodes. It runs the exact jsCode stored in the
// built workflow JSON with mocked Groq responses, so routing and escalation
// rules can be checked without n8n or an API key.
// Run: node test/logic.test.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const wf = JSON.parse(readFileSync(new URL('../workflow/arcvault-triage.n8n.json', import.meta.url)));
const codeOf = (name) => wf.nodes.find((n) => n.name === name).parameters.jsCode;

function runNode(name, $json, ctx) {
  const $ = (node) => ({ item: { json: ctx[node] } });
  // eslint-disable-next-line no-new-func
  return new Function('$json', '$', codeOf(name))($json, $).json;
}
const groq = (obj) => ({ choices: [{ message: { content: typeof obj === 'string' ? obj : JSON.stringify(obj) } }] });

function pipeline(body, classifyOut, enrichOut) {
  const ctx = {};
  ctx['Prepare Classification'] = runNode('Prepare Classification', { body }, ctx);
  ctx['Validate Classification'] = runNode('Validate Classification', groq(classifyOut), ctx);
  return runNode('Route & Escalate', groq(enrichOut), ctx);
}

const emptyIds = { account_ids: [], invoice_numbers: [], error_codes: [], urls: [], products_or_features: [], other: [] };
const samples = JSON.parse(readFileSync(new URL('../samples/messages.json', import.meta.url)));
const by = Object.fromEntries(samples.map((s) => [s.id, s]));

const cases = [
  {
    name: 'REQ-001 login 403 -> Engineering, not escalated',
    body: by['REQ-001'],
    c: { rationale: 'x', category: 'Bug Report', secondary_category: 'Technical Question', priority: 'High', confidence: 0.88 },
    e: { core_issue: 'User gets 403 on login since last update.', identifiers: { ...emptyIds, account_ids: ['arcvault.io/user/jsmith'], error_codes: ['403'] }, amounts: { charged: null, expected: null, currency: null }, urgency_signal: { level: 'high', evidence: 'keep getting a 403 error' }, affected_scope: 'single user', summary: 's' },
    expect: { queue: 'Engineering', flagged: false },
  },
  {
    name: 'REQ-002 feature -> Product',
    body: by['REQ-002'],
    c: { rationale: 'x', category: 'Feature Request', secondary_category: null, priority: 'Low', confidence: 0.95 },
    e: { core_issue: 'Wants bulk export of audit logs.', identifiers: emptyIds, amounts: { charged: null, expected: null, currency: null }, urgency_signal: { level: 'low', evidence: null }, affected_scope: 'whole organisation', summary: 's' },
    expect: { queue: 'Product', flagged: false },
  },
  {
    name: 'REQ-003 billing $260 discrepancy -> Billing, NOT escalated',
    body: by['REQ-003'],
    c: { rationale: 'x', category: 'Billing Issue', secondary_category: null, priority: 'Medium', confidence: 0.97 },
    e: { core_issue: 'Invoice above contract rate.', identifiers: { ...emptyIds, invoice_numbers: ['#8821'] }, amounts: { charged: '$1,240', expected: 980, currency: 'USD' }, urgency_signal: { level: 'medium', evidence: 'Can someone look into this?' }, affected_scope: 'whole organisation', summary: 's' },
    expect: { queue: 'Billing', flagged: false, discrepancy: 260 },
  },
  {
    name: 'REQ-004 SSO question -> Technical Support',
    body: by['REQ-004'],
    c: { rationale: 'x', category: 'Technical Question', secondary_category: 'Feature Request', priority: 'Low', confidence: 0.84 },
    e: { core_issue: 'Asks if SSO with Okta is supported.', identifiers: { ...emptyIds, products_or_features: ['SSO', 'Okta'] }, amounts: { charged: null, expected: null, currency: null }, urgency_signal: { level: 'low', evidence: null }, affected_scope: 'whole organisation', summary: 's' },
    expect: { queue: 'Technical Support', flagged: false },
  },
  {
    name: 'REQ-005 outage -> Human Review (category + phrase), priority forced High',
    body: by['REQ-005'],
    c: { rationale: 'x', category: 'Incident/Outage', secondary_category: 'Bug Report', priority: 'Medium', confidence: 0.93 },
    e: { core_issue: 'Dashboard not loading for multiple users.', identifiers: { ...emptyIds, products_or_features: ['dashboard'] }, amounts: { charged: null, expected: null, currency: null }, urgency_signal: { level: 'high', evidence: 'Multiple users affected' }, affected_scope: 'multiple users', summary: 's' },
    expect: { queue: 'Human Review', flagged: true, standard: 'Engineering On-Call', priority: 'High', reasonsInclude: ['Incident/Outage', 'multiple users affected'] },
  },
  // ---- edge cases ---------------------------------------------------------
  {
    name: 'EDGE low confidence -> Human Review',
    body: { id: 'E1', source: 'Email', message: 'hey, quick thing about the thing from before' },
    c: { rationale: 'x', category: 'Technical Question', priority: 'Low', confidence: 0.42 },
    e: { core_issue: 'Unclear.', identifiers: emptyIds, amounts: {}, urgency_signal: { level: 'low' }, summary: 's' },
    expect: { queue: 'Human Review', flagged: true, standard: 'Technical Support', reasonsInclude: ['below 0.7'] },
  },
  {
    name: 'EDGE billing $1,500 over -> Human Review',
    body: { id: 'E2', source: 'Portal', message: 'Invoice 9001 charged $2,480, contract says $980.' },
    c: { rationale: 'x', category: 'Billing Issue', priority: 'Medium', confidence: 0.96 },
    e: { core_issue: 'Overcharge.', identifiers: emptyIds, amounts: { charged: 2480, expected: 980 }, urgency_signal: { level: 'medium' }, summary: 's' },
    expect: { queue: 'Human Review', flagged: true, discrepancy: 1500, reasonsInclude: ['exceeds $500'] },
  },
  {
    name: 'EDGE classifier returns garbage -> Human Review, confidence 0',
    body: { id: 'E3', source: 'Email', message: 'Help' },
    c: 'Sure! Here is the classification: Bug',
    e: { core_issue: '', identifiers: emptyIds, amounts: {}, urgency_signal: {}, summary: '' },
    expect: { queue: 'Human Review', flagged: true, standard: null, confidence: 0 },
  },
  {
    name: 'EDGE model answers confidence as 85 (percent) -> normalised to 0.85',
    body: { id: 'E4', source: 'Email', message: 'Please add a Slack integration.' },
    c: { rationale: 'x', category: 'Feature Request', priority: 'Low', confidence: 85 },
    e: { core_issue: 'Wants Slack integration.', identifiers: emptyIds, amounts: {}, urgency_signal: { level: 'low' }, summary: 's' },
    expect: { queue: 'Product', flagged: false, confidence: 0.85 },
  },
  {
    name: 'EDGE "outage" keyword on a non-incident category still escalates',
    body: { id: 'E5', source: 'Email', message: 'After the outage yesterday our invoice shows double charges of $40.' },
    c: { rationale: 'x', category: 'Billing Issue', priority: 'Medium', confidence: 0.9 },
    e: { core_issue: 'Double charge.', identifiers: emptyIds, amounts: { charged: 80, expected: 40 }, urgency_signal: { level: 'medium' }, summary: 's' },
    expect: { queue: 'Human Review', flagged: true, standard: 'Billing', reasonsInclude: ['"outage"'] },
  },
];

let failed = 0;
const rows = [];
for (const t of cases) {
  try {
    const r = pipeline(t.body, t.c, t.e);
    const x = t.expect;
    assert.equal(r.routing.destination_queue, x.queue, 'queue');
    assert.equal(r.escalation.flagged, x.flagged, 'flagged');
    if ('standard' in x) assert.equal(r.routing.standard_queue, x.standard, 'standard_queue');
    if ('discrepancy' in x) assert.equal(r.amounts.discrepancy, x.discrepancy, 'discrepancy');
    if ('priority' in x) assert.equal(r.priority, x.priority, 'priority');
    if ('confidence' in x) assert.equal(r.confidence, x.confidence, 'confidence');
    for (const s of x.reasonsInclude ?? []) {
      assert.ok(r.escalation.reasons.some((m) => m.includes(s)), `reason containing ${s} in ${JSON.stringify(r.escalation.reasons)}`);
    }
    rows.push(`PASS  ${t.name}`);
  } catch (err) {
    failed++;
    rows.push(`FAIL  ${t.name}\n      ${err.message}`);
  }
}
console.log(rows.join('\n'));
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
