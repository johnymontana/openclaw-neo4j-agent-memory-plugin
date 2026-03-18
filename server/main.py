"""
OpenClaw Neo4j Agent Memory Bridge Server

A FastAPI service that bridges OpenClaw agent tool calls to a Neo4j graph database
using the neo4j-agent-memory package. Provides three-tier memory: short-term
(conversations), long-term (POLE+O entities), and reasoning (tool call traces).
"""

import os
import re
import json
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
ENTITY_PATH_PREFIX = "neo4j/entity/"

# ---------------------------------------------------------------------------
# MemoryClient lifecycle
# ---------------------------------------------------------------------------

memory: Optional[MemoryClient] = None


def _is_embedding_dependency_error(exc: Exception) -> bool:
    message = str(exc).lower()
    return (
        "openai package not installed" in message
        or "no module named 'openai'" in message
        or "embeddingerror" in type(exc).__name__.lower()
    )


def _sanitize_properties(properties: dict) -> dict:
    sanitized = {}
    for key, value in properties.items():
        key_lower = key.lower()
        if "embedding" in key_lower or "vector" in key_lower:
            continue
        if isinstance(value, list) and len(value) > 20:
            continue
        sanitized[key] = _make_json_safe(value)
    return sanitized


def _extract_metadata_attributes(metadata_value) -> dict:
    if metadata_value is None:
        return {}

    parsed = metadata_value
    if isinstance(metadata_value, str):
        try:
            parsed = json.loads(metadata_value)
        except Exception:
            return {}

    if isinstance(parsed, dict):
        attributes = parsed.get("attributes")
        if isinstance(attributes, dict):
            return _sanitize_properties(attributes)

    return {}


def _make_json_safe(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, list):
        return [_make_json_safe(item) for item in value]
    if isinstance(value, tuple):
        return [_make_json_safe(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _make_json_safe(item) for key, item in value.items()}
    if hasattr(value, "isoformat"):
        try:
            return value.isoformat()
        except Exception:
            pass
    return str(value)


READ_ONLY_CYPHER_PATTERN = re.compile(
    r"\b(create|merge|delete|detach|set|remove|drop|load\s+csv|start\s+database|stop\s+database)\b",
    re.IGNORECASE,
)


def _is_read_only_cypher(cypher: str) -> bool:
    normalized = " ".join((cypher or "").split())
    if not normalized:
        return False
    if READ_ONLY_CYPHER_PATTERN.search(normalized):
        return False
    if re.search(r"\bcall\s+dbms\b", normalized, re.IGNORECASE):
        return False
    if re.search(r"\bcall\s+apoc\.(periodic|refactor)\b", normalized, re.IGNORECASE):
        return False
    return True


def _normalize_candidate(value: str) -> str:
    candidate = re.sub(r"\s+", " ", value.strip())
    candidate = re.sub(r"^[^\w]+|[^\w]+$", "", candidate)
    candidate = re.sub(r"'s\b", "", candidate, flags=re.IGNORECASE)
    return candidate.strip()


def _extract_query_candidates(text: str) -> list[str]:
    if not text:
        return []

    candidates = []
    normalized = _normalize_candidate(text)
    if normalized:
        candidates.append(normalized)

    patterns = [
        r"(?i)(?:tell me about|what do you know about|what is|who is|who owns|show me everything connected to|without using prior conversation context[, ]*)(.+)",
        r"(?i)(?:about|for|regarding)\s+(.+)",
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            extracted = _normalize_candidate(match.group(1))
            if extracted:
                candidates.append(extracted)

    for quoted in re.findall(r'"([^"]+)"|\'([^\']+)\'', text):
        for value in quoted:
            candidate = _normalize_candidate(value)
            if candidate:
                candidates.append(candidate)

    for proper_noun_span in re.findall(r"(?:[A-Z][\w-]*)(?:\s+[A-Z][\w-]*)+", text):
        candidate = _normalize_candidate(proper_noun_span)
        if candidate:
            candidates.append(candidate)

    deduped = []
    seen = set()
    for candidate in candidates:
        lowered = candidate.lower()
        if lowered in seen or len(candidate) < 2:
            continue
        seen.add(lowered)
        deduped.append(candidate)

    return deduped[:5]


async def _fallback_search_records(query: str, limit: int) -> list[dict]:
    graph_client = memory.graph
    search_query = query.strip().lower()
    if not search_query:
        return []

    cypher = """
    MATCH (n)
    WHERE any(key IN keys(n)
      WHERE n[key] IS NOT NULL
        AND toLower(toString(n[key])) CONTAINS $query)
    OPTIONAL MATCH (n)-[r]-(m)
    WITH n,
         labels(n) AS labels,
         properties(n) AS props,
         elementId(n) AS element_id,
         collect(DISTINCT CASE
           WHEN r IS NULL OR m IS NULL THEN NULL
           ELSE {
             type: type(r),
             target_labels: labels(m),
             target_name: coalesce(m.name, m.title, m.subject, m.content, elementId(m))
           }
         END)[..5] AS raw_relationships
    RETURN labels,
           props,
           element_id,
           [rel IN raw_relationships WHERE rel IS NOT NULL] AS relationships
    LIMIT $limit
    """

    return await graph_client.execute_read(
        cypher,
        {"query": search_query, "limit": limit},
    )


async def _fallback_query_records(
    entity_type: Optional[str],
    name: Optional[str],
    limit: int,
) -> list[dict]:
    graph_client = memory.graph
    normalized_name = name.strip().lower() if name else None
    normalized_entity_type = entity_type.strip().upper() if entity_type else None

    cypher = """
    MATCH (n)
    WHERE ($entity_type IS NULL
           OR any(label IN labels(n) WHERE toUpper(label) = $entity_type)
           OR toUpper(coalesce(toString(n.entity_type), "")) = $entity_type)
      AND ($name IS NULL
           OR any(key IN keys(n)
                  WHERE n[key] IS NOT NULL
                    AND toLower(toString(n[key])) CONTAINS $name))
    OPTIONAL MATCH (n)-[r]-(m)
    WITH n,
         labels(n) AS labels,
         properties(n) AS props,
         elementId(n) AS element_id,
         collect(DISTINCT CASE
           WHEN r IS NULL OR m IS NULL THEN NULL
           ELSE {
             type: type(r),
             target_labels: labels(m),
             target_name: coalesce(m.name, m.title, m.subject, m.content, elementId(m))
           }
         END)[..5] AS raw_relationships
    RETURN labels,
           props,
           element_id,
           [rel IN raw_relationships WHERE rel IS NOT NULL] AS relationships
    LIMIT $limit
    """

    return await graph_client.execute_read(
        cypher,
        {
            "entity_type": normalized_entity_type,
            "name": normalized_name,
            "limit": limit,
        },
    )


def _record_to_recall_result(record: dict) -> dict:
    props = _sanitize_properties(record.get("props", {}))
    metadata_attributes = _extract_metadata_attributes(props.get("metadata"))
    if metadata_attributes:
        props.update({k: v for k, v in metadata_attributes.items() if k not in props})
    labels = [_make_json_safe(label) for label in record.get("labels", [])]

    entity_type = props.get("entity_type")
    if not entity_type:
        entity_type = next(
            (label for label in labels if label not in {"Entity", "Message", "Observation"}),
            labels[0] if labels else "Object",
        )

    name = (
        props.get("name")
        or props.get("title")
        or props.get("subject")
        or record.get("element_id")
        or "unknown"
    )
    description = props.get("description") or props.get("content") or ""
    attributes = {
        key: value
        for key, value in props.items()
        if key not in {"name", "title", "subject", "description", "content", "entity_type", "metadata"}
    }

    result = {
        "id": props.get("id") or record.get("element_id"),
        "graph_id": record.get("element_id"),
        "name": name,
        "entity_type": entity_type,
        "description": description,
        "attributes": attributes,
        "_labels": labels,
        "_relationships": _make_json_safe(record.get("relationships", [])),
    }

    for key, value in props.items():
        if key not in result:
            result[key] = value

    return result


def _entity_to_result(entity, related: list | None = None) -> dict:
    attributes = _sanitize_properties(entity.attributes or {})
    metadata_attributes = _extract_metadata_attributes(getattr(entity, "metadata", None))
    if metadata_attributes:
        attributes.update({k: v for k, v in metadata_attributes.items() if k not in attributes})
    result = {
        "id": str(entity.id),
        "graph_id": str(entity.id),
        "name": entity.name,
        "entity_type": entity.entity_type,
        "description": entity.description,
        "attributes": attributes,
        "_labels": ["Entity", entity.entity_type.title()],
        "_relationships": [],
    }

    if attributes:
        result.update(attributes)

    if related:
        result["_relationships"] = [
            {
                "type": relationship.relationship_type,
                "target_labels": [related_entity.entity_type],
                "target_name": related_entity.name,
            }
            for related_entity, relationship in related
        ]

    return _make_json_safe(result)


def _build_memory_document(result: dict, path: str) -> str:
    lines = [f"{result.get('name', 'unknown')} ({result.get('entity_type', 'Object')})"]

    description = result.get("description")
    if description:
        lines.append(str(description))

    attributes = result.get("attributes")
    if isinstance(attributes, dict) and attributes:
        rendered_attributes = [
            f"{key}: {value}"
            for key, value in attributes.items()
            if value not in (None, "", [], {})
        ]
        if rendered_attributes:
            lines.append("Attributes: " + "; ".join(rendered_attributes[:8]))

    relationships = result.get("_relationships") or []
    if isinstance(relationships, list) and relationships:
        lines.append("Relationships:")
        for relationship in relationships[:8]:
            rel_type = relationship.get("type")
            target_name = (
                relationship.get("target_name")
                or relationship.get("target")
                or relationship.get("targetName")
            )
            if rel_type and target_name:
                lines.append(f"- {rel_type} -> {target_name}")

    lines.append(f"Source: {path}")
    return "\n".join(lines)


def _slice_document_lines(text: str, from_line: int, max_lines: int) -> tuple[str, int]:
    lines = text.splitlines()
    total_lines = len(lines) if lines else 1
    start_index = max(from_line - 1, 0)
    end_index = min(start_index + max_lines, len(lines))
    sliced = "\n".join(lines[start_index:end_index]) if lines else text
    return sliced, total_lines


def _extract_id_from_path(path: str) -> Optional[str]:
    if not path.startswith(ENTITY_PATH_PREFIX):
        return None
    suffix = path[len(ENTITY_PATH_PREFIX):]
    uuid_match = re.match(
        r"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})",
        suffix,
    )
    if uuid_match:
        return uuid_match.group(1)
    return suffix.split("-", 1)[0] or None


async def _lookup_entity_record_by_id(identifier: str) -> Optional[dict]:
    records = await memory.graph.execute_read(
        """
        MATCH (n)
        WHERE coalesce(toString(n.id), "") = $identifier OR elementId(n) = $identifier
        OPTIONAL MATCH (n)-[r]-(m)
        WITH n,
             labels(n) AS labels,
             properties(n) AS props,
             elementId(n) AS element_id,
             collect(DISTINCT CASE
               WHEN r IS NULL OR m IS NULL THEN NULL
               ELSE {
                 type: type(r),
                 target_labels: labels(m),
                 target_name: coalesce(m.name, m.title, m.subject, m.content, elementId(m))
               }
             END)[..8] AS raw_relationships
        RETURN labels,
               props,
               element_id,
               [rel IN raw_relationships WHERE rel IS NOT NULL] AS relationships
        LIMIT 1
        """,
        {"identifier": identifier},
    )
    if not records:
        return None
    return _record_to_recall_result(records[0])


def _build_context_from_results(results: list[dict]) -> str:
    sections = []
    for index, result in enumerate(results, start=1):
        lines = [f"[{index}] {result.get('name', 'unknown')} ({result.get('entity_type', 'Object')})"]

        description = result.get("description")
        if description:
            lines.append(str(description))

        attributes = []
        for key, value in result.items():
            if key.startswith("_") or key in {"name", "entity_type", "description"}:
                continue
            attributes.append(f"{key}: {value}")
        if attributes:
            lines.append("Attributes: " + "; ".join(attributes[:5]))

        relationships = result.get("_relationships") or []
        if relationships:
            lines.append(
                "Related: "
                + "; ".join(
                    f"{rel['type']} -> {rel['target_name']}"
                    for rel in relationships[:5]
                    if rel.get("type") and rel.get("target_name")
                )
            )

        sections.append("\n".join(lines))

    return "\n\n".join(sections)


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


async def _connect_with_retry(max_retries: int = 12, delay: float = 2.0):
    """Connect to Neo4j with retry logic for startup race conditions."""
    global memory
    last_error = None

    for attempt in range(1, max_retries + 1):
        try:
            memory = _create_client()
            await memory.connect()
            logger.info("Connected to Neo4j at %s", NEO4J_URI)
            return
        except Exception as e:
            last_error = e
            if memory:
                try:
                    await memory.close()
                except Exception:
                    pass
                memory = None
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
    await _connect_with_retry()
    yield
    if memory:
        await memory.close()
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
    extract_entities: bool = False
    extract_relations: bool = False


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


class GetRequest(BaseModel):
    path: Optional[str] = None
    id: Optional[str] = None
    name: Optional[str] = None
    query: Optional[str] = None
    entity_type: Optional[str] = None
    from_line: int = 1
    lines: int = 20
    session_id: Optional[str] = None
    agent_id: Optional[str] = None


class GetResponse(BaseModel):
    path: str
    text: str
    from_line: int
    lines: int
    total_lines: int
    entity: Optional[dict] = None


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
        return await _store_entity(req.data, session_id)
    elif req.type == "message":
        return await _store_message(req.data, session_id)
    elif req.type == "observation":
        return await _store_observation(req.data, session_id)
    else:
        raise HTTPException(status_code=400, detail=f"Unknown store type: {req.type}")


async def _store_entity(data: dict, session_id: str) -> StoreResponse:
    entity_data = EntityData(**data)
    props = entity_data.properties
    name = props.get("name", f"{entity_data.label}-{uuid.uuid4().hex[:8]}")
    description = props.get("description", "")
    entity_type = LABEL_TO_ENTITY_TYPE.get(entity_data.label, "OBJECT")

    # Build attributes from remaining properties
    attributes = {k: v for k, v in props.items() if k not in ("name", "description")}

    entity, dedup = await memory.long_term.add_entity(
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
        target_entity, _ = await memory.long_term.add_entity(
            name=rel.target_name,
            entity_type=target_type,
            attributes=rel.target_properties if rel.target_properties else None,
            generate_embedding=False,
            resolve=False,
            deduplicate=False,
            geocode=False,
            enrich=False,
        )
        await memory.long_term.add_relationship(
            source=entity,
            target=target_entity,
            relationship_type=rel.type,
        )

    return StoreResponse(status="stored", node_id=node_id, merged=was_merged)


async def _store_message(data: dict, session_id: str) -> StoreResponse:
    msg = MessageData(**data)
    result = await memory.short_term.add_message(
        session_id=session_id,
        role=msg.role,
        content=msg.content,
        extract_entities=msg.extract_entities,
        extract_relations=msg.extract_relations,
        generate_embedding=False,
    )
    return StoreResponse(status="stored", node_id=str(result.id), merged=False)


async def _store_observation(data: dict, session_id: str) -> StoreResponse:
    content = data.get("content", "")
    subject = data.get("subject")

    if subject:
        fact = await memory.long_term.add_fact(
            subject=subject,
            predicate="observed",
            obj=content,
            generate_embedding=False,
        )
        return StoreResponse(status="stored", node_id=str(fact.id), merged=False)
    else:
        entity, dedup = await memory.long_term.add_entity(
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

    results = []
    candidates = _extract_query_candidates(req.query) or [req.query]

    try:
        seen_ids = set()
        for candidate in candidates:
            entities = await memory.long_term.search_entities(
                query=candidate,
                limit=req.limit,
                threshold=0.0,
            )
            for entity in entities:
                entity_id = str(entity.id)
                if entity_id in seen_ids:
                    continue
                seen_ids.add(entity_id)
                try:
                    related = await memory.long_term.get_related_entities(entity)
                except Exception:
                    related = []
                results.append(_entity_to_result(entity, related))
            if results:
                break

        if req.include_reasoning:
            try:
                traces = await memory.reasoning.list_traces(
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
    except Exception as exc:
        logger.warning("Recall falling back to direct graph search: %s", exc)
        for candidate in candidates:
            records = await _fallback_search_records(candidate, req.limit)
            if records:
                results = [_record_to_recall_result(record) for record in records]
                break

    return RecallResponse(results=results, count=len(results), query=req.query)


# ---------------------------------------------------------------------------
# POST /memory/query
# ---------------------------------------------------------------------------

@app.post("/memory/query", response_model=QueryResponse)
async def memory_query(req: QueryRequest):
    """Execute structured entity queries or free-form Cypher."""

    if req.cypher:
        if not _is_read_only_cypher(req.cypher):
            raise HTTPException(status_code=400, detail="Only read-only Cypher queries are allowed")
        records = await memory.graph.execute_read(req.cypher, req.params)
        safe_records = [_make_json_safe(record) for record in records]
        return QueryResponse(results=safe_records, count=len(safe_records))

    records = []
    try:
        entity_types = [req.entity_type] if req.entity_type else None
        if req.name:
            entities = await memory.long_term.search_entities(
                query=req.name,
                entity_types=entity_types,
                limit=req.limit,
                threshold=0.0,
            )
        else:
            entities = await memory.long_term.search_entities(
                query="*",
                entity_types=entity_types,
                limit=req.limit,
                threshold=0.0,
            )

        for entity in entities:
            try:
                related = await memory.long_term.get_related_entities(entity)
            except Exception:
                related = []

            node_data = _entity_to_result(entity, related)
            if isinstance(node_data.get("_relationships"), list):
                node_data["_relationships"] = [
                    {"type": relationship.get("type"), "target": relationship.get("target_name")}
                    for relationship in node_data["_relationships"]
                    if relationship.get("type")
                ]
            records.append(node_data)
    except Exception as exc:
        logger.warning("Query falling back to direct graph search: %s", exc)
        fallback_records = await _fallback_query_records(req.entity_type, req.name, req.limit)
        records = [_record_to_recall_result(record) for record in fallback_records]

    return QueryResponse(results=records, count=len(records))


# ---------------------------------------------------------------------------
# POST /memory/trace
# ---------------------------------------------------------------------------

@app.post("/memory/trace", response_model=TraceResponse)
async def memory_trace(req: TraceRequest):
    """Record a tool call, reasoning step, or skill invocation."""
    session_id = req.session_id or f"session-{uuid.uuid4().hex[:12]}"

    if req.type == "tool_call":
        return await _trace_tool_call(req.data, session_id, req.message_id)
    elif req.type == "reasoning_step":
        return await _trace_reasoning_step(req.data, session_id)
    elif req.type == "skill_invocation":
        return await _trace_skill_invocation(req.data, session_id)
    else:
        raise HTTPException(status_code=400, detail=f"Unknown trace type: {req.type}")


async def _trace_tool_call(data: dict, session_id: str, message_id: Optional[str]) -> TraceResponse:
    tool_name = data.get("tool", "unknown")
    description = data.get("description", "")
    input_data = data.get("input", "")
    output_data = data.get("output", "")
    duration_ms = data.get("duration_ms")

    trace = await memory.reasoning.start_trace(
        session_id=session_id,
        task=description or f"Tool call: {tool_name}",
        generate_embedding=False,
    )

    step = await memory.reasoning.add_step(
        trace_id=trace.id,
        thought=f"Calling tool: {tool_name}",
        action=str(input_data),
        generate_embedding=False,
    )

    await memory.reasoning.record_tool_call(
        step_id=step.id,
        tool_name=tool_name,
        arguments={"input": input_data},
        result=output_data,
        duration_ms=duration_ms,
    )

    await memory.reasoning.complete_trace(
        trace_id=trace.id,
        outcome=str(output_data)[:500] if output_data else None,
        success=True,
    )

    if message_id:
        try:
            await memory.reasoning.link_trace_to_message(trace.id, message_id)
        except Exception:
            pass

    return TraceResponse(status="recorded", trace_id=str(trace.id))


async def _trace_reasoning_step(data: dict, session_id: str) -> TraceResponse:
    content = data.get("content", "")
    step_type = data.get("step_type", "inference")

    trace = await memory.reasoning.start_trace(
        session_id=session_id,
        task=f"Reasoning: {step_type}",
        generate_embedding=False,
    )

    await memory.reasoning.add_step(
        trace_id=trace.id,
        thought=content,
        action=step_type,
        generate_embedding=False,
    )

    await memory.reasoning.complete_trace(
        trace_id=trace.id,
        outcome=content[:500],
        success=True,
    )

    return TraceResponse(status="recorded", trace_id=str(trace.id))


async def _trace_skill_invocation(data: dict, session_id: str) -> TraceResponse:
    skill_name = data.get("skill", "unknown")
    input_data = str(data.get("input", ""))
    output_data = str(data.get("output", ""))

    trace = await memory.reasoning.start_trace(
        session_id=session_id,
        task=f"Skill: {skill_name}",
        generate_embedding=False,
    )

    step = await memory.reasoning.add_step(
        trace_id=trace.id,
        thought=f"Invoking skill: {skill_name}",
        action=input_data,
        generate_embedding=False,
    )

    await memory.reasoning.record_tool_call(
        step_id=step.id,
        tool_name=skill_name,
        arguments={"input": input_data},
        result=output_data,
    )

    await memory.reasoning.complete_trace(
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
        stats = await memory.get_stats()
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
        stats = await memory.get_stats()
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
    candidates = _extract_query_candidates(req.message) or [req.message]
    context_str = ""

    try:
        for candidate in candidates:
            context_str = await memory.get_context(
                query=candidate,
                session_id=req.session_id,
                max_items=10,
            )
            if context_str.strip():
                break
    except Exception as exc:
        logger.warning("Context falling back to direct graph search: %s", exc)
        context_str = ""

    if not context_str.strip():
        for candidate in candidates:
            records = await _fallback_search_records(candidate, 10)
            if records:
                recall_results = [_record_to_recall_result(record) for record in records]
                context_str = _build_context_from_results(recall_results)
                break

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
# POST /memory/get
# ---------------------------------------------------------------------------


@app.post("/memory/get", response_model=GetResponse)
async def memory_get(req: GetRequest):
    """Return a fuller entity-centric memory document for a recall hit."""

    identifier = req.id or (_extract_id_from_path(req.path) if req.path else None)
    result = None

    if identifier:
        result = await _lookup_entity_record_by_id(identifier)

    if not result and req.name:
        query_records = await _fallback_query_records(req.entity_type, req.name, 1)
        if query_records:
            result = _record_to_recall_result(query_records[0])

    if not result and req.query:
        recall_records = await _fallback_search_records(req.query, 1)
        if recall_records:
            result = _record_to_recall_result(recall_records[0])

    if not result:
        raise HTTPException(status_code=404, detail="No matching Neo4j memory record found")

    path = req.path or f"{ENTITY_PATH_PREFIX}{result.get('id', result.get('graph_id', 'unknown'))}"
    full_text = _build_memory_document(result, path)
    sliced_text, total_lines = _slice_document_lines(full_text, req.from_line, req.lines)

    return GetResponse(
        path=path,
        text=sliced_text,
        from_line=req.from_line,
        lines=min(req.lines, total_lines),
        total_lines=total_lines,
        entity=_make_json_safe(result),
    )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=BRIDGE_PORT)
