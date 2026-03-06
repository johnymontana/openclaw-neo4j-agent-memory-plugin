export const PLUGIN_ID = "openclaw-neo4j-memory";
export const SERVICE_ID = "openclaw-neo4j-memory-bridge";

export const DEFAULTS = {
  bridgePort: 7575,
  agentId: "default",
  instance: "openclaw-memory",
} as const;

export interface PluginConfig {
  bridgePort?: number;
  agentId?: string;
  instance?: string;
  observational?: boolean;
}

export interface OpenClawApi {
  config?: {
    plugins?: {
      entries?: Record<string, { config?: unknown }>;
    };
  };
  logger: {
    info(msg: string): void;
    warn(msg: string): void;
    error?(msg: string): void;
  };
  registerService(service: {
    id: string;
    start: () => Promise<void>;
    stop: () => Promise<void>;
  }): void;
}

export function readPluginConfig(api: OpenClawApi): PluginConfig {
  const entries = api?.config?.plugins?.entries ?? {};
  const candidates = [
    PLUGIN_ID,
    "neo4j-memory",
    "@johnymontana/openclaw-neo4j-memory",
  ];

  for (const candidate of candidates) {
    const config = entries?.[candidate]?.config;
    if (config && typeof config === "object") {
      return config as PluginConfig;
    }
  }

  return {};
}

export function getResolvedConfig(api: OpenClawApi) {
  const config = readPluginConfig(api);
  return {
    bridgePort: config.bridgePort ?? DEFAULTS.bridgePort,
    agentId: config.agentId ?? DEFAULTS.agentId,
    instance: config.instance ?? DEFAULTS.instance,
    observational: config.observational ?? false,
  };
}
