import { describe, it, expect } from "vitest";
import {
  readPluginConfig,
  getResolvedConfig,
  DEFAULTS,
  type OpenClawApi,
} from "../../config";

function makeApi(
  entries?: Record<string, { config?: unknown }>
): OpenClawApi {
  return {
    config: { plugins: { entries: entries ?? {} } },
    logger: { info: () => {}, warn: () => {} },
    registerService: () => {},
    registerTool: () => {},
    on: () => {},
  };
}

describe("readPluginConfig", () => {
  it("returns empty object when no config is present", () => {
    const api = makeApi();
    expect(readPluginConfig(api)).toEqual({});
  });

  it("finds config under PLUGIN_ID key", () => {
    const api = makeApi({
      "openclaw-neo4j-memory": {
        config: { bridgePort: 9999, agentId: "test-agent" },
      },
    });
    expect(readPluginConfig(api)).toEqual({
      bridgePort: 9999,
      agentId: "test-agent",
    });
  });

  it("finds config under neo4j-memory fallback key", () => {
    const api = makeApi({
      "neo4j-memory": { config: { instance: "custom-instance" } },
    });
    expect(readPluginConfig(api)).toEqual({ instance: "custom-instance" });
  });

  it("finds config under @johnymontana scoped key", () => {
    const api = makeApi({
      "@johnymontana/openclaw-neo4j-memory": {
        config: { observational: true },
      },
    });
    expect(readPluginConfig(api)).toEqual({ observational: true });
  });

  it("prefers PLUGIN_ID over fallback keys", () => {
    const api = makeApi({
      "openclaw-neo4j-memory": { config: { agentId: "primary" } },
      "neo4j-memory": { config: { agentId: "fallback" } },
    });
    expect(readPluginConfig(api)).toEqual({ agentId: "primary" });
  });

  it("handles null/undefined config gracefully", () => {
    const api = makeApi({
      "openclaw-neo4j-memory": { config: null as unknown as undefined },
    });
    expect(readPluginConfig(api)).toEqual({});
  });

  it("handles missing api.config", () => {
    const api: OpenClawApi = {
      logger: { info: () => {}, warn: () => {} },
      registerService: () => {},
      registerTool: () => {},
      on: () => {},
    };
    expect(readPluginConfig(api)).toEqual({});
  });
});

describe("getResolvedConfig", () => {
  it("returns defaults when no config is set", () => {
    const api = makeApi();
    const resolved = getResolvedConfig(api);
    expect(resolved).toEqual({
      bridgePort: DEFAULTS.bridgePort,
      agentId: DEFAULTS.agentId,
      instance: DEFAULTS.instance,
      neo4jPorts: undefined,
      ephemeral: false,
      observational: false,
      autoRecall: true,
      autoCapture: false,
      graphTools: true,
      readOnlyCypher: true,
    });
  });

  it("merges user config with defaults", () => {
    const api = makeApi({
      "openclaw-neo4j-memory": {
        config: { bridgePort: 8080, agentId: "my-agent" },
      },
    });
    const resolved = getResolvedConfig(api);
    expect(resolved).toEqual({
      bridgePort: 8080,
      agentId: "my-agent",
      instance: DEFAULTS.instance,
      neo4jPorts: undefined,
      ephemeral: false,
      observational: false,
      autoRecall: true,
      autoCapture: false,
      graphTools: true,
      readOnlyCypher: true,
    });
  });

  it("overrides all defaults when fully specified", () => {
    const api = makeApi({
      "openclaw-neo4j-memory": {
        config: {
          bridgePort: 3000,
          agentId: "custom",
          instance: "my-db",
          neo4jPorts: { bolt: 18687, http: 18474, https: 18473 },
          ephemeral: true,
          observational: true,
          autoRecall: false,
          autoCapture: true,
          graphTools: false,
          readOnlyCypher: false,
        },
      },
    });
    const resolved = getResolvedConfig(api);
    expect(resolved).toEqual({
      bridgePort: 3000,
      agentId: "custom",
      instance: "my-db",
      neo4jPorts: { bolt: 18687, http: 18474, https: 18473 },
      ephemeral: true,
      observational: true,
      autoRecall: false,
      autoCapture: true,
      graphTools: false,
      readOnlyCypher: false,
    });
  });
});
