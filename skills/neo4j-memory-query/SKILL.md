---
name: neo4j-memory-query
description: >
  Run structured or free-form queries against the entity knowledge graph.
  Use when you need to search, filter, or aggregate across all stored
  entities, relationships, and memory stats.
metadata:
  openclaw:
    emoji: "🔍"
    requires:
      config: ["memory.neo4j.uri", "memory.neo4j.password"]
      bins: ["curl"]
---

# Neo4j Memory Query

## When to use

- User asks a question that requires searching across multiple entities
- You need to find all entities of a specific type (e.g., "all people I know at Acme")
- User wants aggregate information ("how many projects am I tracking?")
- You need to traverse relationships ("who introduced me to Sarah?")
- User asks "what do I know about..." or "show me everything related to..."
- You want to check how much memory you have stored (stats)

## Workflow

### Template-based entity query

Search by entity type and/or name:

```bash
curl -s -X POST http://localhost:7474/memory/query \
  -H "Content-Type: application/json" \
  -d '{
    "entity_type": "Person",
    "name": "Kim",
    "limit": 25
  }'
```

Parameters:
- `entity_type` (optional): Filter by label — "Person", "Organization", "Location", "Event", "Object"
- `name` (optional): Substring match on entity name
- `limit` (optional, default 25): Max results to return

### Free-form Cypher query

For advanced queries — relationship traversals, aggregations, path finding:

```bash
curl -s -X POST http://localhost:7474/memory/query \
  -H "Content-Type: application/json" \
  -d '{
    "cypher": "MATCH (p:Person)-[:WORKS_AT]->(o:Organization {name: $company}) RETURN p.name AS name, p.role AS role",
    "params": { "company": "Acme Corp" }
  }'
```

### Common query patterns

**Find all people at a company:**
```cypher
MATCH (p:Person)-[:WORKS_AT]->(o:Organization {name: $company})
RETURN p.name AS name, p.role AS role
```

**Find mutual connections between two people:**
```cypher
MATCH (a:Person {name: $person1})-[:KNOWS]->(mutual:Person)<-[:KNOWS]-(b:Person {name: $person2})
RETURN mutual.name AS mutual_connection
```

**Find all entities related to a topic:**
```cypher
MATCH (n)-[r]-(t)
WHERE n.name CONTAINS $topic OR t.name CONTAINS $topic
RETURN n.name AS source, type(r) AS relationship, t.name AS target
LIMIT 20
```

**Find books/articles by a person:**
```cypher
MATCH (b:Object)-[:AUTHORED_BY]->(p:Person {name: $author})
RETURN b.name AS title, b.description AS description
```

**Find the path between two entities:**
```cypher
MATCH path = shortestPath((a {name: $entity1})-[*..5]-(b {name: $entity2}))
RETURN [n IN nodes(path) | n.name] AS path_names,
       [r IN relationships(path) | type(r)] AS path_rels
```

**Get a timeline of events:**
```cypher
MATCH (e:Event)
WHERE e.agent_id = $agent_id OR e.agent_id IS NULL
RETURN e.name AS event, e.date AS date, e.description AS description
ORDER BY e.date DESC LIMIT 20
```

### Check memory stats

```bash
curl -s http://localhost:7474/memory/stats
```

Returns:
```json
{
  "agent_id": "default",
  "person_count": 42,
  "organization_count": 12,
  "object_count": 87,
  "location_count": 5,
  "event_count": 15,
  "observation_count": 31,
  "sessions": 23,
  "messages": 456,
  "tool_calls": 89,
  "reasoning_steps": 34,
  "skill_invocations": 67,
  "total_relationships": 312,
  "recent_entities": [
    { "name": "Sarah Kim", "labels": ["Person"] }
  ],
  "channels": ["telegram", "slack", "whatsapp"]
}
```

## Response format

```json
{
  "results": [
    {
      "name": "Sarah Kim",
      "role": "Product Manager",
      "_labels": ["Person"],
      "_relationships": [
        { "type": "WORKS_AT", "target": "Acme Corp" }
      ]
    }
  ],
  "count": 1
}
```

## Guidelines

- Use template queries for simple entity lookups
- Use free-form Cypher for relationship traversals and aggregations
- Always use parameterized queries (`$param`) — never interpolate user input into Cypher strings
- The `$agent_id` parameter is automatically injected into template queries
- For Cypher queries, use `$agent_id` to filter by agent namespace
- Keep `limit` reasonable to avoid overwhelming context windows
- Use `memory/stats` to give users a summary of their knowledge graph
