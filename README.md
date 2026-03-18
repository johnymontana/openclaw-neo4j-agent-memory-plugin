# OpenClaw Neo4j Agent Memory Plugin

Graph native short-term, long-term, and reasoning memory to make your claw more powerful and efficient powered by [Neo4j Agent Memory](https://github.com/neo4j-labs/agent-memory).

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

- Node.js >= 18
- Python 3.10+
- OpenClaw agent configured

### 1. Install the Plugin

```bash
openclaw plugins install @johnymontana/openclaw-neo4j-memory
```

This will automatically:
- Download and start a local Neo4j instance (via [`@johnymontana/neo4j-local`](https://www.npmjs.com/package/@johnymontana/neo4j-local))
- Launch the FastAPI bridge server
- Configure credentials automatically — no manual Neo4j setup required
- Reuse the packaged `server/.venv` and repair its local Python launcher shims on first run if the install strips them

OpenClaw may warn that the plugin contains shell-command execution. That is expected for this plugin: the runtime entry starts and stops the existing `server/start.sh` and `server/stop.sh` lifecycle scripts.

### 2. Use the Native Tools

Once installed, the plugin participates directly in the OpenClaw agent loop through native tools and hooks:

- `memory_search` for ranked Neo4j-backed recall
- `memory_get` for fuller entity-centric reads
- `memory_store` for durable graph writes
- `entity_lookup` and `graph_query` for graph-native exploration
- `reasoning_trace` for provenance and audit history

If `autoRecall` is enabled, the plugin also injects relevant memory automatically before prompt build. If `autoCapture` is enabled, recent user messages are stored after successful runs.

Important OpenClaw runtime note:

- Under the standard `tools.profile: "coding"` policy, OpenClaw's built-in `group:memory` currently exposes `memory_search` and `memory_get`.
- The graph-native tools (`memory_store`, `entity_lookup`, `graph_query`, `reasoning_trace`) work, but they must be added via `tools.alsoAllow` if you want them available to the model in normal agent runs.

Example:

```json
{
  "tools": {
    "profile": "coding",
    "alsoAllow": [
      "memory_store",
      "entity_lookup",
      "graph_query",
      "reasoning_trace"
    ]
  }
}
```

### 3. Use the Skills

The plugin still ships four skills as a fallback and for direct bridge workflows:

| Skill | Emoji | Purpose |
|---|---|---|
| `neo4j-memory-store` | :floppy_disk: | Store entities, observations, and messages |
| `neo4j-memory-recall` | :brain: | Retrieve relevant context from the graph |
| `neo4j-memory-query` | :mag: | Run structured or Cypher queries against the knowledge graph |
| `neo4j-memory-trace` | :link: | Record and query reasoning traces |

### 4. Convert an Existing Agent Package

If your agent package still uses `MEMORY.md` or `memory/YYYY-MM-DD.md`, update it right after installing the plugin:

1. Read the `neo4j-memory-store`, `neo4j-memory-recall`, and `neo4j-memory-query` skills.
2. Rewrite the Memory section of `AGENTS.md` so Neo4j is the primary store for both daily notes and long-term memory, replacing the `memory/YYYY-MM-DD.md` and `MEMORY.md` patterns.
3. Migrate the current contents of `MEMORY.md` into Neo4j.
4. Test that one write and one read both work before finishing the migration.

You can do that manually, or ask the agent to perform the migration end-to-end:

```bash
openclaw agent --agent main --message "Update AGENTS.md to use Neo4j as the primary memory store instead of .md files.
Specifically:
1. Read the neo4j-memory-store, neo4j-memory-recall, and neo4j-memory-query skill files to understand how they work
2. Rewrite the Memory section of AGENTS.md to use Neo4j for both daily notes and long-term memory (replace the memory/YYYY-MM-DD.md and MEMORY.md patterns)
3. Migrate the current contents of MEMORY.md into Neo4j so nothing is lost
4. Test that a write and read both work before finishing"
```

If you installed an older build of this plugin, upgrade to the latest package before relying on `/memory/recall` or `/memory/context`.

## Architecture

```
┌─────────────────────────────────────────────┐
│                OpenClaw Agent                │
│                                             │
│  ┌──────────────┐ ┌──────────────────────┐  │
│  │ Native Tools │ │ Auto Hooks           │  │
│  │memory_search │ │before_prompt_build   │  │
│  │memory_get    │ │agent_end             │  │
│  │memory_store  │ │after_tool_call*      │  │
│  └──────┬───────┘ └──────────┬───────────┘  │
│         │                     │              │
│         └─────────────┬───────┘              │
│                       │ bridge client        │
└─────────────────────┼───────────────────────┘
                      │
              ┌───────▼───────┐
              │  FastAPI      │
              │  Bridge       │
              │  Server       │
              │  :7575        │
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
curl -X POST http://localhost:7575/memory/store \
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
curl -X POST http://localhost:7575/memory/recall \
  -H "Content-Type: application/json" \
  -d '{"query": "Sarah Kim", "limit": 10}'
```

### POST /memory/query

Run structured or read-only Cypher queries.

```bash
curl -X POST http://localhost:7575/memory/query \
  -H "Content-Type: application/json" \
  -d '{
    "cypher": "MATCH (p:Person)-[:WORKS_AT]->(o:Organization) RETURN p.name, o.name LIMIT 10"
  }'
```

### POST /memory/trace

Record tool calls, reasoning steps, or skill invocations.

```bash
curl -X POST http://localhost:7575/memory/trace \
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
curl -X POST http://localhost:7575/memory/context \
  -H "Content-Type: application/json" \
  -d '{"message": "What do we know about Sarah?", "max_tokens": 2000}'
```

### POST /memory/get

Read a fuller entity-centric memory document for a recall hit:

```bash
curl -X POST http://localhost:7575/memory/get \
  -H "Content-Type: application/json" \
  -d '{"id": "entity-123", "from_line": 1, "lines": 20}'
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

## Configuration (Optional)

The plugin works out of the box with zero configuration. To override defaults, configure the plugin under `plugins.entries.openclaw-neo4j-memory.config`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-neo4j-memory": {
        "enabled": true,
        "config": {
          "bridgePort": 7575,
          "agentId": "default",
          "instance": "openclaw-memory",
          "ephemeral": false,
          "autoRecall": true,
          "autoCapture": false,
          "graphTools": true,
          "readOnlyCypher": true,
          "observational": false
        }
      }
    }
  }
}
```

| Key | Default | Description |
|---|---|---|
| `bridgePort` | `7575` | Bridge server port |
| `agentId` | `default` | Agent identity for memory namespace scoping |
| `instance` | `openclaw-memory` | Neo4j local instance name |
| `ephemeral` | `false` | Use an ephemeral managed Neo4j instance |
| `autoRecall` | `true` | Inject relevant graph memory before prompt build |
| `autoCapture` | `false` | Store recent user messages after successful runs |
| `graphTools` | `true` | Expose `entity_lookup` and `graph_query` |
| `readOnlyCypher` | `true` | Restrict graph queries to read-only Cypher |
| `observational` | `false` | Record tool-call traces after execution |

If you want the advanced graph-native tools to be callable by the model under the normal OpenClaw `coding` profile, add them with `tools.alsoAllow`:

```json
{
  "tools": {
    "profile": "coding",
    "alsoAllow": [
      "memory_store",
      "entity_lookup",
      "graph_query",
      "reasoning_trace"
    ]
  }
}
```

## Stopping

```bash
./server/stop.sh
```

This stops both the bridge server and the local Neo4j instance.

## Project Structure

```
openclaw-neo4j-memory/
├── package.json                  # npm package & neo4j-local dependency
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
│   ├── start.sh                 # Start Neo4j + bridge server
│   └── stop.sh                  # Stop bridge server + Neo4j
├── tools/
│   └── migrate_memory.py        # MEMORY.md → Neo4j migration
└── README.md
```

## License

Apache 2.0
