// Sends every message in samples/messages.json to the n8n webhook, one at a
// time, and saves the returned records to output/records.json.
//
// Usage (Node 18+):
//   node scripts/send-samples.mjs                 # production URL (workflow must be Active/Published)
//   node scripts/send-samples.mjs --test          # test URL (click "Execute workflow" in n8n first)
//   node scripts/send-samples.mjs --url http://localhost:5678/webhook/arcvault-intake
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : null;
const base = 'http://localhost:5678';
const url = urlArg ?? `${base}/${args.includes('--test') ? 'webhook-test' : 'webhook'}/arcvault-intake`;

const samples = JSON.parse(readFileSync(new URL('../samples/messages.json', import.meta.url)));
const records = [];

console.log(`POST -> ${url}\n`);
for (const s of samples) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(s),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    const rec = JSON.parse(text);
    records.push(rec);
    console.log(
      `${s.id}  ${String(rec.category).padEnd(18)} ${String(rec.priority).padEnd(6)} conf=${rec.confidence}  ` +
        `-> ${rec.routing?.destination_queue}${rec.escalation?.flagged ? '  [ESCALATED]' : ''}  (${Date.now() - started} ms)`,
    );
  } catch (err) {
    console.error(`${s.id}  ERROR ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 1500)); // stay well under Groq free-tier rate limits
}

mkdirSync(new URL('../output/', import.meta.url), { recursive: true });
const out = new URL('../output/records.json', import.meta.url);
writeFileSync(out, JSON.stringify(records, null, 2));
console.log(`\nSaved ${records.length}/${samples.length} records to output/records.json`);
