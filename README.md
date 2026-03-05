# OpenClaw Neo4j Agent Memory Plugin

Graph-native long-term memory for OpenClaw agents, powered by Neo4j.

Replaces OpenClaw's flat Markdown-based memory with a three-tier graph memory system:

- **Short-term**: Conversation messages per session/channel
- **Long-term**: Entity knowledge graph using the POLE+O model (Person, Object, Location, Event + Observation)
- **Reasoning**: Tool call traces and decision provenance for full audit trails

## Why Graph Memory?

OpenClaw's default `MEMORY.md` stores facts as prose. This works for simple assistants but breaks down when:

- The same person/project appears across dozens of sessions (no deduplication)
- You need to query "what do I know about X?" across all history (requires scanning every file)
- You need to trace _why_ the agent made a decision (no reasoning records)
- The memory file grows large and gets injected wholesale into the prompt (token waste)

This plugin gives your agent a queryable knowledge graph that answers "how does everything I know relate to each other?" — across all agents, channels, and sessions.

## Quick Start

### Prerequisites

- A running Neo4j instance ([Neo4j Desktop](https://neo4j.com/download/), [Docker](https://hub.docker.com/_/neo4j), or [AuraDB Free](https://neo4j.com/cloud/aura-free/))
- Python 3.10+
- OpenClaw agent configured

### 1. Install the Plugin

Copy or clone this directory into your OpenClaw plugins folder:

```bash
git clone https://github.com/johnymontana/openclaw-neo4j-agent-memory-plugin.git
```

### 2. Configure Neo4j Connection

Set environment variables:

```bash
export NEO4J_URI="bolt://localhost:7687"
export NEO4J_USER="neo4j"
export NEO4J_PASSWORD="your-password"
export BRIDGE_PORT="7474"        # optional, default 7474
export AGENT_ID="my-agent"       # optional, default "default"
```

Or configure via OpenClaw's plugin config:

```json
{
  "memory.neo4j.uri": "bolt://localhost:7687",
  "memory.neo4j.user": "neo4j",
  "memory.neo4j.password": "your-password"
}
```

### 3. Start the Bridge Server

```bash
./server/start.sh
```

Verify it's running:

```bash
curl http://localhost:7474/memory/health
```

### 4. Use the Skills

The plugin ships four skills your agent learns automatically:

| Skill | Emoji | Purpose |
|---|---|---|
| `neo4j-memory-store` | :floppy_disk: | Store entities, observations, and messages |
| `neo4j-memory-recall` | :brain: | Retrieve relevant context from the graph |
| `neo4j-memory-query` | :mag: | Run structured or Cypher queries against the knowledge graph |
| `neo4j-memory-trace` | :link: | Record and query reasoning traces |

## Architecture

```
┌─────────────────────────────────────────────┐
│                OpenClaw Agent                │
│                                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐    │
│  │  store   │ │  recall  │ │  query   │    │
│  │  skill   │ │  skill   │ │  skill   │    │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘    │
│       │             │            │           │
│       └─────────────┼────────────┘           │
│                     │  curl                  │
└─────────────────────┼───────────────────────┘
                      │
              ┌───────▼───────┐
              │  FastAPI      │
              │  Bridge       │
              │  Server       │
              │  :7474        │
              └───────┬───────┘
                      │
              ┌───────▼───────┐
              │               │
              │    Neo4j      │
              │    :7687      │
              │               │
              └───────────────┘
```

## Graph Schema

### Entity Nodes (POLE+O)

| Label | Purpose | Key Properties |
|---|---|---|
| `:Person` | People, contacts | name, role, company |
| `:Organization` | Companies, teams | name, description |
| `:Location` | Places | name, description |
| `:Event` | Meetings, milestones | name, date, description |
| `:Object` | Everything else — projects, books, tools, concepts | name, description |
| `:Observation` | Unstructured notes about entities | content, subject |

### Infrastructure Nodes

| Label | Purpose |
|---|---|
| `:Session` | Conversation sessions |
| `:Message` | Individual messages |
| `:ToolCall` | Tool invocation records |
| `:ReasoningStep` | Intermediate reasoning |
| `:SkillInvocation` | Skill usage records |
| `:Agent` | Agent identity |
| `:Channel` | Communication channel |

### Relationship Types

| Relationship | Between | Meaning |
|---|---|---|
| `WORKS_AT` | Person → Organization | Employment |
| `AUTHORED_BY` | Object → Person | Authorship |
| `LOCATED_IN` | Location → Location | Geographic containment |
| `PARTICIPATED_IN` | Person → Event | Attendance |
| `RELATED_TO` | Any → Any | General association |
| `KNOWS` | Person → Person | Personal connection |
| `DEPENDS_ON` | Object → Object | Dependency |
| `HAS_MESSAGE` | Session → Message | Message in session |
| `NEXT` | Message → Message | Conversation order |
| `HAS_TOOL_CALL` | Session → ToolCall | Tool usage in session |
| `TRIGGERED` | Message → ToolCall | Message triggered tool |
| `RETRIEVED` | ToolCall → Entity | Data retrieved by tool |
| `INFORMED_BY` | ReasoningStep → Any | Evidence for reasoning |
| `OBSERVES` | Observation → Entity | Observation about entity |

## API Reference

### POST /memory/store

Store an entity, message, or observation.

```bash
curl -X POST http://localhost:7474/memory/store \
  -H "Content-Type: application/json" \
  -d '{
    "type": "entity",
    "data": {
      "label": "Person",
      "properties": { "name": "Sarah Kim", "role": "PM" },
      "relationships": [
        { "type": "WORKS_AT", "targetLabel": "Organization", "targetName": "Acme" }
      ]
    },
    "session_id": "session-123",
    "channel": "slack"
  }'
```

### POST /memory/recall

Retrieve relevant context via full-text search + graph traversal.

```bash
curl -X POST http://localhost:7474/memory/recall \
  -H "Content-Type: application/json" \
  -d '{"query": "Sarah Kim", "limit": 10}'
```

### POST /memory/query

Run structured or free-form Cypher queries.

```bash
curl -X POST http://localhost:7474/memory/query \
  -H "Content-Type: application/json" \
  -d '{
    "cypher": "MATCH (p:Person)-[:WORKS_AT]->(o:Organization) RETURN p.name, o.name LIMIT 10"
  }'
```

### POST /memory/trace

Record tool calls, reasoning steps, or skill invocations.

```bash
curl -X POST http://localhost:7474/memory/trace \
  -H "Content-Type: application/json" \
  -d '{
    "type": "tool_call",
    "data": {
      "tool": "web_search",
      "description": "Searched for Acme earnings",
      "input": "Acme Q4 2025 earnings",
      "output": "Revenue $2.3B..."
    },
    "session_id": "session-123"
  }'
```

### POST /memory/context

Selective context injection — returns a relevance-ranked context block.

```bash
curl -X POST http://localhost:7474/memory/context \
  -H "Content-Type: application/json" \
  -d '{"message": "What do we know about Sarah?", "max_tokens": 2000}'
```

### GET /memory/health

Check Neo4j connectivity.

### GET /memory/stats

Return memory counts and graph summary.

## Migrating from MEMORY.md

If you have an existing MEMORY.md, import it into the graph:

```bash
# Preview what will be imported
python tools/migrate_memory.py --memory-file /path/to/MEMORY.md --dry-run

# Run the migration
python tools/migrate_memory.py --memory-file /path/to/MEMORY.md
```

The migration tool parses bullet points, headers, and key-value patterns, classifying them as entities or observations and creating appropriate graph nodes.

## Docker Compose (Optional)

For a self-contained setup with Neo4j included:

```yaml
# docker-compose.yml
services:
  neo4j:
    image: neo4j:5
    ports:
      - "7687:7687"
      - "7475:7474"
    environment:
      - NEO4J_AUTH=neo4j/openclaw-memory
    volumes:
      - neo4j_data:/data

  bridge:
    build: ./server
    ports:
      - "7474:7474"
    environment:
      - NEO4J_URI=bolt://neo4j:7687
      - NEO4J_USER=neo4j
      - NEO4J_PASSWORD=openclaw-memory
    depends_on:
      - neo4j

volumes:
  neo4j_data:
```

## Stopping the Server

```bash
./server/stop.sh
```

## Project Structure

```
openclaw-neo4j-memory/
├── openclaw.plugin.json          # Plugin manifest
├── skills/
│   ├── neo4j-memory-store/
│   │   └── SKILL.md             # Store facts as graph entities
│   ├── neo4j-memory-recall/
│   │   └── SKILL.md             # Retrieve relevant context
│   ├── neo4j-memory-query/
│   │   └── SKILL.md             # Free-form entity queries
│   └── neo4j-memory-trace/
│       └── SKILL.md             # Record & query reasoning traces
├── server/
│   ├── main.py                  # FastAPI bridge server
│   ├── requirements.txt         # Python dependencies
│   ├── start.sh                 # Start server
│   └── stop.sh                  # Stop server
├── tools/
│   └── migrate_memory.py        # MEMORY.md → Neo4j migration
└── README.md
```

## Neo4j Labs

This is a [Neo4j Labs](https://neo4j.com/labs/) project. APIs are subject to change. Community support via [community.neo4j.com](https://community.neo4j.com).

## License

Apache 2.0
