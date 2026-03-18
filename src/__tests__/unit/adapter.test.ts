import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerNeo4jHooks, registerNeo4jTools } from "../../adapter";
import type { OpenClawApi } from "../../config";

const bridgeMocks = vi.hoisted(() => ({
  recall: vi.fn(),
  get: vi.fn(),
  context: vi.fn(),
  store: vi.fn(),
  trace: vi.fn(),
  query: vi.fn(),
}));

vi.mock("../../bridge-client", () => ({
  BridgeClient: vi.fn().mockImplementation(() => bridgeMocks),
}));

function makeApi(config: Record<string, unknown> = {}): OpenClawApi & {
  registerTool: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
} {
  return {
    pluginConfig: config,
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    registerService: vi.fn(),
    registerTool: vi.fn(),
    on: vi.fn(),
  };
}

describe("adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bridgeMocks.recall.mockResolvedValue({
      query: "Alice",
      count: 1,
      results: [
        {
          id: "entity-1",
          name: "Alice",
          entity_type: "PERSON",
          description: "Platform engineer",
          attributes: { team: "Platform" },
          _relationships: [{ type: "WORKS_AT", target_name: "Acme" }],
        },
      ],
    });
    bridgeMocks.get.mockResolvedValue({
      path: "neo4j/entity/entity-1-alice",
      text: "Alice (PERSON)\nPlatform engineer",
      from_line: 1,
      lines: 2,
      total_lines: 2,
      entity: { id: "entity-1", name: "Alice" },
    });
    bridgeMocks.context.mockResolvedValue({
      context: "[1] Alice (Person)\nAttributes: team: Platform",
      entities_used: 1,
      reasoning_traces: 0,
      token_estimate: 12,
    });
    bridgeMocks.store.mockResolvedValue({ status: "stored", node_id: "msg-1", merged: false });
    bridgeMocks.trace.mockResolvedValue({ status: "recorded", trace_id: "trace-1" });
    bridgeMocks.query.mockResolvedValue({ count: 1, results: [{ total: 1 }] });
  });

  it("registers native memory tools through a factory", async () => {
    const api = makeApi();
    registerNeo4jTools(api);

    expect(api.registerTool).toHaveBeenCalledOnce();
    const [factory] = api.registerTool.mock.calls[0];
    const tools = factory({ sessionId: "session-1", agentId: "agent-1" });

    expect(Array.isArray(tools)).toBe(true);
    const names = tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain("memory_search");
    expect(names).toContain("memory_get");
    expect(names).toContain("entity_lookup");
    expect(names).toContain("graph_query");
  });

  it("memory_search executes through the bridge client", async () => {
    const api = makeApi();
    registerNeo4jTools(api);

    const [factory] = api.registerTool.mock.calls[0];
    const tools = factory({ sessionId: "session-1", agentId: "agent-1" });
    const memorySearch = tools.find((tool: { name: string }) => tool.name === "memory_search");

    const result = await memorySearch.execute("tool-1", { query: "Alice" });
    expect(bridgeMocks.recall).toHaveBeenCalledWith("Alice", {
      sessionId: "session-1",
      agentId: "agent-1",
      channel: undefined,
      limit: 5,
    });
    expect(result.content[0].text).toContain("Alice");
    expect(result.details?.count).toBe(1);
  });

  it("before_prompt_build injects Neo4j context when autoRecall is enabled", async () => {
    const api = makeApi({ autoRecall: true });
    registerNeo4jHooks(api);

    const hook = api.on.mock.calls.find(([name]) => name === "before_prompt_build")?.[1];
    expect(hook).toBeTypeOf("function");

    const result = await hook(
      { prompt: "Tell me about Alice", messages: [] },
      { sessionId: "session-1", agentId: "agent-1" }
    );

    expect(bridgeMocks.context).toHaveBeenCalledWith("Tell me about Alice", {
      sessionId: "session-1",
      agentId: "agent-1",
    });
    expect(result.prependContext).toContain("<neo4j-memory-context>");
  });

  it("agent_end auto-captures user messages when enabled", async () => {
    const api = makeApi({ autoCapture: true });
    registerNeo4jHooks(api);

    const hook = api.on.mock.calls.find(([name]) => name === "agent_end")?.[1];
    expect(hook).toBeTypeOf("function");

    await hook(
      {
        success: true,
        messages: [
          { role: "user", content: "Remember that Alice owns Project Larkspur." },
          { role: "assistant", content: "Stored." },
        ],
      },
      { sessionId: "session-1", agentId: "agent-1", channelId: "webchat" }
    );

    expect(bridgeMocks.store).toHaveBeenCalledWith(
      "message",
      expect.objectContaining({
        role: "user",
        content: "Remember that Alice owns Project Larkspur.",
        extract_entities: true,
      }),
      {
        sessionId: "session-1",
        agentId: "agent-1",
        channel: "webchat",
      }
    );
  });
});
