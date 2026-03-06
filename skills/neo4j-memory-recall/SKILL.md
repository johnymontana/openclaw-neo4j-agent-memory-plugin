---
name: neo4j-memory-recall
description: >
  Retrieve relevant memory from the Neo4j graph when you need context
  about a person, project, topic, or past event. Use before answering
  questions that reference past conversations or named entities.
metadata:
  openclaw:
    emoji: "🧠"
    requires:
      bins: ["curl"]
---

# Neo4j Memory Recall

## When to use

- User references a person, project, or topic you may have discussed before
- You need facts from previous sessions not in the current conversation
- User asks "do you remember...", "last time we talked about...", or "what do you know about..."
- You are about to compose a message or email to someone and need relationship context
- User asks a question that might be answered by previously stored knowledge
- You want to check if you already have information before searching externally

## Workflow

### Basic recall

1. Extract the key entity or topic from the user message
2. POST to the bridge server
3. Inject the returned context into your response
4. If nothing is found, proceed normally and note you have no prior context

```bash
curl -s -X POST http://localhost:7575/memory/recall \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Sarah Kim",
    "limit": 10
  }'
```

### Recall with reasoning traces

Include reasoning history (tool calls, decisions) for audit or debugging:

```bash
curl -s -X POST http://localhost:7575/memory/recall \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Q3 roadmap decision",
    "limit": 10,
    "include_reasoning": true
  }'
```

### Selective context injection

For the most token-efficient context injection, use the `/memory/context` endpoint which returns a pre-formatted, relevance-ranked context block:

```bash
curl -s -X POST http://localhost:7575/memory/context \
  -H "Content-Type: application/json" \
  -d '{
    "message": "The full user message to find context for",
    "max_tokens": 2000
  }'
```

This returns a Markdown-formatted context block with:
- Matched entities and their properties
- Relationship graph (1-hop traversal)
- Relevant observations
- Recent reasoning traces

## Response format

### /memory/recall response

```json
{
  "results": [
    {
      "name": "Sarah Kim",
      "role": "Product Manager",
      "company": "Acme Corp",
      "_labels": ["Person"],
      "_score": 2.45,
      "_relationships": [
        { "type": "WORKS_AT", "target_labels": ["Organization"], "target_name": "Acme Corp" },
        { "type": "PARTICIPATED_IN", "target_labels": ["Event"], "target_name": "ProductConf 2026" }
      ]
    }
  ],
  "count": 1,
  "query": "Sarah Kim"
}
```

### /memory/context response

```json
{
  "context": "## Known Entities\n[Person] Sarah Kim: {'role': 'PM', 'company': 'Acme'}\n  Sarah Kim -WORKS_AT-> Acme Corp\n\n## Observations\n- Prefers async communication",
  "entities_used": 3,
  "reasoning_traces": 1,
  "token_estimate": 145
}
```

## Guidelines

- Recall BEFORE answering questions about people, projects, or past events
- Use `/memory/context` for system prompt injection (most token-efficient)
- Use `/memory/recall` when you need raw structured data for processing
- If recall returns nothing, say so — don't hallucinate prior context
- Use `include_reasoning: true` only when the user asks about past decisions or audit trails
- Keep `limit` reasonable (5–15) to avoid overwhelming context
- The `_score` field indicates relevance — higher is better
