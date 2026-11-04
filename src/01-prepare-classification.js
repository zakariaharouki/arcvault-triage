// STEP 1 (Ingestion) + request builder for STEP 2 (Classification)
// Mode: Run Once for Each Item. Normalises whatever arrived at the webhook
// into one internal shape, then builds the Groq chat-completions request.

const MODEL = 'llama-3.3-70b-versatile';

const SYSTEM_PROMPT = `{{CLASSIFY_PROMPT}}`;

// Webhook node puts the POST body under $json.body; accept a few field names
// so email / form / portal adapters can all post here.
const body = $json.body ?? $json;
const message = String(body.message ?? body.text ?? body.content ?? '').trim();

const request = {
  request_id: String(body.id ?? `REQ-${Date.now()}`),
  source: String(body.source ?? 'Unknown'),
  received_at: new Date().toISOString(),
  raw_message: message,
};

return {
  json: {
    ...request,
    llm_request: {
      model: MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Source channel: ${request.source}\nMessage:\n"""\n${message || '(empty message)'}\n"""`,
        },
      ],
    },
  },
};
