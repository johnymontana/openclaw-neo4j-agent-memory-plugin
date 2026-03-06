"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");

const PLUGIN_ID = "openclaw-neo4j-memory";
const SERVICE_ID = "openclaw-neo4j-memory-bridge";
const DEFAULTS = {
  bridgePort: 7575,
  agentId: "default",
  instance: "openclaw-memory",
};

function readPluginConfig(api) {
  const entries = api?.config?.plugins?.entries ?? {};
  const candidates = [
    PLUGIN_ID,
    "neo4j-memory",
    "@johnymontana/openclaw-neo4j-memory",
  ];

  for (const candidate of candidates) {
    const config = entries?.[candidate]?.config;
    if (config && typeof config === "object") {
      return config;
    }
  }

  return {};
}

function buildScriptEnv(api) {
  const config = readPluginConfig(api);
  return {
    AGENT_ID: String(config.agentId ?? DEFAULTS.agentId),
    BRIDGE_PORT: String(config.bridgePort ?? DEFAULTS.bridgePort),
    NEO4J_INSTANCE: String(config.instance ?? DEFAULTS.instance),
  };
}

function pipeLines(stream, onLine) {
  let buffer = "";

  stream.on("data", (chunk) => {
    buffer += String(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        onLine(trimmed);
      }
    }
  });

  stream.on("end", () => {
    const trimmed = buffer.trim();
    if (trimmed) {
      onLine(trimmed);
    }
  });
}

function runLifecycleScript(api, scriptName) {
  const pluginRoot = path.join(__dirname, "..");
  const scriptPath = path.join(pluginRoot, "server", scriptName);
  const child = spawn(scriptPath, [], {
    cwd: pluginRoot,
    env: {
      ...process.env,
      ...buildScriptEnv(api),
    },
  });

  pipeLines(child.stdout, (line) => api.logger.info(`[${PLUGIN_ID}] ${line}`));
  pipeLines(child.stderr, (line) => api.logger.warn(`[${PLUGIN_ID}] ${line}`));

  return new Promise((resolve, reject) => {
    child.once("error", (error) => {
      reject(
        new Error(`Failed to launch ${scriptName}: ${error.message || String(error)}`),
      );
    });

    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${scriptName} exited with status ${code ?? "unknown"}`));
    });
  });
}

const plugin = {
  id: PLUGIN_ID,
  name: "Neo4j Memory",
  register(api) {
    api.registerService({
      id: SERVICE_ID,
      start: async () => {
        await runLifecycleScript(api, "start.sh");
      },
      stop: async () => {
        try {
          await runLifecycleScript(api, "stop.sh");
        } catch (error) {
          api.logger.warn(
            `[${PLUGIN_ID}] Failed to stop bridge cleanly: ${error.message || String(error)}`,
          );
        }
      },
    });
  },
};

module.exports = plugin;
module.exports.default = plugin;
