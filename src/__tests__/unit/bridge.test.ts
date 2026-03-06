import { describe, it, expect, vi, beforeEach } from "vitest";
import { BridgeServer, type BridgeOptions } from "../../bridge";

let mockHttpGetHandler: (url: unknown, callback: unknown) => unknown;

// Mock node:http
vi.mock("node:http", () => ({
  get: vi.fn((url: unknown, callback: unknown) => {
    return mockHttpGetHandler(url, callback);
  }),
}));

// Event listener store for the mock child process
const processEventHandlers: Record<string, Array<(...args: unknown[]) => void>> = {};

function clearProcessEventHandlers() {
  for (const key of Object.keys(processEventHandlers)) {
    delete processEventHandlers[key];
  }
}

function emitProcessEvent(event: string, ...args: unknown[]) {
  for (const handler of processEventHandlers[event] ?? []) {
    handler(...args);
  }
}

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
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!processEventHandlers[event]) processEventHandlers[event] = [];
      processEventHandlers[event].push(handler);
    }),
    once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!processEventHandlers[event]) processEventHandlers[event] = [];
      processEventHandlers[event].push(handler);
    }),
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
    clearProcessEventHandlers();
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
        const cb = callback as (res: { statusCode: number; resume: () => void }) => void;
        cb({ statusCode: 200, resume: vi.fn() });
        return { on: vi.fn() };
      };

      await bridge.waitForHealth(5);
    });

    it("calls res.resume() to drain the response body", async () => {
      const bridge = new BridgeServer(makeOptions());
      const resumeSpy = vi.fn();

      mockHttpGetHandler = (_url: unknown, callback: unknown) => {
        const cb = callback as (res: { statusCode: number; resume: () => void }) => void;
        cb({ statusCode: 200, resume: resumeSpy });
        return { on: vi.fn() };
      };

      await bridge.waitForHealth(5);
      expect(resumeSpy).toHaveBeenCalled();
    });

    it("checks health immediately on first call", async () => {
      const bridge = new BridgeServer(makeOptions());
      let callCount = 0;

      mockHttpGetHandler = (_url: unknown, callback: unknown) => {
        callCount++;
        const cb = callback as (res: { statusCode: number; resume: () => void }) => void;
        cb({ statusCode: 200, resume: vi.fn() });
        return { on: vi.fn() };
      };

      await bridge.waitForHealth(5);
      // Should have been called at least once immediately (not waiting 1s)
      expect(callCount).toBe(1);
    });

    it("resolves on 200 after initial 503 responses", async () => {
      const bridge = new BridgeServer(makeOptions());
      let callCount = 0;

      mockHttpGetHandler = (_url: unknown, callback: unknown) => {
        callCount++;
        const cb = callback as (res: { statusCode: number; resume: () => void }) => void;
        // Return 503 on first two calls, then 200
        cb({ statusCode: callCount >= 3 ? 200 : 503, resume: vi.fn() });
        return { on: vi.fn() };
      };

      await bridge.waitForHealth(5);
      expect(callCount).toBeGreaterThanOrEqual(3);
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

    it("does not resolve after timeout even if late response arrives", async () => {
      const bridge = new BridgeServer(makeOptions());
      let savedCallback: ((res: { statusCode: number; resume: () => void }) => void) | null = null;

      mockHttpGetHandler = (_url: unknown, callback: unknown) => {
        // Capture callback but don't invoke it — simulates slow server
        savedCallback = callback as typeof savedCallback;
        return { on: vi.fn() };
      };

      const result = bridge.waitForHealth(1);

      await expect(result).rejects.toThrow("did not become healthy");

      // Now the late response arrives — should NOT cause issues
      if (savedCallback) {
        savedCallback({ statusCode: 200, resume: vi.fn() });
      }
    });
  });

  describe("early process exit", () => {
    it("rejects immediately when bridge process exits during health check", async () => {
      const bridge = new BridgeServer(makeOptions());

      // Health check never succeeds — server never responds
      mockHttpGetHandler = (_url: unknown, _callback: unknown) => {
        const req = {
          on: (_event: string, handler: (err: Error) => void) => {
            handler(new Error("ECONNREFUSED"));
            return req;
          },
        };
        return req;
      };

      const startPromise = bridge.start();

      // Simulate the child process crashing shortly after spawn
      setTimeout(() => {
        emitProcessEvent("close", 1);
      }, 50);

      await expect(startPromise).rejects.toThrow(
        "exited unexpectedly with code 1"
      );
    });
  });
});
