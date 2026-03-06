import { describe, it, expect, vi, beforeEach } from "vitest";
import { BridgeServer, type BridgeOptions } from "../../bridge";

let mockHttpGetHandler: (url: unknown, callback: unknown) => unknown;

// Mock node:http
vi.mock("node:http", () => ({
  get: vi.fn((url: unknown, callback: unknown) => {
    return mockHttpGetHandler(url, callback);
  }),
}));

// Mock child_process
vi.mock("node:child_process", () => {
  const mockProcess = {
    pid: 12345,
    stdout: {
      on: vi.fn(),
    },
    stderr: {
      on: vi.fn(),
    },
    on: vi.fn(),
    unref: vi.fn(),
  };

  return {
    spawn: vi.fn(() => mockProcess),
    execFileSync: vi.fn((cmd: string, args: string[]) => {
      // Simulate python version check
      if (args?.[0] === "-c" && args[1]?.includes("version_info")) {
        return "3.11\n";
      }
      // Simulate checking if deps are installed
      if (args?.[0] === "-c" && args[1]?.includes("import fastapi")) {
        return "";
      }
      return "";
    }),
  };
});

// Mock fs
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true), // venv exists
}));

function makeOptions(overrides?: Partial<BridgeOptions>): BridgeOptions {
  return {
    bridgePort: 7575,
    agentId: "test",
    neo4jUri: "bolt://localhost:7687",
    neo4jUser: "neo4j",
    neo4jPassword: "password",
    logger: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
}

describe("BridgeServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("can be constructed with options", () => {
    const bridge = new BridgeServer(makeOptions());
    expect(bridge).toBeDefined();
    expect(bridge.getPid()).toBeNull();
  });

  it("returns PID after start", async () => {
    const bridge = new BridgeServer(makeOptions());

    // Mock waitForHealth to resolve immediately
    vi.spyOn(bridge, "waitForHealth").mockResolvedValue();

    await bridge.start();
    expect(bridge.getPid()).toBe(12345);
  });

  it("logs startup message", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const bridge = new BridgeServer(makeOptions({ logger }));
    vi.spyOn(bridge, "waitForHealth").mockResolvedValue();

    await bridge.start();

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Bridge server started")
    );
  });

  it("stop is safe to call when not started", async () => {
    const bridge = new BridgeServer(makeOptions());
    // Should not throw
    await bridge.stop();
  });

  describe("waitForHealth", () => {
    it("resolves when server responds 200", async () => {
      const bridge = new BridgeServer(makeOptions());

      mockHttpGetHandler = (_url: unknown, callback: unknown) => {
        const cb = callback as (res: { statusCode: number }) => void;
        cb({ statusCode: 200 });
        return { on: vi.fn() };
      };

      await bridge.waitForHealth(5);
    });

    it("rejects after timeout when server never responds", async () => {
      const bridge = new BridgeServer(makeOptions({ bridgePort: 19999 }));

      mockHttpGetHandler = (_url: unknown, _callback: unknown) => {
        const req = {
          on: (_event: string, handler: (err: Error) => void) => {
            handler(new Error("ECONNREFUSED"));
            return req;
          },
        };
        return req;
      };

      await expect(bridge.waitForHealth(1)).rejects.toThrow(
        "did not become healthy"
      );
    });
  });
});
