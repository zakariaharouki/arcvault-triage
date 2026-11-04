"""Builds workflow/arcvault-triage.n8n.json from prompts/ and src/.

Keeping prompts and code in plain files (instead of only inside n8n) means they
are diff-able, reviewable and testable outside n8n.
Usage:  python scripts/build-workflow.py
"""
import json
import pathlib
import uuid

ROOT = pathlib.Path(__file__).resolve().parent.parent
NS = uuid.UUID("6f1c2b8e-3d4a-4e5f-9a7b-1c2d3e4f5a6b")
WEBHOOK_SITE = "https://webhook.site/REPLACE-WITH-YOUR-WEBHOOK-SITE-ID"
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"


def uid(name: str) -> str:
    return str(uuid.uuid5(NS, name))


def template_literal(text: str) -> str:
    return text.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${").rstrip("\n")


def code(path: str, **prompts: str) -> str:
    src = (ROOT / "src" / path).read_text(encoding="utf-8")
    for key, prompt_file in prompts.items():
        prompt = (ROOT / "prompts" / prompt_file).read_text(encoding="utf-8")
        src = src.replace("{{" + key + "}}", template_literal(prompt))
    return src


def code_node(name, js, pos):
    return {
        "id": uid(name), "name": name, "type": "n8n-nodes-base.code", "typeVersion": 2,
        "position": pos, "parameters": {"mode": "runOnceForEachItem", "jsCode": js},
    }


def groq_node(name, pos):
    return {
        "id": uid(name), "name": name, "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2,
        "position": pos,
        "parameters": {
            "method": "POST",
            "url": GROQ_URL,
            "authentication": "genericCredentialType",
            "genericAuthType": "httpHeaderAuth",
            "sendBody": True,
            "specifyBody": "json",
            "jsonBody": "={{ JSON.stringify($json.llm_request) }}",
            "options": {"timeout": 30000},
        },
        "retryOnFail": True, "maxTries": 3, "waitBetweenTries": 3000,
    }


def delivery_node(name, pos):
    return {
        "id": uid(name), "name": name, "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2,
        "position": pos,
        "parameters": {
            "method": "POST",
            "url": WEBHOOK_SITE,
            "sendQuery": True,
            "queryParameters": {"parameters": [
                {"name": "queue", "value": "={{ $json.routing.destination_queue }}"},
                {"name": "request_id", "value": "={{ $json.request_id }}"},
            ]},
            "sendBody": True,
            "specifyBody": "json",
            "jsonBody": "={{ JSON.stringify($json) }}",
            "options": {"timeout": 15000},
        },
        # A downstream mock being unavailable must not lose the record.
        "onError": "continueRegularOutput",
    }


nodes = [
    {
        "id": uid("note"), "name": "README", "type": "n8n-nodes-base.stickyNote", "typeVersion": 1,
        "position": [-40, -360],
        "parameters": {
            "width": 820, "height": 260,
            "content": (
                "## ArcVault intake & triage\n"
                "**1 Ingest** webhook  ->  **2 Classify** (LLM)  ->  **3 Enrich + summary** (LLM)  ->  "
                "**4-6 Route, escalate, build record** (plain code, no LLM)  ->  deliver to queue + return JSON\n\n"
                "- LLM: Groq `llama-3.3-70b-versatile`, temperature 0, JSON mode\n"
                "- Escalate if confidence < 0.70, Incident/Outage, escalation phrase, or billing discrepancy > $500\n"
                "- Setup: create a **Header Auth** credential `Groq API` (Name `Authorization`, Value `Bearer <key>`) "
                "and select it on both LLM nodes; paste your webhook.site URL into both Deliver nodes."
            ),
        },
    },
    {
        "id": uid("webhook"), "name": "Inbound Request", "type": "n8n-nodes-base.webhook", "typeVersion": 2,
        "position": [0, 0], "webhookId": uid("webhook-id"),
        "parameters": {"httpMethod": "POST", "path": "arcvault-intake", "responseMode": "responseNode", "options": {}},
    },
    code_node("Prepare Classification", code("01-prepare-classification.js", CLASSIFY_PROMPT="01-classify.system.txt"), [220, 0]),
    groq_node("LLM: Classify", [440, 0]),
    code_node("Validate Classification", code("02-validate-classification.js", ENRICH_PROMPT="02-enrich.system.txt"), [660, 0]),
    groq_node("LLM: Enrich & Summarize", [880, 0]),
    code_node("Route & Escalate", code("03-route-and-escalate.js"), [1100, 0]),
    {
        "id": uid("if"), "name": "Needs Human Review?", "type": "n8n-nodes-base.if", "typeVersion": 2.2,
        "position": [1320, 0],
        "parameters": {
            "conditions": {
                "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict", "version": 2},
                "conditions": [{
                    "id": uid("if-cond"),
                    "leftValue": "={{ $json.escalation.flagged }}",
                    "rightValue": "",
                    "operator": {"type": "boolean", "operation": "true", "singleValue": True},
                }],
                "combinator": "and",
            },
            "options": {},
        },
    },
    delivery_node("Deliver: Escalation Queue", [1560, -120]),
    delivery_node("Deliver: Team Queue", [1560, 120]),
    {
        "id": uid("respond"), "name": "Return Record", "type": "n8n-nodes-base.respondToWebhook", "typeVersion": 1.1,
        "position": [1800, 0],
        "parameters": {
            "respondWith": "json",
            "responseBody": "={{ JSON.stringify($('Route & Escalate').item.json) }}",
            "options": {},
        },
    },
]


def link(*targets):
    return [[{"node": t, "type": "main", "index": 0} for t in targets]]


connections = {
    "Inbound Request": {"main": link("Prepare Classification")},
    "Prepare Classification": {"main": link("LLM: Classify")},
    "LLM: Classify": {"main": link("Validate Classification")},
    "Validate Classification": {"main": link("LLM: Enrich & Summarize")},
    "LLM: Enrich & Summarize": {"main": link("Route & Escalate")},
    "Route & Escalate": {"main": link("Needs Human Review?")},
    "Needs Human Review?": {"main": [
        [{"node": "Deliver: Escalation Queue", "type": "main", "index": 0}],
        [{"node": "Deliver: Team Queue", "type": "main", "index": 0}],
    ]},
    "Deliver: Escalation Queue": {"main": link("Return Record")},
    "Deliver: Team Queue": {"main": link("Return Record")},
}

workflow = {
    "name": "ArcVault Intake & Triage",
    "nodes": nodes,
    "connections": connections,
    "settings": {"executionOrder": "v1"},
    "pinData": {},
}

out = ROOT / "workflow" / "arcvault-triage.n8n.json"
out.write_text(json.dumps(workflow, indent=2, ensure_ascii=False), encoding="utf-8")
print(f"wrote {out.relative_to(ROOT)} ({len(nodes)} nodes)")
