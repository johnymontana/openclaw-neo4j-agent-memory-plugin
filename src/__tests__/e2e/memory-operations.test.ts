import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";

const plugin = require("../../../dist/index");

const BRIDGE_PORT = 17576;
const NEO4J_PORTS = {
  bolt: 18687,
  http: 18474,
  https: 18473,
};
const INSTANCE_NAME = `e2e-memory-${Date.now()}`;

function makeApi() {
  return {
    config: {
      plugins: {
        entries: {
          "openclaw-neo4j-memory": {
            config: {
              bridgePort: BRIDGE_PORT,
              agentId: "e2e-memory-test",
              instance: INSTANCE_NAME,
              neo4jPorts: NEO4J_PORTS,
              ephemeral: true,
            },
          },
        },
      },
    },
    logger: {
      info: (msg: string) => console.log(msg),
      warn: (msg: string) => console.warn(msg),
    },
    registerService: null as unknown as (service: {
      id: string;
      start: () => Promise<void>;
      stop: () => Promise<void>;
    }) => void,
  };
}

function httpPost(
  url: string,
  data: unknown
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const urlObj = new URL(url);
    const req = http.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          resolve({ statusCode: res.statusCode ?? 0, body })
        );
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function httpGet(url: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          resolve({ statusCode: res.statusCode ?? 0, body })
        );
      })
      .on("error", reject);
  });
}

const BASE = `http://localhost:${BRIDGE_PORT}`;

describe("Memory operations (e2e)", () => {
  let service: { start: () => Promise<void>; stop: () => Promise<void> } | null =
    null;

  beforeAll(async () => {
    const api = makeApi();
    api.registerService = (svc) => {
      service = svc;
    };
    plugin.register(api);
    await service!.start();
  });

  afterAll(async () => {
    if (service) {
      try {
        await service.stop();
      } catch {
        // best effort
      }
    }
  });

  // -------------------------------------------------------------------
  // Store: entity
  // -------------------------------------------------------------------

  it("stores an entity", async () => {
    const res = await httpPost(`${BASE}/memory/store`, {
      type: "entity",
      data: {
        label: "Person",
        properties: {
          name: "Alice",
          description: "Alice is a software engineer",
          role: "backend",
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("stored");
    expect(body.node_id).toBeDefined();
  });

  it("stores an entity with relationships", async () => {
    const res = await httpPost(`${BASE}/memory/store`, {
      type: "entity",
      data: {
        label: "Person",
        properties: {
          name: "Bob",
          description: "Bob is a project manager",
        },
        relationships: [
          {
            type: "WORKS_WITH",
            targetLabel: "Person",
            targetName: "Alice",
            targetProperties: {},
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("stored");
  });

  it("stores an Organization entity", async () => {
    const res = await httpPost(`${BASE}/memory/store`, {
      type: "entity",
      data: {
        label: "Organization",
        properties: {
          name: "Acme Corp",
          description: "A technology company",
          industry: "tech",
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("stored");
  });

  it("stores a Location entity", async () => {
    const res = await httpPost(`${BASE}/memory/store`, {
      type: "entity",
      data: {
        label: "Location",
        properties: {
          name: "San Francisco",
          description: "City in California",
        },
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it("stores an entity with relationship to organization", async () => {
    const res = await httpPost(`${BASE}/memory/store`, {
      type: "entity",
      data: {
        label: "Person",
        properties: {
          name: "Charlie",
          description: "Charlie is a designer",
        },
        relationships: [
          {
            type: "WORKS_AT",
            targetLabel: "Organization",
            targetName: "Acme Corp",
            targetProperties: {},
          },
          {
            type: "LIVES_IN",
            targetLabel: "Location",
            targetName: "San Francisco",
            targetProperties: {},
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
  });

  // -------------------------------------------------------------------
  // Store: message
  // -------------------------------------------------------------------

  it("stores a message", async () => {
    const res = await httpPost(`${BASE}/memory/store`, {
      type: "message",
      data: {
        role: "user",
        content: "Hello, can you help me with code review?",
      },
      session_id: "test-session-1",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("stored");
    expect(body.node_id).toBeDefined();
    expect(body.merged).toBe(false);
  });

  it("stores an assistant message", async () => {
    const res = await httpPost(`${BASE}/memory/store`, {
      type: "message",
      data: {
        role: "assistant",
        content: "Sure, I'd be happy to help with your code review.",
      },
      session_id: "test-session-1",
    });
    expect(res.statusCode).toBe(200);
  });

  // -------------------------------------------------------------------
  // Store: observation
  // -------------------------------------------------------------------

  it("stores an observation with subject", async () => {
    const res = await httpPost(`${BASE}/memory/store`, {
      type: "observation",
      data: {
        subject: "Alice",
        content: "Alice prefers TypeScript over JavaScript",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("stored");
  });

  it("stores an observation without subject", async () => {
    const res = await httpPost(`${BASE}/memory/store`, {
      type: "observation",
      data: {
        content: "The project uses vitest for testing",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("stored");
  });

  // -------------------------------------------------------------------
  // Store: error cases
  // -------------------------------------------------------------------

  it("rejects unknown store type", async () => {
    const res = await httpPost(`${BASE}/memory/store`, {
      type: "invalid_type",
      data: {},
    });
    expect(res.statusCode).toBe(400);
  });

  // -------------------------------------------------------------------
  // Recall
  // -------------------------------------------------------------------

  it("recalls the stored entity", async () => {
    const res = await httpPost(`${BASE}/memory/recall`, {
      query: "Alice",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.query).toBe("Alice");
    expect(body.results).toBeDefined();
    expect(body.count).toBeGreaterThanOrEqual(0);

    // The response should mention Alice somewhere
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).toContain("Alice");
  });

  it("recalls with limit parameter", async () => {
    const res = await httpPost(`${BASE}/memory/recall`, {
      query: "engineer",
      limit: 1,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results.length).toBeLessThanOrEqual(1);
  });

  it("recalls with include_reasoning flag", async () => {
    const res = await httpPost(`${BASE}/memory/recall`, {
      query: "Alice",
      include_reasoning: true,
      session_id: "test-session-1",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results).toBeDefined();
  });

  it("recall returns relationships in results", async () => {
    const res = await httpPost(`${BASE}/memory/recall`, {
      query: "Bob",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Results should include relationship data
    if (body.count > 0) {
      const bob = body.results.find(
        (r: Record<string, unknown>) => r.name === "Bob"
      );
      if (bob) {
        expect(bob).toHaveProperty("_relationships");
      }
    }
  });

  it("recall returns empty results for non-existent entity", async () => {
    const res = await httpPost(`${BASE}/memory/recall`, {
      query: "zzz_nonexistent_entity_12345",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.count).toBe(0);
    expect(body.results).toEqual([]);
  });

  // -------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------

  it("queries entities by type", async () => {
    const res = await httpPost(`${BASE}/memory/query`, {
      entity_type: "PERSON",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results).toBeDefined();
    expect(body.count).toBeGreaterThanOrEqual(0);
  });

  it("queries entities by name", async () => {
    const res = await httpPost(`${BASE}/memory/query`, {
      name: "Alice",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results).toBeDefined();

    const bodyStr = JSON.stringify(body);
    expect(bodyStr).toContain("Alice");
  });

  it("queries entities by type and name", async () => {
    const res = await httpPost(`${BASE}/memory/query`, {
      entity_type: "PERSON",
      name: "Alice",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results).toBeDefined();
  });

  it("queries with custom limit", async () => {
    const res = await httpPost(`${BASE}/memory/query`, {
      entity_type: "PERSON",
      limit: 2,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results.length).toBeLessThanOrEqual(2);
  });

  it("executes free-form Cypher query", async () => {
    const res = await httpPost(`${BASE}/memory/query`, {
      cypher: "MATCH (n) RETURN count(n) AS total",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.results).toBeDefined();
    expect(body.count).toBeGreaterThan(0);
    expect(body.results[0]).toHaveProperty("total");
  });

  // -------------------------------------------------------------------
  // Trace: tool_call
  // -------------------------------------------------------------------

  it("records a tool call trace", async () => {
    const res = await httpPost(`${BASE}/memory/trace`, {
      type: "tool_call",
      data: {
        tool: "grep",
        description: "Searching for function definitions",
        input: "function.*export",
        output: "Found 5 matches",
        duration_ms: 150,
      },
      session_id: "test-session-1",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("recorded");
    expect(body.trace_id).toBeDefined();
  });

  it("records a tool call trace with message_id", async () => {
    const res = await httpPost(`${BASE}/memory/trace`, {
      type: "tool_call",
      data: {
        tool: "read",
        description: "Reading file contents",
        input: "/src/index.ts",
        output: "file contents here",
      },
      session_id: "test-session-1",
      message_id: "msg-12345",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("recorded");
  });

  // -------------------------------------------------------------------
  // Trace: reasoning_step
  // -------------------------------------------------------------------

  it("records a reasoning step", async () => {
    const res = await httpPost(`${BASE}/memory/trace`, {
      type: "reasoning_step",
      data: {
        content: "Analyzing the codebase structure to identify entry points",
        step_type: "analysis",
      },
      session_id: "test-session-1",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("recorded");
    expect(body.trace_id).toBeDefined();
  });

  // -------------------------------------------------------------------
  // Trace: skill_invocation
  // -------------------------------------------------------------------

  it("records a skill invocation", async () => {
    const res = await httpPost(`${BASE}/memory/trace`, {
      type: "skill_invocation",
      data: {
        skill: "code-review",
        input: "Review the changes in PR #42",
        output: "Approved with 2 suggestions",
      },
      session_id: "test-session-1",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("recorded");
    expect(body.trace_id).toBeDefined();
  });

  // -------------------------------------------------------------------
  // Trace: error cases
  // -------------------------------------------------------------------

  it("rejects unknown trace type", async () => {
    const res = await httpPost(`${BASE}/memory/trace`, {
      type: "invalid_trace_type",
      data: {},
    });
    expect(res.statusCode).toBe(400);
  });

  // -------------------------------------------------------------------
  // Context
  // -------------------------------------------------------------------

  it("returns assembled context", async () => {
    const res = await httpPost(`${BASE}/memory/context`, {
      message: "Tell me about Alice",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("context");
    expect(body).toHaveProperty("entities_used");
    expect(body).toHaveProperty("reasoning_traces");
    expect(body).toHaveProperty("token_estimate");
    expect(typeof body.context).toBe("string");
    expect(typeof body.token_estimate).toBe("number");
  });

  it("respects max_tokens for context", async () => {
    const res = await httpPost(`${BASE}/memory/context`, {
      message: "Tell me everything",
      max_tokens: 10,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.token_estimate).toBeLessThanOrEqual(10);
  });

  it("returns context with session_id", async () => {
    const res = await httpPost(`${BASE}/memory/context`, {
      message: "What happened in our conversation?",
      session_id: "test-session-1",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.context).toBeDefined();
  });

  // -------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------

  it("health endpoint returns healthy status", async () => {
    const res = await httpGet(`${BASE}/memory/health`);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("healthy");
    expect(body.neo4j).toBe("connected");
    expect(body.agent_id).toBe("e2e-memory-test");
    expect(body.timestamp).toBeDefined();
  });

  // -------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------

  it("stats reflect stored data", async () => {
    const res = await httpGet(`${BASE}/memory/stats`);
    expect(res.statusCode).toBe(200);
    const stats = JSON.parse(res.body);
    expect(stats).toBeDefined();
    expect(stats.agent_id).toBe("e2e-memory-test");
    expect(stats.timestamp).toBeDefined();
  });
});
