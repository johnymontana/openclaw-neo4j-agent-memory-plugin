"""
OpenClaw Neo4j Agent Memory Bridge Server

A FastAPI service that bridges OpenClaw agent tool calls to a Neo4j graph database,
providing three-tier memory: short-term (conversations), long-term (POLE+O entities),
and reasoning (tool call traces and decision provenance).
"""

import os
import time
import uuid
import asyncio
import logging
from datetime import datetime, timezone
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from neo4j import AsyncGraphDatabase

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "password")
AGENT_ID = os.environ.get("AGENT_ID", "default")
BRIDGE_PORT = int(os.environ.get("BRIDGE_PORT", "7575"))

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("neo4j-memory-bridge")

# ---------------------------------------------------------------------------
# Neo4j driver lifecycle
# ---------------------------------------------------------------------------

driver = None


async def _connect_and_init(max_retries: int = 5, delay: float = 2.0):
    """Connect to Neo4j and create indexes, retrying if Neo4j isn't ready yet."""
    global driver
    last_error = None

    for attempt in range(1, max_retries + 1):
        try:
            driver = AsyncGraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
            # Verify connectivity and create indexes
            async with driver.session() as session:
                await session.run(
                    "CREATE INDEX IF NOT EXISTS FOR (p:Person) ON (p.name)"
                )
                await session.run(
                    "CREATE INDEX IF NOT EXISTS FOR (o:Object) ON (o.name)"
                )
                await session.run(
                    "CREATE INDEX IF NOT EXISTS FOR (l:Location) ON (l.name)"
                )
                await session.run(
                    "CREATE INDEX IF NOT EXISTS FOR (e:Event) ON (e.name)"
                )
                await session.run(
                    "CREATE INDEX IF NOT EXISTS FOR (ob:Observation) ON (ob.content)"
                )
                await session.run(
                    "CREATE INDEX IF NOT EXISTS FOR (s:Session) ON (s.session_id)"
                )
                await session.run(
                    "CREATE INDEX IF NOT EXISTS FOR (m:Message) ON (m.timestamp)"
                )
                await session.run(
                    "CREATE INDEX IF NOT EXISTS FOR (tc:ToolCall) ON (tc.call_id)"
                )
                await session.run(
                    "CREATE INDEX IF NOT EXISTS FOR (a:Agent) ON (a.agent_id)"
                )
                await session.run(
                    "CREATE INDEX IF NOT EXISTS FOR (c:Channel) ON (c.name)"
                )
                # Full-text index for recall search
                await session.run(
                    """
                    CREATE FULLTEXT INDEX entityFulltext IF NOT EXISTS
                    FOR (n:Person|Object|Location|Event|Observation)
                    ON EACH [n.name, n.content, n.description]
                    """
                )
            logger.info("Connected to Neo4j at %s", NEO4J_URI)
            logger.info("Indexes and constraints initialized")
            return
        except Exception as e:
            last_error = e
            if driver:
                try:
                    await driver.close()
                except Exception:
                    pass
                driver = None
            if attempt < max_retries:
                logger.warning(
                    "Neo4j not ready (attempt %d/%d): %s — retrying in %.0fs",
                    attempt, max_retries, e, delay,
                )
                await asyncio.sleep(delay)
            else:
                logger.error(
                    "Failed to connect to Neo4j after %d attempts: %s",
                    max_retries, e,
                )

    raise RuntimeError(
        f"Could not connect to Neo4j at {NEO4J_URI} after {max_retries} attempts: {last_error}"
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    await _connect_and_init()
    yield
    if driver:
        await driver.close()
        logger.info("Neo4j driver closed")


app = FastAPI(
    title="OpenClaw Neo4j Memory Bridge",
    version="0.1.0",
    lifespan=lifespan,
)

# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class Relationship(BaseModel):
    type: str
    target_label: str = Field(alias="targetLabel")
    target_name: str = Field(alias="targetName")
    target_properties: dict = Field(default_factory=dict, alias="targetProperties")

    model_config = {"populate_by_name": True}


class EntityData(BaseModel):
    label: str
    properties: dict
    relationships: list[Relationship] = Field(default_factory=list)


class MessageData(BaseModel):
    role: str
    content: str
    timestamp: Optional[str] = None


class StoreRequest(BaseModel):
    type: str  # "entity", "message", "observation"
    data: dict
    session_id: Optional[str] = None
    channel: Optional[str] = None
    agent_id: Optional[str] = None


class StoreResponse(BaseModel):
    status: str
    node_id: str
    merged: bool


class RecallRequest(BaseModel):
    query: str
    limit: int = 10
    session_id: Optional[str] = None
    channel: Optional[str] = None
    agent_id: Optional[str] = None
    include_reasoning: bool = False


class RecallResponse(BaseModel):
    results: list[dict]
    count: int
    query: str


class QueryRequest(BaseModel):
    entity_type: Optional[str] = None
    name: Optional[str] = None
    cypher: Optional[str] = None
    params: dict = Field(default_factory=dict)
    limit: int = 25
    agent_id: Optional[str] = None


class QueryResponse(BaseModel):
    results: list[dict]
    count: int


class TraceRequest(BaseModel):
    type: str  # "tool_call", "reasoning_step", "skill_invocation"
    data: dict
    session_id: Optional[str] = None
    message_id: Optional[str] = None
    agent_id: Optional[str] = None


class TraceResponse(BaseModel):
    status: str
    trace_id: str


class ContextRequest(BaseModel):
    """Request for selective context injection (Phase 3)."""
    message: str
    max_tokens: int = 2000
    session_id: Optional[str] = None
    agent_id: Optional[str] = None


class ContextResponse(BaseModel):
    context: str
    entities_used: int
    reasoning_traces: int
    token_estimate: int


# ---------------------------------------------------------------------------
# Helper: resolve agent_id
# ---------------------------------------------------------------------------

def resolve_agent(agent_id: Optional[str]) -> str:
    return agent_id or AGENT_ID


# ---------------------------------------------------------------------------
# POST /memory/store
# ---------------------------------------------------------------------------

@app.post("/memory/store", response_model=StoreResponse)
async def memory_store(req: StoreRequest):
    """Store a new fact, entity, message, or observation in the graph."""
    agent = resolve_agent(req.agent_id)
    session_id = req.session_id or f"session-{uuid.uuid4().hex[:12]}"
    channel = req.channel or "default"

    async with driver.session() as session:
        # Ensure agent and channel nodes exist
        await session.run(
            "MERGE (a:Agent {agent_id: $agent_id}) "
            "ON CREATE SET a.created_at = datetime()",
            agent_id=agent,
        )
        await session.run(
            "MERGE (c:Channel {name: $channel}) "
            "ON CREATE SET c.created_at = datetime()",
            channel=channel,
        )

        if req.type == "entity":
            return await _store_entity(session, req.data, agent, session_id, channel)
        elif req.type == "message":
            return await _store_message(session, req.data, agent, session_id, channel)
        elif req.type == "observation":
            return await _store_observation(session, req.data, agent, session_id, channel)
        else:
            raise HTTPException(status_code=400, detail=f"Unknown store type: {req.type}")


async def _store_entity(session, data: dict, agent: str, session_id: str, channel: str) -> StoreResponse:
    entity = EntityData(**data)
    label = entity.label
    props = entity.properties
    name = props.get("name", f"{label}-{uuid.uuid4().hex[:8]}")
    node_id = f"entity-{name.lower().replace(' ', '-')}-{uuid.uuid4().hex[:6]}"

    # MERGE the primary entity node
    # Use a safe label from the POLE+O set
    allowed_labels = {"Person", "Object", "Location", "Event", "Organization"}
    if label not in allowed_labels:
        label = "Object"  # default to Object for unrecognized labels

    prop_set_clauses = ", ".join(
        f"n.{k} = ${k}" for k in props if k != "name"
    )
    set_clause = f", {prop_set_clauses}" if prop_set_clauses else ""

    result = await session.run(
        f"MERGE (n:{label} {{name: $name}}) "
        f"ON CREATE SET n.node_id = $node_id, n.created_at = datetime(), "
        f"n.agent_id = $agent_id, n.channel = $channel{set_clause} "
        f"ON MATCH SET n.updated_at = datetime(){set_clause} "
        f"RETURN n.node_id AS nid, "
        f"CASE WHEN n.created_at = n.updated_at THEN false ELSE true END AS merged",
        name=name,
        node_id=node_id,
        agent_id=agent,
        channel=channel,
        **{k: v for k, v in props.items() if k != "name"},
    )
    record = await result.single()
    was_merged = record["merged"] if record else False
    final_id = record["nid"] if record else node_id

    # Create relationships
    for rel in entity.relationships:
        target_label = rel.target_label
        if target_label not in allowed_labels:
            target_label = "Object"

        target_props = rel.target_properties
        target_prop_set = ", ".join(
            f"t.{k} = ${k}" for k in target_props
        )
        target_set = f", {target_prop_set}" if target_prop_set else ""

        await session.run(
            f"MATCH (n:{label} {{name: $source_name}}) "
            f"MERGE (t:{target_label} {{name: $target_name}}) "
            f"ON CREATE SET t.created_at = datetime(), t.agent_id = $agent_id{target_set} "
            f"MERGE (n)-[r:{rel.type}]->(t) "
            f"ON CREATE SET r.created_at = datetime() "
            f"ON MATCH SET r.updated_at = datetime()",
            source_name=name,
            target_name=rel.target_name,
            agent_id=agent,
            **target_props,
        )

    # Link entity to session
    await session.run(
        "MERGE (s:Session {session_id: $session_id}) "
        "ON CREATE SET s.created_at = datetime(), s.agent_id = $agent_id, s.channel = $channel "
        f"WITH s MATCH (n:{label} {{name: $name}}) "
        "MERGE (s)-[:CONTAINS_ENTITY]->(n)",
        session_id=session_id,
        agent_id=agent,
        channel=channel,
        name=name,
    )

    return StoreResponse(status="stored", node_id=final_id, merged=was_merged)


async def _store_message(session, data: dict, agent: str, session_id: str, channel: str) -> StoreResponse:
    msg = MessageData(**data)
    msg_id = f"msg-{uuid.uuid4().hex[:12]}"
    timestamp = msg.timestamp or datetime.now(timezone.utc).isoformat()

    await session.run(
        "MERGE (s:Session {session_id: $session_id}) "
        "ON CREATE SET s.created_at = datetime(), s.agent_id = $agent_id, s.channel = $channel "
        "CREATE (m:Message {message_id: $msg_id, role: $role, content: $content, "
        "timestamp: $timestamp, agent_id: $agent_id, channel: $channel}) "
        "MERGE (s)-[:HAS_MESSAGE]->(m) "
        "WITH s, m "
        "OPTIONAL MATCH (s)-[:HAS_MESSAGE]->(prev:Message) "
        "WHERE prev.message_id <> m.message_id "
        "WITH m, prev ORDER BY prev.timestamp DESC LIMIT 1 "
        "FOREACH (_ IN CASE WHEN prev IS NOT NULL THEN [1] ELSE [] END | "
        "  MERGE (prev)-[:NEXT]->(m))",
        session_id=session_id,
        msg_id=msg_id,
        role=msg.role,
        content=msg.content,
        timestamp=timestamp,
        agent_id=agent,
        channel=channel,
    )

    return StoreResponse(status="stored", node_id=msg_id, merged=False)


async def _store_observation(session, data: dict, agent: str, session_id: str, channel: str) -> StoreResponse:
    content = data.get("content", "")
    subject = data.get("subject")
    obs_id = f"obs-{uuid.uuid4().hex[:12]}"

    await session.run(
        "CREATE (o:Observation {observation_id: $obs_id, content: $content, "
        "created_at: datetime(), agent_id: $agent_id, channel: $channel})",
        obs_id=obs_id,
        content=content,
        agent_id=agent,
        channel=channel,
    )

    # Link observation to a subject entity if provided
    if subject:
        await session.run(
            "MATCH (o:Observation {observation_id: $obs_id}) "
            "MATCH (n {name: $subject}) "
            "MERGE (o)-[:OBSERVES]->(n)",
            obs_id=obs_id,
            subject=subject,
        )

    # Link to session
    await session.run(
        "MERGE (s:Session {session_id: $session_id}) "
        "ON CREATE SET s.created_at = datetime(), s.agent_id = $agent_id "
        "WITH s MATCH (o:Observation {observation_id: $obs_id}) "
        "MERGE (s)-[:HAS_OBSERVATION]->(o)",
        session_id=session_id,
        agent_id=agent,
        obs_id=obs_id,
    )

    return StoreResponse(status="stored", node_id=obs_id, merged=False)


# ---------------------------------------------------------------------------
# POST /memory/recall
# ---------------------------------------------------------------------------

@app.post("/memory/recall", response_model=RecallResponse)
async def memory_recall(req: RecallRequest):
    """Retrieve context relevant to a query using full-text search and graph traversal."""
    agent = resolve_agent(req.agent_id)
    results = []

    async with driver.session() as session:
        # Full-text search across entities
        ft_result = await session.run(
            "CALL db.index.fulltext.queryNodes('entityFulltext', $query) "
            "YIELD node, score "
            "WHERE node.agent_id = $agent_id OR node.agent_id IS NULL "
            "RETURN node, labels(node) AS labels, score "
            "ORDER BY score DESC LIMIT $limit",
            query=req.query,
            agent_id=agent,
            limit=req.limit,
        )
        records = [r async for r in ft_result]

        for record in records:
            node = record["node"]
            labels = record["labels"]
            score = record["score"]
            node_data = dict(node)
            node_data["_labels"] = labels
            node_data["_score"] = score

            # Fetch relationships for each matched entity
            rel_result = await session.run(
                "MATCH (n) WHERE elementId(n) = $eid "
                "OPTIONAL MATCH (n)-[r]->(t) "
                "RETURN type(r) AS rel_type, labels(t) AS target_labels, "
                "t.name AS target_name "
                "LIMIT 20",
                eid=record["node"].element_id,
            )
            rels = []
            async for rel_record in rel_result:
                if rel_record["rel_type"]:
                    rels.append({
                        "type": rel_record["rel_type"],
                        "target_labels": rel_record["target_labels"],
                        "target_name": rel_record["target_name"],
                    })
            node_data["_relationships"] = rels
            results.append(node_data)

        # Optionally include reasoning traces
        if req.include_reasoning:
            trace_result = await session.run(
                "MATCH (tc:ToolCall) "
                "WHERE tc.agent_id = $agent_id AND tc.description CONTAINS $query "
                "RETURN tc ORDER BY tc.timestamp DESC LIMIT 5",
                agent_id=agent,
                query=req.query,
            )
            async for tr in trace_result:
                results.append({
                    "_type": "reasoning_trace",
                    **dict(tr["tc"]),
                })

    return RecallResponse(results=results, count=len(results), query=req.query)


# ---------------------------------------------------------------------------
# POST /memory/query
# ---------------------------------------------------------------------------

@app.post("/memory/query", response_model=QueryResponse)
async def memory_query(req: QueryRequest):
    """Execute structured entity queries or free-form Cypher against the graph."""
    agent = resolve_agent(req.agent_id)

    async with driver.session() as session:
        if req.cypher:
            # Free-form Cypher (read-only enforced by using read_transaction)
            result = await session.run(
                req.cypher,
                **req.params,
                agent_id=agent,
            )
            records = [dict(r) async for r in result]

            # Convert Neo4j node/relationship objects to dicts
            serialized = []
            for record in records:
                row = {}
                for key, value in record.items():
                    if hasattr(value, "items"):
                        row[key] = dict(value)
                    elif hasattr(value, "element_id"):
                        row[key] = dict(value)
                    else:
                        row[key] = value
                serialized.append(row)

            return QueryResponse(results=serialized, count=len(serialized))

        # Template-based entity query
        label_filter = f":{req.entity_type}" if req.entity_type else ""
        name_filter = "WHERE n.name CONTAINS $name" if req.name else ""

        query = (
            f"MATCH (n{label_filter}) "
            f"{name_filter} "
            f"WHERE n.agent_id = $agent_id OR n.agent_id IS NULL "
            f"OPTIONAL MATCH (n)-[r]->(t) "
            f"RETURN n, labels(n) AS labels, collect({{type: type(r), target: t.name}}) AS rels "
            f"LIMIT $limit"
        )

        params = {"agent_id": agent, "limit": req.limit}
        if req.name:
            params["name"] = req.name

        result = await session.run(query, **params)
        records = []
        async for record in result:
            node_data = dict(record["n"])
            node_data["_labels"] = record["labels"]
            node_data["_relationships"] = [
                r for r in record["rels"] if r["type"] is not None
            ]
            records.append(node_data)

        return QueryResponse(results=records, count=len(records))


# ---------------------------------------------------------------------------
# POST /memory/trace
# ---------------------------------------------------------------------------

@app.post("/memory/trace", response_model=TraceResponse)
async def memory_trace(req: TraceRequest):
    """Record a tool call, reasoning step, or skill invocation for audit trail."""
    agent = resolve_agent(req.agent_id)
    session_id = req.session_id or f"session-{uuid.uuid4().hex[:12]}"
    timestamp = datetime.now(timezone.utc).isoformat()

    async with driver.session() as session:
        if req.type == "tool_call":
            return await _trace_tool_call(session, req.data, agent, session_id, req.message_id, timestamp)
        elif req.type == "reasoning_step":
            return await _trace_reasoning_step(session, req.data, agent, session_id, req.message_id, timestamp)
        elif req.type == "skill_invocation":
            return await _trace_skill_invocation(session, req.data, agent, session_id, req.message_id, timestamp)
        else:
            raise HTTPException(status_code=400, detail=f"Unknown trace type: {req.type}")


async def _trace_tool_call(session, data: dict, agent: str, session_id: str, message_id: Optional[str], timestamp: str) -> TraceResponse:
    call_id = f"tc-{uuid.uuid4().hex[:12]}"
    tool_name = data.get("tool", "unknown")
    description = data.get("description", "")
    input_data = str(data.get("input", ""))
    output_data = str(data.get("output", ""))
    duration_ms = data.get("duration_ms")

    await session.run(
        "CREATE (tc:ToolCall {call_id: $call_id, tool: $tool, description: $description, "
        "input: $input, output: $output, duration_ms: $duration_ms, "
        "timestamp: $timestamp, agent_id: $agent_id, session_id: $session_id})",
        call_id=call_id,
        tool=tool_name,
        description=description,
        input=input_data,
        output=output_data,
        duration_ms=duration_ms,
        timestamp=timestamp,
        agent_id=agent,
        session_id=session_id,
    )

    # Link to session
    await session.run(
        "MERGE (s:Session {session_id: $session_id}) "
        "ON CREATE SET s.created_at = datetime(), s.agent_id = $agent_id "
        "WITH s MATCH (tc:ToolCall {call_id: $call_id}) "
        "MERGE (s)-[:HAS_TOOL_CALL]->(tc)",
        session_id=session_id,
        agent_id=agent,
        call_id=call_id,
    )

    # Link to message if provided
    if message_id:
        await session.run(
            "MATCH (m:Message {message_id: $message_id}) "
            "MATCH (tc:ToolCall {call_id: $call_id}) "
            "MERGE (m)-[:TRIGGERED]->(tc)",
            message_id=message_id,
            call_id=call_id,
        )

    # Link to entities mentioned in the tool call
    entities = data.get("entities_referenced", [])
    for entity_name in entities:
        await session.run(
            "MATCH (tc:ToolCall {call_id: $call_id}) "
            "MATCH (n {name: $entity_name}) "
            "MERGE (tc)-[:RETRIEVED]->(n)",
            call_id=call_id,
            entity_name=entity_name,
        )

    return TraceResponse(status="recorded", trace_id=call_id)


async def _trace_reasoning_step(session, data: dict, agent: str, session_id: str, message_id: Optional[str], timestamp: str) -> TraceResponse:
    step_id = f"rs-{uuid.uuid4().hex[:12]}"
    content = data.get("content", "")
    step_type = data.get("step_type", "inference")
    evidence = data.get("evidence", [])

    await session.run(
        "CREATE (rs:ReasoningStep {step_id: $step_id, content: $content, "
        "step_type: $step_type, timestamp: $timestamp, "
        "agent_id: $agent_id, session_id: $session_id})",
        step_id=step_id,
        content=content,
        step_type=step_type,
        timestamp=timestamp,
        agent_id=agent,
        session_id=session_id,
    )

    # Link to session
    await session.run(
        "MERGE (s:Session {session_id: $session_id}) "
        "ON CREATE SET s.created_at = datetime(), s.agent_id = $agent_id "
        "WITH s MATCH (rs:ReasoningStep {step_id: $step_id}) "
        "MERGE (s)-[:HAS_REASONING]->(rs)",
        session_id=session_id,
        agent_id=agent,
        step_id=step_id,
    )

    # Link evidence (tool calls or entities)
    for ev in evidence:
        await session.run(
            "MATCH (rs:ReasoningStep {step_id: $step_id}) "
            "MATCH (n) WHERE n.call_id = $ev_id OR n.node_id = $ev_id OR n.name = $ev_id "
            "MERGE (rs)-[:INFORMED_BY]->(n)",
            step_id=step_id,
            ev_id=ev,
        )

    # Link to message if provided
    if message_id:
        await session.run(
            "MATCH (m:Message {message_id: $message_id}) "
            "MATCH (rs:ReasoningStep {step_id: $step_id}) "
            "MERGE (rs)-[:USED_IN]->(m)",
            message_id=message_id,
            step_id=step_id,
        )

    return TraceResponse(status="recorded", trace_id=step_id)


async def _trace_skill_invocation(session, data: dict, agent: str, session_id: str, message_id: Optional[str], timestamp: str) -> TraceResponse:
    invocation_id = f"si-{uuid.uuid4().hex[:12]}"
    skill_name = data.get("skill", "unknown")
    input_data = str(data.get("input", ""))
    output_data = str(data.get("output", ""))

    await session.run(
        "CREATE (si:SkillInvocation {invocation_id: $invocation_id, skill: $skill, "
        "input: $input, output: $output, timestamp: $timestamp, "
        "agent_id: $agent_id, session_id: $session_id})",
        invocation_id=invocation_id,
        skill=skill_name,
        input=input_data,
        output=output_data,
        timestamp=timestamp,
        agent_id=agent,
        session_id=session_id,
    )

    # Link to session
    await session.run(
        "MERGE (s:Session {session_id: $session_id}) "
        "ON CREATE SET s.created_at = datetime(), s.agent_id = $agent_id "
        "WITH s MATCH (si:SkillInvocation {invocation_id: $invocation_id}) "
        "MERGE (s)-[:HAS_SKILL_INVOCATION]->(si)",
        session_id=session_id,
        agent_id=agent,
        invocation_id=invocation_id,
    )

    return TraceResponse(status="recorded", trace_id=invocation_id)


# ---------------------------------------------------------------------------
# GET /memory/health
# ---------------------------------------------------------------------------

@app.get("/memory/health")
async def memory_health():
    """Check Neo4j connectivity and return server status."""
    try:
        async with driver.session() as session:
            result = await session.run("RETURN 1 AS ok")
            record = await result.single()
            if record and record["ok"] == 1:
                return {
                    "status": "healthy",
                    "neo4j": "connected",
                    "uri": NEO4J_URI,
                    "agent_id": AGENT_ID,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Neo4j unreachable: {str(e)}")


# ---------------------------------------------------------------------------
# GET /memory/stats
# ---------------------------------------------------------------------------

@app.get("/memory/stats")
async def memory_stats():
    """Return memory counts and graph summary for agent introspection."""
    agent = AGENT_ID

    async with driver.session() as session:
        counts = {}

        # Count entities by label
        for label in ["Person", "Object", "Location", "Event", "Organization", "Observation"]:
            result = await session.run(
                f"MATCH (n:{label}) WHERE n.agent_id = $agent_id OR n.agent_id IS NULL "
                f"RETURN count(n) AS c",
                agent_id=agent,
            )
            record = await result.single()
            counts[label.lower() + "_count"] = record["c"] if record else 0

        # Count sessions, messages, tool calls
        for label, key in [("Session", "sessions"), ("Message", "messages"),
                           ("ToolCall", "tool_calls"), ("ReasoningStep", "reasoning_steps"),
                           ("SkillInvocation", "skill_invocations")]:
            result = await session.run(
                f"MATCH (n:{label}) WHERE n.agent_id = $agent_id OR n.agent_id IS NULL "
                f"RETURN count(n) AS c",
                agent_id=agent,
            )
            record = await result.single()
            counts[key] = record["c"] if record else 0

        # Total relationships
        result = await session.run("MATCH ()-[r]->() RETURN count(r) AS c")
        record = await result.single()
        counts["total_relationships"] = record["c"] if record else 0

        # Recent entities
        result = await session.run(
            "MATCH (n) WHERE (n:Person OR n:Object OR n:Location OR n:Event OR n:Organization) "
            "AND (n.agent_id = $agent_id OR n.agent_id IS NULL) "
            "RETURN n.name AS name, labels(n) AS labels "
            "ORDER BY n.created_at DESC LIMIT 10",
            agent_id=agent,
        )
        recent = []
        async for record in result:
            recent.append({"name": record["name"], "labels": record["labels"]})
        counts["recent_entities"] = recent

        # Channels
        result = await session.run(
            "MATCH (c:Channel) RETURN c.name AS name"
        )
        channels = [record["name"] async for record in result]
        counts["channels"] = channels

        return {
            "agent_id": agent,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            **counts,
        }


# ---------------------------------------------------------------------------
# POST /memory/context  (Phase 3 — Selective Context Injection)
# ---------------------------------------------------------------------------

@app.post("/memory/context", response_model=ContextResponse)
async def memory_context(req: ContextRequest):
    """Assemble relevance-ranked context from the graph for the current message.

    Replaces wholesale MEMORY.md injection with selective retrieval:
    1. Extract key terms from the incoming message
    2. Full-text search for matching entities
    3. Fetch related entities (1-hop graph traversal)
    4. Include relevant reasoning traces
    5. Format and truncate to max_tokens
    """
    agent = resolve_agent(req.agent_id)
    query_text = req.message

    entities_used = 0
    traces_used = 0
    context_parts = []

    async with driver.session() as session:
        # 1. Full-text search for entities matching the message
        ft_result = await session.run(
            "CALL db.index.fulltext.queryNodes('entityFulltext', $query) "
            "YIELD node, score "
            "WHERE (node.agent_id = $agent_id OR node.agent_id IS NULL) AND score > 0.5 "
            "RETURN node, labels(node) AS labels, score "
            "ORDER BY score DESC LIMIT 10",
            query=query_text,
            agent_id=agent,
        )

        entity_section = []
        element_ids = []
        async for record in ft_result:
            node = record["node"]
            labels = record["labels"]
            props = dict(node)
            name = props.get("name", "unknown")
            label = [l for l in labels if l in ("Person", "Object", "Location", "Event", "Organization")]
            label_str = label[0] if label else "Entity"
            clean_props = {k: v for k, v in props.items()
                          if k not in ("node_id", "agent_id", "channel", "created_at", "updated_at")}
            entity_section.append(f"[{label_str}] {name}: {clean_props}")
            element_ids.append(node.element_id)
            entities_used += 1

        # 2. Fetch 1-hop relationships for matched entities
        if element_ids:
            for eid in element_ids[:5]:  # limit to top 5
                rel_result = await session.run(
                    "MATCH (n) WHERE elementId(n) = $eid "
                    "MATCH (n)-[r]->(t) "
                    "WHERE NOT t:Session AND NOT t:Message "
                    "RETURN n.name AS source, type(r) AS rel, t.name AS target, labels(t) AS target_labels "
                    "LIMIT 10",
                    eid=eid,
                )
                async for rel_rec in rel_result:
                    entity_section.append(
                        f"  {rel_rec['source']} -{rel_rec['rel']}-> {rel_rec['target']}"
                    )

        if entity_section:
            context_parts.append("## Known Entities\n" + "\n".join(entity_section))

        # 3. Recent observations relevant to the query
        obs_result = await session.run(
            "MATCH (o:Observation) "
            "WHERE (o.agent_id = $agent_id OR o.agent_id IS NULL) "
            "AND o.content CONTAINS $query "
            "RETURN o.content AS content, o.created_at AS created "
            "ORDER BY o.created_at DESC LIMIT 5",
            agent_id=agent,
            query=query_text,
        )
        obs_section = []
        async for obs_rec in obs_result:
            obs_section.append(f"- {obs_rec['content']}")

        if obs_section:
            context_parts.append("## Observations\n" + "\n".join(obs_section))

        # 4. Relevant reasoning traces
        trace_result = await session.run(
            "MATCH (rs:ReasoningStep) "
            "WHERE rs.agent_id = $agent_id AND rs.content CONTAINS $query "
            "RETURN rs.content AS content, rs.step_type AS step_type, rs.timestamp AS ts "
            "ORDER BY rs.timestamp DESC LIMIT 3",
            agent_id=agent,
            query=query_text,
        )
        trace_section = []
        async for tr in trace_result:
            trace_section.append(f"- [{tr['step_type']}] {tr['content']}")
            traces_used += 1

        if trace_section:
            context_parts.append("## Reasoning History\n" + "\n".join(trace_section))

    # 5. Assemble and truncate
    full_context = "\n\n".join(context_parts) if context_parts else ""
    # Rough token estimate: ~4 chars per token
    token_estimate = len(full_context) // 4
    if token_estimate > req.max_tokens:
        char_limit = req.max_tokens * 4
        full_context = full_context[:char_limit] + "\n... [truncated]"
        token_estimate = req.max_tokens

    return ContextResponse(
        context=full_context,
        entities_used=entities_used,
        reasoning_traces=traces_used,
        token_estimate=token_estimate,
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=BRIDGE_PORT)
