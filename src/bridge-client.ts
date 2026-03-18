import { request as httpRequest } from "node:http";

type RequestOptions = {
  sessionId?: string;
  channel?: string;
  agentId?: string;
};

export interface BridgeLogger {
  debug?(msg: string): void;
  warn(msg: string): void;
}

export interface BridgeClientOptions {
  bridgePort: number;
  agentId: string;
  logger: BridgeLogger;
}

export interface BridgeRecallResult {
  id?: string;
  graph_id?: string;
  name?: string;
  entity_type?: string;
  description?: string;
  attributes?: Record<string, unknown>;
  _labels?: string[];
  _relationships?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface BridgeRecallResponse {
  results: BridgeRecallResult[];
  count: number;
  query: string;
}

export interface BridgeGetResponse {
  path: string;
  text: string;
  from_line: number;
  lines: number;
  total_lines: number;
  entity?: Record<string, unknown>;
}

export interface BridgeContextResponse {
  context: string;
  entities_used: number;
  reasoning_traces: number;
  token_estimate: number;
}

export interface BridgeQueryResponse {
  results: Array<Record<string, unknown>>;
  count: number;
}

export class BridgeClient {
  private readonly bridgePort: number;
  private readonly agentId: string;
  private readonly logger: BridgeLogger;

  constructor(options: BridgeClientOptions) {
    this.bridgePort = options.bridgePort;
    this.agentId = options.agentId;
    this.logger = options.logger;
  }

  async store(
    type: "entity" | "message" | "observation",
    data: Record<string, unknown>,
    options: RequestOptions = {}
  ): Promise<Record<string, unknown>> {
    return this.request("/memory/store", {
      type,
      data,
      session_id: options.sessionId,
      channel: options.channel,
      agent_id: options.agentId ?? this.agentId,
    });
  }

  async recall(
    query: string,
    options: RequestOptions & { limit?: number; includeReasoning?: boolean } = {}
  ): Promise<BridgeRecallResponse> {
    return this.request("/memory/recall", {
      query,
      limit: options.limit ?? 5,
      session_id: options.sessionId,
      channel: options.channel,
      agent_id: options.agentId ?? this.agentId,
      include_reasoning: options.includeReasoning ?? false,
    });
  }

  async get(
    payload: {
      path?: string;
      id?: string;
      name?: string;
      query?: string;
      entityType?: string;
      from?: number;
      lines?: number;
    },
    options: RequestOptions = {}
  ): Promise<BridgeGetResponse> {
    return this.request("/memory/get", {
      path: payload.path,
      id: payload.id,
      name: payload.name,
      query: payload.query,
      entity_type: payload.entityType,
      from_line: payload.from,
      lines: payload.lines,
      session_id: options.sessionId,
      agent_id: options.agentId ?? this.agentId,
    });
  }

  async context(
    message: string,
    options: RequestOptions & { maxTokens?: number } = {}
  ): Promise<BridgeContextResponse> {
    return this.request("/memory/context", {
      message,
      max_tokens: options.maxTokens ?? 2000,
      session_id: options.sessionId,
      agent_id: options.agentId ?? this.agentId,
    });
  }

  async query(
    payload: {
      entityType?: string;
      name?: string;
      cypher?: string;
      params?: Record<string, unknown>;
      limit?: number;
    },
    options: RequestOptions = {}
  ): Promise<BridgeQueryResponse> {
    return this.request("/memory/query", {
      entity_type: payload.entityType,
      name: payload.name,
      cypher: payload.cypher,
      params: payload.params ?? {},
      limit: payload.limit ?? 25,
      agent_id: options.agentId ?? this.agentId,
    });
  }

  async trace(
    type: "tool_call" | "reasoning_step" | "skill_invocation",
    data: Record<string, unknown>,
    options: RequestOptions & { messageId?: string } = {}
  ): Promise<Record<string, unknown>> {
    return this.request("/memory/trace", {
      type,
      data,
      session_id: options.sessionId,
      message_id: options.messageId,
      agent_id: options.agentId ?? this.agentId,
    });
  }

  private request<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.requestWithRetry(path, body, 0);
  }

  private async requestWithRetry<T>(
    path: string,
    body: Record<string, unknown>,
    attempt: number
  ): Promise<T> {
    try {
      return await this.performRequest(path, body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isTransientStartupError =
        message.includes("ECONNREFUSED") ||
        message.includes("ECONNRESET") ||
        message.includes("timed out");

      if (!isTransientStartupError || attempt >= 4) {
        throw error;
      }

      const delayMs = 500 * (attempt + 1);
      this.logger.warn(
        `[openclaw-neo4j-memory] Bridge request ${path} not ready yet (${message}); retrying in ${delayMs}ms`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return this.requestWithRetry(path, body, attempt + 1);
    }
  }

  private performRequest<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const payload = JSON.stringify(body);

    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port: this.bridgePort,
          path,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
        },
        (res) => {
          let responseBody = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            responseBody += chunk;
          });
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) {
              try {
                resolve(JSON.parse(responseBody) as T);
              } catch (error) {
                reject(
                  new Error(
                    `Failed to parse bridge response for ${path}: ${
                      error instanceof Error ? error.message : String(error)
                    }`
                  )
                );
              }
              return;
            }

            this.logger.warn(
              `[openclaw-neo4j-memory] Bridge request ${path} failed with HTTP ${status}`
            );
            reject(
              new Error(
                `Bridge request ${path} failed with HTTP ${status}: ${responseBody || "no response body"}`
              )
            );
          });
        }
      );

      req.on("error", (error) => {
        reject(
          new Error(
            `Bridge request ${path} failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        );
      });
      req.setTimeout(5000, () => {
        req.destroy(new Error(`Bridge request ${path} timed out`));
      });
      req.write(payload);
      req.end();
    });
  }
}
