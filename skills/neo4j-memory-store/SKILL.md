---
name: neo4j-memory-store
description: >
  Store facts, entities, and observations as graph nodes in Neo4j.
  Use whenever you learn a new fact about a person, organization,
  project, location, event, or concept that should persist across sessions.
metadata:
  openclaw:
    emoji: "💾"
    requires:
      config: ["memory.neo4j.uri", "memory.neo4j.password"]
      bins: ["curl"]
---

# Neo4j Memory Store

## When to use

- You learn a new fact about a person, company, project, or topic
- The user tells you something they want you to remember
- You encounter a named entity (person, place, event, organization) worth tracking
- You make an observation about a pattern, preference, or relationship
- You want to record a relationship between two entities (e.g., "Alice works at Acme")

## What you can store

### Entities (POLE+O model)

Store structured entities with typed relationships:

- **Person**: People, contacts, team members
- **Organization**: Companies, teams, groups
- **Location**: Places, offices, cities, countries
- **Event**: Meetings, milestones, incidents, dates
- **Object**: Projects, documents, tools, concepts, books, articles — anything else

### Observations

Store unstructured observations about an entity — notes, impressions, or context that doesn't fit a structured property.

### Messages

Store conversation messages for short-term memory within a session.

## Workflow

### Storing an entity

1. Identify the entity type (Person, Organization, Location, Event, or Object)
2. Extract properties (name is required; add role, description, etc. as available)
3. Identify relationships to other entities
4. POST to the bridge server:

```bash
curl -s -X POST http://localhost:7474/memory/store \
  -H "Content-Type: application/json" \
  -d '{
    "type": "entity",
    "data": {
      "label": "Person",
      "properties": {
        "name": "Sarah Kim",
        "role": "Product Manager",
        "company": "Acme Corp"
      },
      "relationships": [
        {
          "type": "WORKS_AT",
          "targetLabel": "Organization",
          "targetName": "Acme Corp"
        }
      ]
    },
    "session_id": "current-session-id",
    "channel": "telegram"
  }'
```

### Storing an observation

```bash
curl -s -X POST http://localhost:7474/memory/store \
  -H "Content-Type: application/json" \
  -d '{
    "type": "observation",
    "data": {
      "content": "Prefers async communication over meetings",
      "subject": "Sarah Kim"
    },
    "session_id": "current-session-id"
  }'
```

### Storing a message

```bash
curl -s -X POST http://localhost:7474/memory/store \
  -H "Content-Type: application/json" \
  -d '{
    "type": "message",
    "data": {
      "role": "user",
      "content": "Can you look into the Q3 roadmap?"
    },
    "session_id": "current-session-id",
    "channel": "slack"
  }'
```

## Common relationship types

Use these relationship types to connect entities:

| Relationship | Between | Example |
|---|---|---|
| `WORKS_AT` | Person → Organization | Alice works at Acme |
| `AUTHORED_BY` | Object → Person | Book authored by Camille |
| `LOCATED_IN` | Location → Location | Office in San Francisco |
| `PARTICIPATED_IN` | Person → Event | Bob attended ProductConf |
| `RELATED_TO` | Any → Any | Project related to concept |
| `REFERENCES` | Object → Object | Article references paper |
| `DEPENDS_ON` | Object → Object | Service depends on database |
| `OWNS` | Person → Object | Alice owns the auth module |
| `KNOWS` | Person → Person | Alice knows Bob |
| `DISCUSSED` | Event → Object | Meeting discussed roadmap |
| `MEMBER_OF` | Person → Organization | Alice is member of Platform team |

## Response format

```json
{
  "status": "stored",
  "node_id": "entity-sarah-kim-a1b2c3",
  "merged": false
}
```

- `merged: true` means an existing entity was updated (not duplicated)
- `merged: false` means a new entity was created

## Guidelines

- Always use the person's full name when known
- Include the `session_id` to enable cross-session tracking
- Include the `channel` to enable cross-channel memory
- Store relationships at creation time — don't create orphan entities
- Prefer specific relationship types over generic `RELATED_TO`
- When the same entity appears with different names (e.g., "Sarah", "Sarah Kim"), store under the most complete name
