import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PLUGIN_ID, SERVICE_ID } from "../../config";

let mockHttpResponses: Array<number | Error> = [];

vi.mock("node:http", () => ({
  request: vi.fn((...args: unknown[]) => {
    const callback = args[args.length - 1] as (res: {
      statusCode?: number;
      resume: () => void;
    }) => void;
    let errorHandler: ((error: Error) => void) | undefined;

    const req = {
      on: vi.fn((event: string, handler: (error: Error) => void) => {
        if (event === "error") {
          errorHandler = handler;
        }
        return req;
      }),
      setTimeout: vi.fn((_timeout: number, _handler: () => void) => req),
      write: vi.fn(),
      end: vi.fn(() => {
        const response = mockHttpResponses.shift() ?? 200;
        if (response instanceof Error) {
          errorHandler?.(response);
          return;
        }

        callback({ statusCode: response, resume: vi.fn() });
      }),
      destroy: vi.fn((error?: Error) => {
        if (error) {
          errorHandler?.(error);
        }
      }),
    };

    return req;
  }),
}));

// Capture mock instances for assertions
let mockNeo4jLocalInstance: {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  getCredentials: ReturnType<typeof vi.fn>;
};

let mockBridgeInstance: {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  getPid: ReturnType<typeof vi.fn>;
};

// Mock Neo4jLocal
vi.mock("@johnymontana/neo4j-local", () => ({
  Neo4jLocal: vi.fn().mockImplementation(() => {
    mockNeo4jLocalInstance = {
      start: vi.fn().mockResolvedValue({
        uri: "bolt://localhost:7687",
        username: "neo4j",
        password: "test-password",
        httpUrl: "http://localhost:7474",
      }),
      stop: vi.fn().mockResolvedValue(undefined),
      reset: vi.fn().mockResolvedValue(undefined),
      getCredentials: vi.fn().mockReturnValue({
        uri: "bolt://localhost:7687",
        username: "neo4j",
        password: "test-password",
        httpUrl: "http://localhost:7474",
      }),
    };
    return mockNeo4jLocalInstance;
  }),
}));

// Mock the bridge module
vi.mock("../../bridge", () => ({
  BridgeServer: vi.fn().mockImplementation(() => {
    mockBridgeInstance = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getPid: vi.fn().mockReturnValue(12345),
    };
    return mockBridgeInstance;
  }),
}));

function makeApi(configOverrides?: Record<string, unknown>) {
  return {
    config: {
      plugins: {
        entries: configOverrides
          ? { "openclaw-neo4j-memory": { config: configOverrides } }
          : {},
      },
    },
    logger: { info: vi.fn(), warn: vi.fn() },
    registerService: vi.fn(),
  };
}

describe("plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHttpResponses = [200];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exports correct id and name", async () => {
    const plugin = (await import("../../index")).default ?? await import("../../index");
    expect(plugin.id).toBe(PLUGIN_ID);
    expect(plugin.name).toBe("Neo4j Memory");
  });

  it("register() calls api.registerService with correct id", async () => {
    const plugin = (await import("../../index")).default ?? await import("../../index");
    const api = makeApi();

    plugin.register(api);

    expect(api.registerService).toHaveBeenCalledOnce();
    expect(api.registerService).toHaveBeenCalledWith(
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

    const api = makeApi();

    plugin.register(api);
    const service = api.registerService.mock.calls[0][0];
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

  it("start handler uses custom config values", async () => {
    const { Neo4jLocal } = await import("@johnymontana/neo4j-local");
    const { BridgeServer } = await import("../../bridge");
    const plugin = (await import("../../index")).default ?? await import("../../index");

    const api = makeApi({
      bridgePort: 9999,
      agentId: "custom-agent",
      instance: "my-neo4j",
      neo4jPorts: { bolt: 17687, http: 17474, https: 17473 },
      ephemeral: true,
    });

    plugin.register(api);
    const service = api.registerService.mock.calls[0][0];
    await service.start();

    expect(Neo4jLocal).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceName: "my-neo4j",
        ports: { bolt: 17687, http: 17474, https: 17473 },
        ephemeral: true,
      })
    );
    expect(BridgeServer).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgePort: 9999,
        agentId: "custom-agent",
      })
    );
  });

  it("resets the managed instance when Neo4j rejects generated credentials", async () => {
    const { BridgeServer } = await import("../../bridge");
    const { Neo4jLocal } = await import("@johnymontana/neo4j-local");
    const plugin = (await import("../../index")).default ?? await import("../../index");

    const neo4jCtor = Neo4jLocal as ReturnType<typeof vi.fn>;
    neo4jCtor.mockImplementationOnce(() => {
      mockNeo4jLocalInstance = {
        start: vi
          .fn()
          .mockResolvedValueOnce({
            uri: "bolt://localhost:7687",
            username: "neo4j",
            password: "stale-password",
            httpUrl: "http://localhost:7474",
          })
          .mockResolvedValueOnce({
            uri: "bolt://localhost:7687",
            username: "neo4j",
            password: "fresh-password",
            httpUrl: "http://localhost:7474",
          }),
        stop: vi.fn().mockResolvedValue(undefined),
        reset: vi.fn().mockResolvedValue(undefined),
        getCredentials: vi.fn(),
      };
      return mockNeo4jLocalInstance;
    });

    mockHttpResponses = [401, 200];

    const api = makeApi();
    plugin.register(api);
    const service = api.registerService.mock.calls[0][0];

    await service.start();

    expect(mockNeo4jLocalInstance.reset).toHaveBeenCalledOnce();
    expect(mockNeo4jLocalInstance.start).toHaveBeenCalledTimes(2);
    expect(BridgeServer).toHaveBeenCalledWith(
      expect.objectContaining({
        neo4jPassword: "fresh-password",
      })
    );
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("resetting the Neo4j data directory")
    );
  });

  it("waits for recovered credentials to clear transient auth rate limits", async () => {
    vi.useFakeTimers();

    const { BridgeServer } = await import("../../bridge");
    const { Neo4jLocal } = await import("@johnymontana/neo4j-local");
    const plugin = (await import("../../index")).default ?? await import("../../index");

    const neo4jCtor = Neo4jLocal as ReturnType<typeof vi.fn>;
    neo4jCtor.mockImplementationOnce(() => {
      mockNeo4jLocalInstance = {
        start: vi
          .fn()
          .mockResolvedValueOnce({
            uri: "bolt://localhost:7687",
            username: "neo4j",
            password: "stale-password",
            httpUrl: "http://localhost:7474",
          })
          .mockResolvedValueOnce({
            uri: "bolt://localhost:7687",
            username: "neo4j",
            password: "fresh-password",
            httpUrl: "http://localhost:7474",
          }),
        stop: vi.fn().mockResolvedValue(undefined),
        reset: vi.fn().mockResolvedValue(undefined),
        getCredentials: vi.fn(),
      };
      return mockNeo4jLocalInstance;
    });

    mockHttpResponses = [401, 429, 429, 200];

    const api = makeApi();
    plugin.register(api);
    const service = api.registerService.mock.calls[0][0];

    const startPromise = service.start();
    await vi.runAllTimersAsync();
    await startPromise;

    expect(mockNeo4jLocalInstance.reset).toHaveBeenCalledOnce();
    expect(mockNeo4jLocalInstance.start).toHaveBeenCalledTimes(2);
    expect(BridgeServer).toHaveBeenCalledWith(
      expect.objectContaining({
        neo4jPassword: "fresh-password",
      })
    );
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Neo4j auth probe returned HTTP 429")
    );
  });

  it("stop handler stops bridge and neo4j", async () => {
    const plugin = (await import("../../index")).default ?? await import("../../index");

    const api = makeApi();

    plugin.register(api);
    const service = api.registerService.mock.calls[0][0];

    // Start first so instances exist
    await service.start();
    // Then stop
    await service.stop();

    expect(mockBridgeInstance.stop).toHaveBeenCalled();
    expect(mockNeo4jLocalInstance.stop).toHaveBeenCalled();
  });

  it("stop handler stops bridge before neo4j", async () => {
    const plugin = (await import("../../index")).default ?? await import("../../index");
    const api = makeApi();
    const callOrder: string[] = [];

    plugin.register(api);
    const service = api.registerService.mock.calls[0][0];
    await service.start();

    // Track call order
    mockBridgeInstance.stop.mockImplementation(async () => {
      callOrder.push("bridge");
    });
    mockNeo4jLocalInstance.stop.mockImplementation(async () => {
      callOrder.push("neo4j");
    });

    await service.stop();

    expect(callOrder).toEqual(["bridge", "neo4j"]);
  });

  it("stop is safe to call without start", async () => {
    const plugin = (await import("../../index")).default ?? await import("../../index");
    const api = makeApi();

    plugin.register(api);
    const service = api.registerService.mock.calls[0][0];

    // Should not throw
    await service.stop();
  });

  it("stop continues even if bridge stop fails", async () => {
    const plugin = (await import("../../index")).default ?? await import("../../index");
    const api = makeApi();

    plugin.register(api);
    const service = api.registerService.mock.calls[0][0];
    await service.start();

    // Make bridge stop fail
    mockBridgeInstance.stop.mockRejectedValue(new Error("bridge crash"));

    await service.stop();

    // Neo4j should still be stopped
    expect(mockNeo4jLocalInstance.stop).toHaveBeenCalled();
    // Should log the warning
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to stop bridge")
    );
  });

  it("stop logs warning if neo4j stop fails", async () => {
    const plugin = (await import("../../index")).default ?? await import("../../index");
    const api = makeApi();

    plugin.register(api);
    const service = api.registerService.mock.calls[0][0];
    await service.start();

    // Make neo4j stop fail
    mockNeo4jLocalInstance.stop.mockRejectedValue(new Error("neo4j crash"));

    await service.stop();

    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to stop Neo4j")
    );
  });

  it("start handler logs neo4j running message", async () => {
    const plugin = (await import("../../index")).default ?? await import("../../index");
    const api = makeApi();

    plugin.register(api);
    const service = api.registerService.mock.calls[0][0];
    await service.start();

    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Neo4j running at")
    );
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Bridge server healthy")
    );
  });

  it("start propagates neo4j start failure", async () => {
    const { Neo4jLocal } = await import("@johnymontana/neo4j-local");
    (Neo4jLocal as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      start: vi.fn().mockRejectedValue(new Error("Neo4j download failed")),
      stop: vi.fn(),
    }));

    const plugin = (await import("../../index")).default ?? await import("../../index");
    const api = makeApi();

    plugin.register(api);
    const service = api.registerService.mock.calls[0][0];

    await expect(service.start()).rejects.toThrow("Neo4j download failed");
  });

  it("start propagates bridge start failure", async () => {
    const { BridgeServer } = await import("../../bridge");
    (BridgeServer as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      start: vi.fn().mockRejectedValue(new Error("Bridge health check failed")),
      stop: vi.fn(),
    }));

    const plugin = (await import("../../index")).default ?? await import("../../index");
    const api = makeApi();

    plugin.register(api);
    const service = api.registerService.mock.calls[0][0];

    await expect(service.start()).rejects.toThrow("Bridge health check failed");
  });
});
