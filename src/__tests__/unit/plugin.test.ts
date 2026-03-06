import { describe, it, expect, vi, beforeEach } from "vitest";
import { PLUGIN_ID, SERVICE_ID } from "../../config";

// Mock Neo4jLocal
vi.mock("@johnymontana/neo4j-local", () => ({
  Neo4jLocal: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue({
      uri: "bolt://localhost:7687",
      username: "neo4j",
      password: "test-password",
    }),
    stop: vi.fn().mockResolvedValue(undefined),
    getCredentials: vi.fn().mockReturnValue({
      uri: "bolt://localhost:7687",
      username: "neo4j",
      password: "test-password",
    }),
  })),
}));

// Mock the bridge module
vi.mock("../../bridge", () => ({
  BridgeServer: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getPid: vi.fn().mockReturnValue(12345),
  })),
}));

describe("plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exports correct id and name", async () => {
    const plugin = (await import("../../index")).default ?? await import("../../index");
    expect(plugin.id).toBe(PLUGIN_ID);
    expect(plugin.name).toBe("Neo4j Memory");
  });

  it("register() calls api.registerService with correct id", async () => {
    const plugin = (await import("../../index")).default ?? await import("../../index");
    const registerService = vi.fn();
    const api = {
      config: { plugins: { entries: {} } },
      logger: { info: vi.fn(), warn: vi.fn() },
      registerService,
    };

    plugin.register(api);

    expect(registerService).toHaveBeenCalledOnce();
    expect(registerService).toHaveBeenCalledWith(
      expect.objectContaining({
        id: SERVICE_ID,
        start: expect.any(Function),
        stop: expect.any(Function),
      })
    );
  });

  it("start handler creates Neo4jLocal and BridgeServer", async () => {
    const { Neo4jLocal } = await import("@johnymontana/neo4j-local");
    const { BridgeServer } = await import("../../bridge");
    const plugin = (await import("../../index")).default ?? await import("../../index");

    const registerService = vi.fn();
    const api = {
      config: { plugins: { entries: {} } },
      logger: { info: vi.fn(), warn: vi.fn() },
      registerService,
    };

    plugin.register(api);
    const service = registerService.mock.calls[0][0];
    await service.start();

    expect(Neo4jLocal).toHaveBeenCalledWith(
      expect.objectContaining({ instanceName: "openclaw-memory" })
    );
    expect(BridgeServer).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgePort: 7575,
        agentId: "default",
        neo4jUri: "bolt://localhost:7687",
        neo4jUser: "neo4j",
        neo4jPassword: "test-password",
      })
    );
  });

  it("stop handler stops bridge and neo4j", async () => {
    const plugin = (await import("../../index")).default ?? await import("../../index");

    const registerService = vi.fn();
    const api = {
      config: { plugins: { entries: {} } },
      logger: { info: vi.fn(), warn: vi.fn() },
      registerService,
    };

    plugin.register(api);
    const service = registerService.mock.calls[0][0];

    // Start first so instances exist
    await service.start();
    // Then stop
    await service.stop();

    // Should not throw
    expect(api.logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("Failed to stop")
    );
  });
});
