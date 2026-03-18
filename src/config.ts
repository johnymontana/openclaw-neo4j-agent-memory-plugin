export const PLUGIN_ID = "openclaw-neo4j-memory";
export const SERVICE_ID = "openclaw-neo4j-memory-bridge";

export const DEFAULTS = {
  bridgePort: 7575,
  agentId: "default",
  instance: "openclaw-memory",
  ephemeral: false,
  autoRecall: true,
  autoCapture: false,
  graphTools: true,
  readOnlyCypher: true,
} as const;

export interface Neo4jPortConfig {
  bolt?: number;
  http?: number;
  https?: number;
}

export interface PluginConfig {
  bridgePort?: number;
  agentId?: string;
  instance?: string;
  neo4jPorts?: Neo4jPortConfig;
  ephemeral?: boolean;
  observational?: boolean;
  autoRecall?: boolean;
  autoCapture?: boolean;
  graphTools?: boolean;
  readOnlyCypher?: boolean;
}

export interface OpenClawToolResponse {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
}

export interface OpenClawTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>
  ) => Promise<OpenClawToolResponse> | OpenClawToolResponse;
  ownerOnly?: boolean;
}

export interface OpenClawToolContext {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  messageChannel?: string;
}

export type OpenClawToolFactory =
  | ((
      ctx: OpenClawToolContext
    ) => OpenClawTool | OpenClawTool[] | null | undefined)
  | OpenClawTool;

export interface BeforePromptBuildEvent {
  prompt: string;
  messages: unknown[];
}

export interface AgentEndEvent {
  messages: unknown[];
  success: boolean;
  error?: string;
  durationMs?: number;
}

export interface AfterToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs?: number;
  runId?: string;
  toolCallId?: string;
}

export interface HookAgentContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  channelId?: string;
  trigger?: string;
}

export type PluginHookMap = {
  before_prompt_build: (
    event: BeforePromptBuildEvent,
    ctx: HookAgentContext
  ) =>
    | Promise<{ prependContext?: string; systemPrompt?: string } | void>
    | { prependContext?: string; systemPrompt?: string }
    | void;
  agent_end: (event: AgentEndEvent, ctx: HookAgentContext) => Promise<void> | void;
  after_tool_call: (
    event: AfterToolCallEvent,
    ctx: HookAgentContext
  ) => Promise<void> | void;
};

export interface OpenClawApi {
  id?: string;
  name?: string;
  source?: string;
  config?: {
    plugins?: {
      entries?: Record<string, { config?: unknown }>;
    };
  };
  pluginConfig?: Record<string, unknown>;
  logger: {
    info(msg: string): void;
    warn(msg: string): void;
    error?(msg: string): void;
    debug?(msg: string): void;
  };
  registerTool?: (
    tool: OpenClawToolFactory,
    opts?: { name?: string; names?: string[]; optional?: boolean }
  ) => void;
  on?: <K extends keyof PluginHookMap>(
    hookName: K,
    handler: PluginHookMap[K],
    opts?: { priority?: number }
  ) => void;
  registerService(service: {
    id: string;
    start: () => Promise<void>;
    stop: () => Promise<void>;
  }): void;
}

export function readPluginConfig(api: OpenClawApi): PluginConfig {
  if (api?.pluginConfig && typeof api.pluginConfig === "object") {
    return api.pluginConfig as PluginConfig;
  }

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
    neo4jPorts: config.neo4jPorts,
    ephemeral: config.ephemeral ?? DEFAULTS.ephemeral,
    observational: config.observational ?? false,
    autoRecall: config.autoRecall ?? DEFAULTS.autoRecall,
    autoCapture: config.autoCapture ?? DEFAULTS.autoCapture,
    graphTools: config.graphTools ?? DEFAULTS.graphTools,
    readOnlyCypher: config.readOnlyCypher ?? DEFAULTS.readOnlyCypher,
  };
}
