"""
OpenClaw Neo4j Agent Memory Bridge Server

A FastAPI service that bridges OpenClaw agent tool calls to a Neo4j graph database
using the neo4j-agent-memory package. Provides three-tier memory: short-term
(conversations), long-term (POLE+O entities), and reasoning (tool call traces).
"""

import os
import uuid
import time
import asyncio
import logging
from datetime import datetime, timezone
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from neo4j_agent_memory import (
    MemoryClient,
    MemorySettings,
    Neo4jConfig,
    EmbeddingConfig,
    EmbeddingProvider,
    ExtractionConfig,
    ExtractorType,
)

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
# MemoryClient lifecycle
# ---------------------------------------------------------------------------

memory: Optional[MemoryClient] = None


def _create_client() -> MemoryClient:
    """Create a MemoryClient with Neo4j config from environment."""
    settings = MemorySettings(
        neo4j=Neo4jConfig(
            uri=NEO4J_URI,
            username=NEO4J_USER,
            password=NEO4J_PASSWORD,
        ),
    )
    return MemoryClient(settings)


def _connect_with_retry(max_retries: int = 5, delay: float = 2.0):
    """Connect to Neo4j with retry logic for startup race conditions."""
    global memory
    last_error = None

    for attempt in range(1, max_retries + 1):
        try:
            memory = _create_client()
            memory.connect()
            logger.info("Connected to Neo4j at %s", NEO4J_URI)
            return
        except Exception as e:
            last_error = e
            if memory:
                try:
                    memory.close()
                except Exception:
                    pass
                memory = None
            if attempt < max_retries:
                logger.warning(
                    "Neo4j not ready (attempt %d/%d): %s — retrying in %.0fs",
                    attempt, max_retries, e, delay,
                )
                time.sleep(delay)
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
    await asyncio.to_thread(_connect_with_retry)
    yield
    if memory:
        memory.close()
        logger.info("Memory client closed")


app = FastAPI(
    title="OpenClaw Neo4j Memory Bridge",
    version="0.2.0",
    lifespan=lifespan,
)

# ---------------------------------------------------------------------------
# Request / Response models (backward-compatible)
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
# Helper
# ---------------------------------------------------------------------------

def resolve_agent(agent_id: Optional[str]) -> str:
    return agent_id or AGENT_ID


# Label mapping from bridge API to neo4j-agent-memory EntityType
LABEL_TO_ENTITY_TYPE = {
    "Person": "PERSON",
    "Organization": "ORGANIZATION",
    "Location": "LOCATION",
    "Event": "EVENT",
    "Object": "OBJECT",
}


# ---------------------------------------------------------------------------
# POST /memory/store
# ---------------------------------------------------------------------------

@app.post("/memory/store", response_model=StoreResponse)
async def memory_store(req: StoreRequest):
    """Store a new fact, entity, message, or observation in the graph."""
    session_id = req.session_id or f"session-{uuid.uuid4().hex[:12]}"

    if req.type == "entity":
        return await asyncio.to_thread(_store_entity, req.data, session_id)
    elif req.type == "message":
        return await asyncio.to_thread(_store_message, req.data, session_id)
    elif req.type == "observation":
        return await asyncio.to_thread(_store_observation, req.data, session_id)
    else:
        raise HTTPException(status_code=400, detail=f"Unknown store type: {req.type}")


def _store_entity(data: dict, session_id: str) -> StoreResponse:
    entity_data = EntityData(**data)
    props = entity_data.properties
    name = props.get("name", f"{entity_data.label}-{uuid.uuid4().hex[:8]}")
    description = props.get("description", "")
    entity_type = LABEL_TO_ENTITY_TYPE.get(entity_data.label, "OBJECT")

    # Build attributes from remaining properties
    attributes = {k: v for k, v in props.items() if k not in ("name", "description")}

    entity, dedup = memory.long_term.add_entity(
        name=name,
        entity_type=entity_type,
        description=description,
        attributes=attributes,
        generate_embedding=False,
        resolve=False,
        deduplicate=False,
        geocode=False,
        enrich=False,
    )

    node_id = str(entity.id)
    was_merged = dedup.is_duplicate if dedup else False

    # Create relationships
    for rel in entity_data.relationships:
        target_type = LABEL_TO_ENTITY_TYPE.get(rel.target_label, "OBJECT")
        target_entity, _ = memory.long_term.add_entity(
            name=rel.target_name,
            entity_type=target_type,
            attributes=rel.target_properties if rel.target_properties else None,
            generate_embedding=False,
            resolve=False,
            deduplicate=False,
            geocode=False,
            enrich=False,
        )
        memory.long_term.add_relationship(
            source=entity,
            target=target_entity,
            relationship_type=rel.type,
        )

    return StoreResponse(status="stored", node_id=node_id, merged=was_merged)


def _store_message(data: dict, session_id: str) -> StoreResponse:
    msg = MessageData(**data)
    result = memory.short_term.add_message(
        session_id=session_id,
        role=msg.role,
        content=msg.content,
        extract_entities=False,
        generate_embedding=False,
    )
    return StoreResponse(status="stored", node_id=str(result.id), merged=False)


def _store_observation(data: dict, session_id: str) -> StoreResponse:
    content = data.get("content", "")
    subject = data.get("subject")

    if subject:
        fact = memory.long_term.add_fact(
            subject=subject,
            predicate="observed",
            obj=content,
            generate_embedding=False,
        )
        return StoreResponse(status="stored", node_id=str(fact.id), merged=False)
    else:
        entity, dedup = memory.long_term.add_entity(
            name=f"observation-{uuid.uuid4().hex[:8]}",
            entity_type="OBJECT",
            description=content,
            generate_embedding=False,
            resolve=False,
            deduplicate=False,
            geocode=False,
            enrich=False,
        )
        return StoreResponse(status="stored", node_id=str(entity.id), merged=False)


# ---------------------------------------------------------------------------
# POST /memory/recall
# ---------------------------------------------------------------------------

@app.post("/memory/recall", response_model=RecallResponse)
async def memory_recall(req: RecallRequest):
    """Retrieve context relevant to a query."""

    def _recall():
        results = []

        entities = memory.long_term.search_entities(
            query=req.query,
            limit=req.limit,
            threshold=0.0,
        )

        for entity in entities:
            entity_dict = {
                "name": entity.name,
                "entity_type": entity.entity_type,
                "description": entity.description,
                "_labels": [entity.entity_type],
            }
            if entity.attributes:
                entity_dict.update(entity.attributes)

            # Get relationships
            try:
                related = memory.long_term.get_related_entities(entity)
                rels = []
                for related_entity, relationship in related:
                    rels.append({
                        "type": relationship.relationship_type,
                        "target_labels": [related_entity.entity_type],
                        "target_name": related_entity.name,
                    })
                entity_dict["_relationships"] = rels
            except Exception:
                entity_dict["_relationships"] = []

            results.append(entity_dict)

        if req.include_reasoning:
            try:
                traces = memory.reasoning.list_traces(
                    session_id=req.session_id,
                    limit=5,
                )
                for trace in traces:
                    results.append({
                        "_type": "reasoning_trace",
                        "task": trace.task,
                        "outcome": trace.outcome,
                        "success": trace.success,
                    })
            except Exception:
                pass

        return results

    results = await asyncio.to_thread(_recall)
    return RecallResponse(results=results, count=len(results), query=req.query)


# ---------------------------------------------------------------------------
# POST /memory/query
# ---------------------------------------------------------------------------

@app.post("/memory/query", response_model=QueryResponse)
async def memory_query(req: QueryRequest):
    """Execute structured entity queries or free-form Cypher."""

    def _query():
        if req.cypher:
            # Free-form Cypher via the underlying Neo4j driver
            graph_client = memory._graph
            with graph_client._driver.session() as session:
                result = session.run(req.cypher, **req.params)
                records = []
                for record in result:
                    row = {}
                    for key, value in record.items():
                        if hasattr(value, "items"):
                            row[key] = dict(value)
                        elif hasattr(value, "element_id"):
                            row[key] = dict(value)
                        else:
                            row[key] = value
                    records.append(row)
                return records

        # Template-based entity query
        entity_types = [req.entity_type] if req.entity_type else None
        if req.name:
            entities = memory.long_term.search_entities(
                query=req.name,
                entity_types=entity_types,
                limit=req.limit,
                threshold=0.0,
            )
        else:
            entities = memory.long_term.search_entities(
                query="*",
                entity_types=entity_types,
                limit=req.limit,
                threshold=0.0,
            )

        records = []
        for entity in entities:
            node_data = {
                "name": entity.name,
                "entity_type": entity.entity_type,
                "description": entity.description,
                "_labels": [entity.entity_type],
            }
            if entity.attributes:
                node_data.update(entity.attributes)

            try:
                related = memory.long_term.get_related_entities(entity)
                node_data["_relationships"] = [
                    {"type": r.relationship_type, "target": re.name}
                    for re, r in related
                    if r.relationship_type is not None
                ]
            except Exception:
                node_data["_relationships"] = []

            records.append(node_data)

        return records

    records = await asyncio.to_thread(_query)
    return QueryResponse(results=records, count=len(records))


# ---------------------------------------------------------------------------
# POST /memory/trace
# ---------------------------------------------------------------------------

@app.post("/memory/trace", response_model=TraceResponse)
async def memory_trace(req: TraceRequest):
    """Record a tool call, reasoning step, or skill invocation."""
    session_id = req.session_id or f"session-{uuid.uuid4().hex[:12]}"

    if req.type == "tool_call":
        return await asyncio.to_thread(_trace_tool_call, req.data, session_id, req.message_id)
    elif req.type == "reasoning_step":
        return await asyncio.to_thread(_trace_reasoning_step, req.data, session_id)
    elif req.type == "skill_invocation":
        return await asyncio.to_thread(_trace_skill_invocation, req.data, session_id)
    else:
        raise HTTPException(status_code=400, detail=f"Unknown trace type: {req.type}")


def _trace_tool_call(data: dict, session_id: str, message_id: Optional[str]) -> TraceResponse:
    tool_name = data.get("tool", "unknown")
    description = data.get("description", "")
    input_data = data.get("input", "")
    output_data = data.get("output", "")
    duration_ms = data.get("duration_ms")

    trace = memory.reasoning.start_trace(
        session_id=session_id,
        task=description or f"Tool call: {tool_name}",
        generate_embedding=False,
    )

    step = memory.reasoning.add_step(
        trace_id=trace.id,
        thought=f"Calling tool: {tool_name}",
        action=str(input_data),
        generate_embedding=False,
    )

    tool_call = memory.reasoning.record_tool_call(
        step_id=step.id,
        tool_name=tool_name,
        arguments={"input": input_data},
        result=output_data,
        duration_ms=duration_ms,
    )

    memory.reasoning.complete_trace(
        trace_id=trace.id,
        outcome=str(output_data)[:500] if output_data else None,
        success=True,
    )

    if message_id:
        try:
            memory.reasoning.link_trace_to_message(trace.id, message_id)
        except Exception:
            pass

    return TraceResponse(status="recorded", trace_id=str(trace.id))


def _trace_reasoning_step(data: dict, session_id: str) -> TraceResponse:
    content = data.get("content", "")
    step_type = data.get("step_type", "inference")

    trace = memory.reasoning.start_trace(
        session_id=session_id,
        task=f"Reasoning: {step_type}",
        generate_embedding=False,
    )

    memory.reasoning.add_step(
        trace_id=trace.id,
        thought=content,
        action=step_type,
        generate_embedding=False,
    )

    memory.reasoning.complete_trace(
        trace_id=trace.id,
        outcome=content[:500],
        success=True,
    )

    return TraceResponse(status="recorded", trace_id=str(trace.id))


def _trace_skill_invocation(data: dict, session_id: str) -> TraceResponse:
    skill_name = data.get("skill", "unknown")
    input_data = str(data.get("input", ""))
    output_data = str(data.get("output", ""))

    trace = memory.reasoning.start_trace(
        session_id=session_id,
        task=f"Skill: {skill_name}",
        generate_embedding=False,
    )

    step = memory.reasoning.add_step(
        trace_id=trace.id,
        thought=f"Invoking skill: {skill_name}",
        action=input_data,
        generate_embedding=False,
    )

    memory.reasoning.record_tool_call(
        step_id=step.id,
        tool_name=skill_name,
        arguments={"input": input_data},
        result=output_data,
    )

    memory.reasoning.complete_trace(
        trace_id=trace.id,
        outcome=output_data[:500] if output_data else None,
        success=True,
    )

    return TraceResponse(status="recorded", trace_id=str(trace.id))


# ---------------------------------------------------------------------------
# GET /memory/health
# ---------------------------------------------------------------------------

@app.get("/memory/health")
async def memory_health():
    """Check Neo4j connectivity and return server status."""
    try:
        stats = await asyncio.to_thread(memory.get_stats)
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
    """Return memory counts and graph summary."""
    try:
        stats = await asyncio.to_thread(memory.get_stats)
        return {
            "agent_id": AGENT_ID,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            **stats,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get stats: {str(e)}")


# ---------------------------------------------------------------------------
# POST /memory/context
# ---------------------------------------------------------------------------

@app.post("/memory/context", response_model=ContextResponse)
async def memory_context(req: ContextRequest):
    """Assemble relevance-ranked context from the graph."""

    def _get_context():
        context_str = memory.get_context(
            query=req.message,
            session_id=req.session_id,
            max_items=10,
        )
        return context_str

    context_str = await asyncio.to_thread(_get_context)

    token_estimate = len(context_str) // 4
    if token_estimate > req.max_tokens:
        char_limit = req.max_tokens * 4
        context_str = context_str[:char_limit] + "\n... [truncated]"
        token_estimate = req.max_tokens

    # Count sections for entities_used and reasoning_traces estimates
    entities_used = context_str.count("[") // 2 if context_str else 0
    reasoning_traces = context_str.lower().count("reasoning") if context_str else 0

    return ContextResponse(
        context=context_str,
        entities_used=entities_used,
        reasoning_traces=reasoning_traces,
        token_estimate=token_estimate,
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=BRIDGE_PORT)
