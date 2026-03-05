#!/usr/bin/env python3
"""
MEMORY.md → Neo4j Migration Tool

Parses an existing OpenClaw MEMORY.md file and imports its contents into
the Neo4j graph as entities, observations, and relationships.

Usage:
    python tools/migrate_memory.py --memory-file /path/to/MEMORY.md
    python tools/migrate_memory.py --memory-file /path/to/MEMORY.md --bridge-url http://localhost:7474
    python tools/migrate_memory.py --memory-file /path/to/MEMORY.md --dry-run
"""

import argparse
import json
import re
import sys
from urllib.request import Request, urlopen
from urllib.error import URLError


def parse_memory_md(filepath: str) -> list[dict]:
    """Parse a MEMORY.md file into structured items.

    Handles common Markdown patterns:
    - Bullet points (-, *)
    - Headers (##, ###) as topic groupings
    - Key: value pairs
    - Freeform text paragraphs
    """
    items = []
    current_section = None

    with open(filepath, "r") as f:
        lines = f.readlines()

    for line in lines:
        line = line.rstrip()

        # Skip empty lines
        if not line.strip():
            continue

        # Headers become section context
        header_match = re.match(r"^(#{1,4})\s+(.+)", line)
        if header_match:
            current_section = header_match.group(2).strip()
            continue

        # Bullet points are individual facts
        bullet_match = re.match(r"^\s*[-*]\s+(.+)", line)
        if bullet_match:
            fact = bullet_match.group(1).strip()
            items.append({
                "content": fact,
                "section": current_section,
                "type": _classify_fact(fact),
            })
            continue

        # Non-empty, non-header, non-bullet lines are freeform observations
        if line.strip():
            items.append({
                "content": line.strip(),
                "section": current_section,
                "type": "observation",
            })

    return items


def _classify_fact(fact: str) -> str:
    """Heuristically classify a fact into entity type or observation."""
    fact_lower = fact.lower()

    # Person patterns
    person_patterns = [
        r"\b(works at|is a|role is|manager|engineer|developer|designer|ceo|cto)\b",
        r"\b(prefers|likes|dislikes|always|never)\b",
    ]
    for p in person_patterns:
        if re.search(p, fact_lower):
            return "person_fact"

    # Project/tool patterns
    project_patterns = [
        r"\b(project|repo|repository|codebase|stack|framework|library|tool|uses)\b",
    ]
    for p in project_patterns:
        if re.search(p, fact_lower):
            return "object_fact"

    # Location patterns
    if re.search(r"\b(located in|based in|office|city|country|timezone)\b", fact_lower):
        return "location_fact"

    # Event patterns
    if re.search(r"\b(meeting|conference|event|deadline|milestone|shipped|launched)\b", fact_lower):
        return "event_fact"

    return "observation"


def _extract_entity_name(fact: str) -> str | None:
    """Try to extract a named entity from a fact."""
    # Look for capitalized names (2+ words)
    name_match = re.search(r"([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)", fact)
    if name_match:
        return name_match.group(1)
    return None


def build_store_request(item: dict, session_id: str, channel: str) -> dict:
    """Convert a parsed item into a /memory/store request body."""
    fact_type = item["type"]
    content = item["content"]
    section = item.get("section")

    if fact_type == "observation" or fact_type == "person_fact":
        entity_name = _extract_entity_name(content)

        if entity_name and fact_type == "person_fact":
            return {
                "type": "entity",
                "data": {
                    "label": "Person",
                    "properties": {
                        "name": entity_name,
                        "description": content,
                        "source": "memory_md_migration",
                    },
                    "relationships": [],
                },
                "session_id": session_id,
                "channel": channel,
            }

        return {
            "type": "observation",
            "data": {
                "content": content,
                "subject": entity_name,
            },
            "session_id": session_id,
            "channel": channel,
        }

    if fact_type == "object_fact":
        entity_name = _extract_entity_name(content)
        return {
            "type": "entity",
            "data": {
                "label": "Object",
                "properties": {
                    "name": entity_name or (section or "Unknown"),
                    "description": content,
                    "source": "memory_md_migration",
                },
                "relationships": [],
            },
            "session_id": session_id,
            "channel": channel,
        }

    if fact_type == "location_fact":
        entity_name = _extract_entity_name(content)
        return {
            "type": "entity",
            "data": {
                "label": "Location",
                "properties": {
                    "name": entity_name or (section or "Unknown"),
                    "description": content,
                    "source": "memory_md_migration",
                },
                "relationships": [],
            },
            "session_id": session_id,
            "channel": channel,
        }

    if fact_type == "event_fact":
        entity_name = _extract_entity_name(content)
        return {
            "type": "entity",
            "data": {
                "label": "Event",
                "properties": {
                    "name": entity_name or (section or "Unknown Event"),
                    "description": content,
                    "source": "memory_md_migration",
                },
                "relationships": [],
            },
            "session_id": session_id,
            "channel": channel,
        }

    # Fallback: observation
    return {
        "type": "observation",
        "data": {"content": content},
        "session_id": session_id,
        "channel": channel,
    }


def send_to_bridge(url: str, payload: dict) -> dict:
    """POST a store request to the bridge server."""
    data = json.dumps(payload).encode("utf-8")
    req = Request(
        f"{url}/memory/store",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    parser = argparse.ArgumentParser(
        description="Migrate MEMORY.md to Neo4j graph memory"
    )
    parser.add_argument(
        "--memory-file", required=True, help="Path to MEMORY.md file"
    )
    parser.add_argument(
        "--bridge-url",
        default="http://localhost:7474",
        help="Bridge server URL (default: http://localhost:7474)",
    )
    parser.add_argument(
        "--session-id",
        default="migration",
        help="Session ID for migrated items (default: migration)",
    )
    parser.add_argument(
        "--channel",
        default="markdown",
        help="Channel tag for migrated items (default: markdown)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Parse and display items without sending to Neo4j",
    )
    args = parser.parse_args()

    print(f"Parsing {args.memory_file}...")
    items = parse_memory_md(args.memory_file)
    print(f"Found {len(items)} items to migrate\n")

    if not items:
        print("No items found in MEMORY.md. Nothing to migrate.")
        return

    # Summary by type
    type_counts = {}
    for item in items:
        t = item["type"]
        type_counts[t] = type_counts.get(t, 0) + 1
    print("Item breakdown:")
    for t, count in sorted(type_counts.items()):
        print(f"  {t}: {count}")
    print()

    if args.dry_run:
        print("=== DRY RUN — showing parsed items ===\n")
        for i, item in enumerate(items, 1):
            req = build_store_request(item, args.session_id, args.channel)
            print(f"[{i}] {item['type']}: {item['content'][:80]}")
            print(f"    → {req['type']}: {json.dumps(req['data'], indent=2)[:200]}")
            print()
        print(f"Dry run complete. {len(items)} items would be migrated.")
        return

    # Check bridge server health
    try:
        req = Request(f"{args.bridge_url}/memory/health")
        with urlopen(req) as resp:
            health = json.loads(resp.read().decode("utf-8"))
            print(f"Bridge server healthy: {health['neo4j']}")
    except URLError as e:
        print(f"ERROR: Cannot reach bridge server at {args.bridge_url}")
        print(f"  {e}")
        print("  Start the bridge server first: server/start.sh")
        sys.exit(1)

    # Migrate items
    success = 0
    errors = 0
    for i, item in enumerate(items, 1):
        payload = build_store_request(item, args.session_id, args.channel)
        try:
            result = send_to_bridge(args.bridge_url, payload)
            status = "merged" if result.get("merged") else "created"
            print(f"  [{i}/{len(items)}] {status}: {item['content'][:60]}")
            success += 1
        except Exception as e:
            print(f"  [{i}/{len(items)}] ERROR: {e}")
            errors += 1

    print(f"\nMigration complete: {success} succeeded, {errors} failed")


if __name__ == "__main__":
    main()
