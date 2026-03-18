import { Buffer } from "node:buffer";
import { request as httpRequest } from "node:http";
import { Neo4jLocal, type Neo4jCredentials } from "@johnymontana/neo4j-local";
import { PLUGIN_ID, SERVICE_ID, getResolvedConfig, type OpenClawApi } from "./config";
import { BridgeServer } from "./bridge";
import { registerNeo4jHooks, registerNeo4jTools } from "./adapter";

let neo4jInstance: Neo4jLocal | null = null;
let bridgeServer: BridgeServer | null = null;

type CredentialProbeResult = "valid" | "invalid" | "unknown";
type CredentialProbeOptions = {
  maxAttempts?: number;
  delayMs?: number;
  requireDefinitiveSuccess?: boolean;
};

const DEFAULT_PROBE_ATTEMPTS = 3;
const DEFAULT_PROBE_DELAY_MS = 500;
const RECOVERY_PROBE_ATTEMPTS = 3;
const RECOVERY_PROBE_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getNeo4jProbeUrl(credentials: Neo4jCredentials): URL | null {
  if (!credentials.httpUrl) {
    return null;
  }

  return new URL("/db/neo4j/tx/commit", credentials.httpUrl);
}

function probeNeo4jHttpAuth(credentials: Neo4jCredentials): Promise<number> {
  const url = getNeo4jProbeUrl(credentials);

  if (!url) {
    return Promise.reject(new Error("Neo4j HTTP URL unavailable for auth probe"));
  }

  const body = JSON.stringify({
    statements: [{ statement: "RETURN 1 AS ok" }],
  });

  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${credentials.username}:${credentials.password}`
          ).toString("base64")}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }
    );

    req.on("error", reject);
    req.setTimeout(3000, () => {
      req.destroy(new Error("Neo4j auth probe timed out"));
    });
    req.write(body);
    req.end();
  });
}

async function verifyNeo4jCredentials(
  credentials: Neo4jCredentials,
  logger: OpenClawApi["logger"],
  options: CredentialProbeOptions = {}
): Promise<CredentialProbeResult> {
  const {
    maxAttempts = DEFAULT_PROBE_ATTEMPTS,
    delayMs = DEFAULT_PROBE_DELAY_MS,
    requireDefinitiveSuccess = false,
  } = options;
  const probeUrl = getNeo4jProbeUrl(credentials);
  if (!probeUrl) {
    logger.warn(
      `[${PLUGIN_ID}] Neo4j did not expose an HTTP URL; skipping preflight auth verification`
    );
    return "unknown";
  }

  let lastError: Error | null = null;
  let lastStatus: number | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const status = await probeNeo4jHttpAuth(credentials);
      lastStatus = status;

      if (status === 200) {
        return "valid";
      }

      if (status === 401 || status === 403) {
        return "invalid";
      }

      const isTransientStatus =
        status === 408 ||
        status === 425 ||
        status === 429 ||
        status === 502 ||
        status === 503 ||
        status === 504;

      if (isTransientStatus && attempt < maxAttempts) {
        logger.warn(
          `[${PLUGIN_ID}] Neo4j auth probe returned HTTP ${status} (attempt ${attempt}/${maxAttempts}); retrying in ${delayMs}ms`
        );
        await sleep(delayMs);
        continue;
      }

      if (requireDefinitiveSuccess) {
        break;
      }

      logger.warn(
        `[${PLUGIN_ID}] Neo4j auth probe returned HTTP ${status}; continuing with managed credentials`
      );
      return "unknown";
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxAttempts) {
        logger.warn(
          `[${PLUGIN_ID}] Neo4j auth probe failed on attempt ${attempt}/${maxAttempts}: ${lastError.message}; retrying in ${delayMs}ms`
        );
        await sleep(delayMs);
      }
    }
  }

  if (requireDefinitiveSuccess) {
    logger.warn(
      `[${PLUGIN_ID}] Neo4j auth probe did not confirm recovered credentials after ${maxAttempts} attempts${lastStatus != null ? ` (last HTTP status ${lastStatus})` : ""}${lastError ? ` (${lastError.message})` : ""}`
    );
    return "unknown";
  }

  logger.warn(
    `[${PLUGIN_ID}] Neo4j auth probe did not complete cleanly (${lastError?.message ?? "unknown error"}); continuing with managed credentials`
  );
  return "unknown";
}

async function reconcileNeo4jCredentials(
  api: OpenClawApi,
  instance: Neo4jLocal,
  credentials: Neo4jCredentials,
  instanceName: string
): Promise<Neo4jCredentials> {
  const probeResult = await verifyNeo4jCredentials(credentials, api.logger);

  if (probeResult !== "invalid") {
    return credentials;
  }

  api.logger.warn(
    `[${PLUGIN_ID}] Managed credentials were rejected for instance ${instanceName}; resetting the Neo4j data directory to reconcile auth state`
  );

  await instance.reset();

  const recoveredCredentials = await instance.start();
  const recoveredProbe = await verifyNeo4jCredentials(recoveredCredentials, api.logger, {
    maxAttempts: RECOVERY_PROBE_ATTEMPTS,
    delayMs: RECOVERY_PROBE_DELAY_MS,
    requireDefinitiveSuccess: false,
  });

  if (recoveredProbe === "valid") {
    api.logger.info(
      `[${PLUGIN_ID}] Recovered Neo4j credentials after resetting instance ${instanceName}`
    );
  } else {
    api.logger.warn(
      `[${PLUGIN_ID}] Neo4j HTTP auth probe could not confirm recovered credentials for instance ${instanceName}; proceeding and allowing the bridge to verify Bolt connectivity`
    );
  }

  return recoveredCredentials;
}

const plugin = {
  id: PLUGIN_ID,
  name: "Neo4j Memory",

  register(api: OpenClawApi) {
    registerNeo4jTools(api);
    registerNeo4jHooks(api);

    api.registerService({
      id: SERVICE_ID,

      start: async () => {
        const config = getResolvedConfig(api);

        api.logger.info(
          `[${PLUGIN_ID}] Starting Neo4j instance (${config.instance})...`
        );

        neo4jInstance = new Neo4jLocal({
          instanceName: config.instance,
          ports: config.neo4jPorts,
          ephemeral: config.ephemeral,
        });

        const credentials = await reconcileNeo4jCredentials(
          api,
          neo4jInstance,
          await neo4jInstance.start(),
          config.instance
        );
        api.logger.info(
          `[${PLUGIN_ID}] Neo4j running at ${credentials.uri}`
        );

        bridgeServer = new BridgeServer({
          bridgePort: config.bridgePort,
          agentId: config.agentId,
          neo4jUri: credentials.uri,
          neo4jUser: credentials.username,
          neo4jPassword: credentials.password,
          logger: api.logger,
        });

        await bridgeServer.start();
        api.logger.info(
          `[${PLUGIN_ID}] Bridge server healthy on port ${config.bridgePort}`
        );
      },

      stop: async () => {
        try {
          if (bridgeServer) {
            api.logger.info(`[${PLUGIN_ID}] Stopping bridge server...`);
            await bridgeServer.stop();
            bridgeServer = null;
          }
        } catch (error) {
          api.logger.warn(
            `[${PLUGIN_ID}] Failed to stop bridge cleanly: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }

        try {
          if (neo4jInstance) {
            api.logger.info(`[${PLUGIN_ID}] Stopping Neo4j...`);
            await neo4jInstance.stop();
            neo4jInstance = null;
          }
        } catch (error) {
          api.logger.warn(
            `[${PLUGIN_ID}] Failed to stop Neo4j cleanly: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      },
    });
  },
};

export = plugin;
