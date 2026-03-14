import { describe, it, expect, afterAll } from "vitest";
import * as http from "node:http";

// Import the built plugin — e2e tests run against compiled output
const plugin = require("../../../dist/index");

const BRIDGE_PORT = 17575;
const NEO4J_PORTS = {
  bolt: 17687,
  http: 17474,
  https: 17473,
};
const INSTANCE_NAME = `e2e-lifecycle-${Date.now()}`;

function makeApi() {
  const logs: string[] = [];
  return {
    api: {
      config: {
        plugins: {
          entries: {
            "openclaw-neo4j-memory": {
              config: {
                bridgePort: BRIDGE_PORT,
                agentId: "e2e-test",
                instance: INSTANCE_NAME,
                neo4jPorts: NEO4J_PORTS,
                ephemeral: true,
              },
            },
          },
        },
      },
      logger: {
        info: (msg: string) => {
          logs.push(msg);
          console.log(msg);
        },
        warn: (msg: string) => {
          logs.push(msg);
          console.warn(msg);
        },
      },
      registerService: null as unknown as (service: {
        id: string;
        start: () => Promise<void>;
        stop: () => Promise<void>;
      }) => void,
    },
    logs,
    service: null as { start: () => Promise<void>; stop: () => Promise<void> } | null,
  };
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

describe("Plugin full lifecycle (e2e)", () => {
  const ctx = makeApi();

  afterAll(async () => {
    if (ctx.service) {
      try {
        await ctx.service.stop();
      } catch {
        // best effort
      }
    }
  });

  it("registers a service via the plugin", () => {
    ctx.api.registerService = (service) => {
      ctx.service = service;
    };

    plugin.register(ctx.api);
    expect(ctx.service).not.toBeNull();
  });

  it("starts Neo4j and the bridge server", async () => {
    expect(ctx.service).not.toBeNull();
    await ctx.service!.start();

    // Bridge should be healthy
    const res = await httpGet(
      `http://localhost:${BRIDGE_PORT}/memory/health`
    );
    expect(res.statusCode).toBe(200);
  });

  it("bridge /memory/stats endpoint responds", async () => {
    const res = await httpGet(
      `http://localhost:${BRIDGE_PORT}/memory/stats`
    );
    expect(res.statusCode).toBe(200);
    const stats = JSON.parse(res.body);
    expect(stats).toBeDefined();
  });

  it("stops Neo4j and bridge server cleanly", async () => {
    expect(ctx.service).not.toBeNull();
    await ctx.service!.stop();
    ctx.service = null;

    // Bridge should no longer respond
    await expect(
      httpGet(`http://localhost:${BRIDGE_PORT}/memory/health`)
    ).rejects.toThrow();
  });
});
