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

// Track stdout/stderr event handlers for pipeLines testing
let stdoutHandlers: Record<string, Array<(...args: unknown[]) => void>> = {};
let stderrHandlers: Record<string, Array<(...args: unknown[]) => void>> = {};

function clearStreamHandlers() {
  stdoutHandlers = {};
  stderrHandlers = {};
}

// Track what execFileSync is called with
let execFileSyncBehavior: (cmd: string, args: string[]) => string = () => "";

// Track whether fs.existsSync returns true or false
let venvExists = true;

// Mock child_process
vi.mock("node:child_process", () => {
  const mockProcess = {
    pid: 12345,
    stdout: {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (!stdoutHandlers[event]) stdoutHandlers[event] = [];
        stdoutHandlers[event].push(handler);
      }),
    },
    stderr: {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (!stderrHandlers[event]) stderrHandlers[event] = [];
        stderrHandlers[event].push(handler);
      }),
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
      return execFileSyncBehavior(cmd, args);
    }),
  };
});

// Mock fs
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => venvExists),
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
    clearStreamHandlers();
    venvExists = true;
    execFileSyncBehavior = (cmd: string, args: string[]) => {
      if (args?.[0] === "-c" && args[1]?.includes("version_info")) {
        return "3.11\n";
      }
      if (args?.[0] === "-c" && args[1]?.includes("import fastapi")) {
        return "";
      }
      return "";
    };
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

  it("logs the python version being used", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const bridge = new BridgeServer(makeOptions({ logger }));
    vi.spyOn(bridge, "waitForHealth").mockResolvedValue();

    await bridge.start();

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Using python3.12")
    );
  });

  it("stop is safe to call when not started", async () => {
    const bridge = new BridgeServer(makeOptions());
    // Should not throw
    await bridge.stop();
  });

  describe("findPython", () => {
    it("throws when no suitable python is found", async () => {
      execFileSyncBehavior = () => {
        throw new Error("command not found");
      };

      const bridge = new BridgeServer(makeOptions());
      vi.spyOn(bridge, "waitForHealth").mockResolvedValue();

      await expect(bridge.start()).rejects.toThrow("Python >= 3.10 is required");
    });

    it("rejects python versions below 3.10", async () => {
      execFileSyncBehavior = (_cmd: string, args: string[]) => {
        if (args?.[0] === "-c" && args[1]?.includes("version_info")) {
          return "3.8\n";
        }
        return "";
      };

      const bridge = new BridgeServer(makeOptions());
      vi.spyOn(bridge, "waitForHealth").mockResolvedValue();

      await expect(bridge.start()).rejects.toThrow("Python >= 3.10 is required");
    });

    it("accepts python 3.10 exactly", async () => {
      execFileSyncBehavior = (cmd: string, args: string[]) => {
        if (args?.[0] === "-c" && args[1]?.includes("version_info")) {
          return "3.10\n";
        }
        if (args?.[0] === "-c" && args[1]?.includes("import fastapi")) {
          return "";
        }
        return "";
      };

      const bridge = new BridgeServer(makeOptions());
      vi.spyOn(bridge, "waitForHealth").mockResolvedValue();

      await bridge.start();
      expect(bridge.getPid()).toBe(12345);
    });

    it("accepts python 4.x (major version > 3)", async () => {
      execFileSyncBehavior = (cmd: string, args: string[]) => {
        if (args?.[0] === "-c" && args[1]?.includes("version_info")) {
          return "4.0\n";
        }
        if (args?.[0] === "-c" && args[1]?.includes("import fastapi")) {
          return "";
        }
        return "";
      };

      const bridge = new BridgeServer(makeOptions());
      vi.spyOn(bridge, "waitForHealth").mockResolvedValue();

      await bridge.start();
      expect(bridge.getPid()).toBe(12345);
    });
  });

  describe("ensureVenv", () => {
    it("creates venv when it does not exist", async () => {
      const { execFileSync } = await import("node:child_process");
      venvExists = false;

      const logger = { info: vi.fn(), warn: vi.fn() };
      const bridge = new BridgeServer(makeOptions({ logger }));
      vi.spyOn(bridge, "waitForHealth").mockResolvedValue();

      await bridge.start();

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Creating virtualenv")
      );
      // execFileSync should have been called with -m venv
      expect(execFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(["-m", "venv"]),
        expect.any(Object)
      );
    });

    it("skips venv creation when it already exists", async () => {
      const logger = { info: vi.fn(), warn: vi.fn() };
      const bridge = new BridgeServer(makeOptions({ logger }));
      vi.spyOn(bridge, "waitForHealth").mockResolvedValue();

      await bridge.start();

      expect(logger.info).not.toHaveBeenCalledWith(
        expect.stringContaining("Creating virtualenv")
      );
    });
  });

  describe("installDependencies", () => {
    it("installs deps when import check fails", async () => {
      const { execFileSync } = await import("node:child_process");
      let importCheckCalled = false;

      execFileSyncBehavior = (cmd: string, args: string[]) => {
        if (args?.[0] === "-c" && args[1]?.includes("version_info")) {
          return "3.11\n";
        }
        if (args?.[0] === "-c" && args[1]?.includes("import fastapi")) {
          if (!importCheckCalled) {
            importCheckCalled = true;
            throw new Error("ModuleNotFoundError");
          }
          return "";
        }
        return "";
      };

      const logger = { info: vi.fn(), warn: vi.fn() };
      const bridge = new BridgeServer(makeOptions({ logger }));
      vi.spyOn(bridge, "waitForHealth").mockResolvedValue();

      await bridge.start();

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Installing Python dependencies")
      );
      // pip install --upgrade pip
      expect(execFileSync).toHaveBeenCalledWith(
        expect.stringContaining("pip"),
        expect.arrayContaining(["install", "--upgrade", "pip"]),
        expect.any(Object)
      );
      // pip install -r requirements.txt
      expect(execFileSync).toHaveBeenCalledWith(
        expect.stringContaining("pip"),
        expect.arrayContaining(["install", "-r"]),
        expect.any(Object)
      );
    });

    it("skips install when deps are already present", async () => {
      const logger = { info: vi.fn(), warn: vi.fn() };
      const bridge = new BridgeServer(makeOptions({ logger }));
      vi.spyOn(bridge, "waitForHealth").mockResolvedValue();

      await bridge.start();

      expect(logger.info).not.toHaveBeenCalledWith(
        expect.stringContaining("Installing Python dependencies")
      );
    });
  });

  describe("pipeLines", () => {
    it("pipes stdout lines to logger.info", async () => {
      const logger = { info: vi.fn(), warn: vi.fn() };
      const bridge = new BridgeServer(makeOptions({ logger }));
      vi.spyOn(bridge, "waitForHealth").mockResolvedValue();

      await bridge.start();

      // Simulate stdout data
      const dataHandlers = stdoutHandlers["data"] ?? [];
      expect(dataHandlers.length).toBeGreaterThan(0);

      dataHandlers[0](Buffer.from("hello world\n"));
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("hello world")
      );
    });

    it("pipes stderr lines to logger.warn", async () => {
      const logger = { info: vi.fn(), warn: vi.fn() };
      const bridge = new BridgeServer(makeOptions({ logger }));
      vi.spyOn(bridge, "waitForHealth").mockResolvedValue();

      await bridge.start();

      const dataHandlers = stderrHandlers["data"] ?? [];
      expect(dataHandlers.length).toBeGreaterThan(0);

      dataHandlers[0](Buffer.from("warning message\n"));
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("warning message")
      );
    });

    it("handles multiple lines in a single chunk", async () => {
      const logger = { info: vi.fn(), warn: vi.fn() };
      const bridge = new BridgeServer(makeOptions({ logger }));
      vi.spyOn(bridge, "waitForHealth").mockResolvedValue();

      await bridge.start();

      const dataHandlers = stdoutHandlers["data"] ?? [];
      dataHandlers[0](Buffer.from("line 1\nline 2\nline 3\n"));

      const infoCalls = logger.info.mock.calls
        .map((c: string[]) => c[0])
        .filter((msg: string) => msg.includes("line"));
      expect(infoCalls).toHaveLength(3);
    });

    it("handles split chunks (partial lines across data events)", async () => {
      const logger = { info: vi.fn(), warn: vi.fn() };
      const bridge = new BridgeServer(makeOptions({ logger }));
      vi.spyOn(bridge, "waitForHealth").mockResolvedValue();

      await bridge.start();

      const dataHandlers = stdoutHandlers["data"] ?? [];
      // Send partial line
      dataHandlers[0](Buffer.from("partial li"));
      // No complete line yet - should not have logged "partial li"
      const partialCalls = logger.info.mock.calls
        .map((c: string[]) => c[0])
        .filter((msg: string) => msg.includes("partial line complete"));
      expect(partialCalls).toHaveLength(0);

      // Complete the line
      dataHandlers[0](Buffer.from("ne complete\n"));
      const completeCalls = logger.info.mock.calls
        .map((c: string[]) => c[0])
        .filter((msg: string) => msg.includes("partial line complete"));
      expect(completeCalls).toHaveLength(1);
    });

    it("flushes remaining buffer on stream end", async () => {
      const logger = { info: vi.fn(), warn: vi.fn() };
      const bridge = new BridgeServer(makeOptions({ logger }));
      vi.spyOn(bridge, "waitForHealth").mockResolvedValue();

      await bridge.start();

      const dataHandlers = stdoutHandlers["data"] ?? [];
      const endHandlers = stdoutHandlers["end"] ?? [];

      // Send data without trailing newline
      dataHandlers[0](Buffer.from("no newline at end"));
      // Trigger stream end
      endHandlers[0]();

      const calls = logger.info.mock.calls
        .map((c: string[]) => c[0])
        .filter((msg: string) => msg.includes("no newline at end"));
      expect(calls).toHaveLength(1);
    });

    it("skips empty lines", async () => {
      const logger = { info: vi.fn(), warn: vi.fn() };
      const bridge = new BridgeServer(makeOptions({ logger }));
      vi.spyOn(bridge, "waitForHealth").mockResolvedValue();

      await bridge.start();

      // Clear startup log calls
      logger.info.mockClear();

      const dataHandlers = stdoutHandlers["data"] ?? [];
      dataHandlers[0](Buffer.from("   \n\n  \n"));

      // Empty/whitespace-only lines should be skipped
      expect(logger.info).not.toHaveBeenCalled();
    });
  });

  describe("spawn configuration", () => {
    it("passes environment variables to child process", async () => {
      const { spawn } = await import("node:child_process");
      const bridge = new BridgeServer(makeOptions({
        bridgePort: 9999,
        agentId: "my-agent",
        neo4jUri: "bolt://db:7687",
        neo4jUser: "admin",
        neo4jPassword: "secret123",
      }));
      vi.spyOn(bridge, "waitForHealth").mockResolvedValue();

      await bridge.start();

      expect(spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({
            AGENT_ID: "my-agent",
            BRIDGE_PORT: "9999",
            NEO4J_URI: "bolt://db:7687",
            NEO4J_USER: "admin",
            NEO4J_PASSWORD: "secret123",
          }),
        })
      );
    });

    it("spawns with detached mode and unref", async () => {
      const { spawn } = await import("node:child_process");
      const bridge = new BridgeServer(makeOptions());
      vi.spyOn(bridge, "waitForHealth").mockResolvedValue();

      await bridge.start();

      expect(spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ detached: true })
      );

      const mockProc = (spawn as ReturnType<typeof vi.fn>).mock.results[0].value;
      expect(mockProc.unref).toHaveBeenCalled();
    });
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

    it("uses correct URL with configured port", async () => {
      const bridge = new BridgeServer(makeOptions({ bridgePort: 8888 }));
      let capturedUrl: string | null = null;

      mockHttpGetHandler = (url: unknown, callback: unknown) => {
        capturedUrl = url as string;
        const cb = callback as (res: { statusCode: number; resume: () => void }) => void;
        cb({ statusCode: 200, resume: vi.fn() });
        return { on: vi.fn() };
      };

      await bridge.waitForHealth(5);
      expect(capturedUrl).toBe("http://localhost:8888/memory/health");
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

    it("resolves on 200 after initial connection errors", async () => {
      const bridge = new BridgeServer(makeOptions());
      let callCount = 0;

      mockHttpGetHandler = (_url: unknown, callback: unknown) => {
        callCount++;
        if (callCount < 3) {
          // Simulate connection refused
          const req = {
            on: (_event: string, handler: (err: Error) => void) => {
              handler(new Error("ECONNREFUSED"));
              return req;
            },
          };
          return req;
        }
        // Then succeed
        const cb = callback as (res: { statusCode: number; resume: () => void }) => void;
        cb({ statusCode: 200, resume: vi.fn() });
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

    it("includes exit code in error message", async () => {
      const bridge = new BridgeServer(makeOptions());

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

      setTimeout(() => {
        emitProcessEvent("close", 127);
      }, 50);

      await expect(startPromise).rejects.toThrow("code 127");
    });

    it("handles null exit code", async () => {
      const bridge = new BridgeServer(makeOptions());

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

      setTimeout(() => {
        emitProcessEvent("close", null);
      }, 50);

      await expect(startPromise).rejects.toThrow("code unknown");
    });
  });

  describe("process error handling", () => {
    it("logs process spawn errors via logger.warn", async () => {
      const logger = { info: vi.fn(), warn: vi.fn() };
      const bridge = new BridgeServer(makeOptions({ logger }));
      vi.spyOn(bridge, "waitForHealth").mockResolvedValue();

      await bridge.start();

      // Simulate process error event
      const errorHandlers = processEventHandlers["error"] ?? [];
      expect(errorHandlers.length).toBeGreaterThan(0);
      errorHandlers[0](new Error("spawn ENOENT"));

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("spawn ENOENT")
      );
    });
  });
});
