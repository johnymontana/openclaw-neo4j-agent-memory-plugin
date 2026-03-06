import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";

const plugin = require("../../../dist/index");

const BRIDGE_PORT = 17576;
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

  it("stores an entity", async () => {
    const res = await httpPost(
      `http://localhost:${BRIDGE_PORT}/memory/store`,
      {
        entities: [
          {
            type: "Person",
            name: "Alice",
            observations: ["Alice is a software engineer"],
          },
        ],
      }
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toBeDefined();
  });

  it("recalls the stored entity", async () => {
    const res = await httpPost(
      `http://localhost:${BRIDGE_PORT}/memory/recall`,
      {
        query: "Alice",
      }
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toBeDefined();
    // The response should mention Alice somewhere
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).toContain("Alice");
  });

  it("queries the stored entity", async () => {
    const res = await httpPost(
      `http://localhost:${BRIDGE_PORT}/memory/query`,
      {
        type: "Person",
        name: "Alice",
      }
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toBeDefined();
  });

  it("stats reflect stored data", async () => {
    const res = await httpGet(
      `http://localhost:${BRIDGE_PORT}/memory/stats`
    );
    expect(res.statusCode).toBe(200);
    const stats = JSON.parse(res.body);
    expect(stats).toBeDefined();
  });
});
