---
name: neo4j-memory-trace
description: >
  Record and query reasoning traces — tool calls, decisions, and skill
  invocations — for full audit trails. Use to capture why you made a
  decision and what evidence you used.
metadata:
  openclaw:
    emoji: "🔗"
    requires:
      bins: ["curl"]
---

# Neo4j Memory Trace

## When to use

- **Recording:** After making a significant decision, calling an external tool, or invoking a skill
- **Querying:** When the user asks "why did you do that?", "what sources did you use?", or needs an audit trail
- **Debugging:** When a past action's outcome was unexpected and you need to trace back the reasoning

## What you can trace

### Tool Calls

Record when you call external tools (web search, file read, API calls, etc.):

```bash
curl -s -X POST http://localhost:7575/memory/trace \
  -H "Content-Type: application/json" \
  -d '{
    "type": "tool_call",
    "data": {
      "tool": "web_search",
      "description": "Searched for Acme Corp Q4 earnings",
      "input": "Acme Corp Q4 2025 earnings report",
      "output": "Revenue $2.3B, up 15% YoY...",
      "duration_ms": 1200,
      "entities_referenced": ["Acme Corp"]
    },
    "session_id": "current-session-id",
    "message_id": "msg-abc123"
  }'
```

### Reasoning Steps

Record intermediate reasoning — conclusions, inferences, and the evidence behind them:

```bash
curl -s -X POST http://localhost:7575/memory/trace \
  -H "Content-Type: application/json" \
  -d '{
    "type": "reasoning_step",
    "data": {
      "content": "Based on Q4 earnings and analyst consensus, Acme stock appears overvalued",
      "step_type": "inference",
      "evidence": ["tc-abc123", "Acme Corp"]
    },
    "session_id": "current-session-id",
    "message_id": "msg-abc123"
  }'
```

Step types:
- `inference` — A conclusion drawn from evidence
- `decision` — A choice made between alternatives
- `observation` — Something noticed during processing
- `plan` — A planned sequence of actions

### Skill Invocations

Record when a skill is invoked:

```bash
curl -s -X POST http://localhost:7575/memory/trace \
  -H "Content-Type: application/json" \
  -d '{
    "type": "skill_invocation",
    "data": {
      "skill": "neo4j-memory-store",
      "input": "Store Sarah Kim as Person at Acme",
      "output": "Stored entity-sarah-kim-a1b2c3"
    },
    "session_id": "current-session-id"
  }'
```

## Querying reasoning traces

### Via recall (include reasoning)

```bash
curl -s -X POST http://localhost:7575/memory/recall \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Acme Corp earnings",
    "include_reasoning": true,
    "limit": 10
  }'
```

### Via free-form Cypher (advanced provenance queries)

**What evidence was used for a specific response?**
```cypher
MATCH (rs:ReasoningStep)-[:INFORMED_BY]->(evidence)
WHERE rs.session_id = $session_id
RETURN rs.content AS reasoning, labels(evidence) AS evidence_type,
       evidence.name AS evidence_name
ORDER BY rs.timestamp
```

**What tools were called in a session?**
```cypher
MATCH (s:Session {session_id: $session_id})-[:HAS_TOOL_CALL]->(tc:ToolCall)
RETURN tc.tool AS tool, tc.description AS description,
       tc.duration_ms AS duration, tc.timestamp AS time
ORDER BY tc.timestamp
```

**Full provenance chain for a decision:**
```cypher
MATCH (rs:ReasoningStep {step_type: 'decision'})
WHERE rs.content CONTAINS $topic
MATCH (rs)-[:INFORMED_BY]->(evidence)
OPTIONAL MATCH (evidence)-[:RETRIEVED]->(entity)
RETURN rs.content AS decision,
       collect(DISTINCT evidence.tool) AS tools_used,
       collect(DISTINCT entity.name) AS entities_referenced
```

**Compliance query — what did the agent know when it made a recommendation?**
```cypher
MATCH (tc:ToolCall)
WHERE tc.session_id = $session_id
OPTIONAL MATCH (tc)-[:RETRIEVED]->(e)
RETURN tc.tool AS tool, tc.description AS action,
       collect(e.name) AS entities_retrieved, tc.timestamp AS time
ORDER BY tc.timestamp
```

## Response format

```json
{
  "status": "recorded",
  "trace_id": "tc-a1b2c3d4e5f6"
}
```

## Guidelines

- Record tool calls AFTER the tool returns (so you have the output)
- Include `entities_referenced` to link tool calls to the entity graph
- Use `message_id` to link traces to specific conversation messages
- Reasoning steps should reference their evidence (tool call IDs or entity names)
- Don't trace trivial operations — focus on decisions with real consequences
- For compliance use cases, trace every external data retrieval
