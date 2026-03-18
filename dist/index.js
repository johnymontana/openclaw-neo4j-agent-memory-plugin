"use strict";
const node_buffer_1 = require("node:buffer");
const node_http_1 = require("node:http");
const neo4j_local_1 = require("@johnymontana/neo4j-local");
const config_1 = require("./config");
const bridge_1 = require("./bridge");
const adapter_1 = require("./adapter");
let neo4jInstance = null;
let bridgeServer = null;
const DEFAULT_PROBE_ATTEMPTS = 3;
const DEFAULT_PROBE_DELAY_MS = 500;
const RECOVERY_PROBE_ATTEMPTS = 3;
const RECOVERY_PROBE_DELAY_MS = 1000;
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function getNeo4jProbeUrl(credentials) {
    if (!credentials.httpUrl) {
        return null;
    }
    return new URL("/db/neo4j/tx/commit", credentials.httpUrl);
}
function probeNeo4jHttpAuth(credentials) {
    const url = getNeo4jProbeUrl(credentials);
    if (!url) {
        return Promise.reject(new Error("Neo4j HTTP URL unavailable for auth probe"));
    }
    const body = JSON.stringify({
        statements: [{ statement: "RETURN 1 AS ok" }],
    });
    return new Promise((resolve, reject) => {
        const req = (0, node_http_1.request)(url, {
            method: "POST",
            headers: {
                Authorization: `Basic ${node_buffer_1.Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`,
                "Content-Type": "application/json",
                "Content-Length": node_buffer_1.Buffer.byteLength(body),
            },
        }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.setTimeout(3000, () => {
            req.destroy(new Error("Neo4j auth probe timed out"));
        });
        req.write(body);
        req.end();
    });
}
async function verifyNeo4jCredentials(credentials, logger, options = {}) {
    const { maxAttempts = DEFAULT_PROBE_ATTEMPTS, delayMs = DEFAULT_PROBE_DELAY_MS, requireDefinitiveSuccess = false, } = options;
    const probeUrl = getNeo4jProbeUrl(credentials);
    if (!probeUrl) {
        logger.warn(`[${config_1.PLUGIN_ID}] Neo4j did not expose an HTTP URL; skipping preflight auth verification`);
        return "unknown";
    }
    let lastError = null;
    let lastStatus = null;
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
            const isTransientStatus = status === 408 ||
                status === 425 ||
                status === 429 ||
                status === 502 ||
                status === 503 ||
                status === 504;
            if (isTransientStatus && attempt < maxAttempts) {
                logger.warn(`[${config_1.PLUGIN_ID}] Neo4j auth probe returned HTTP ${status} (attempt ${attempt}/${maxAttempts}); retrying in ${delayMs}ms`);
                await sleep(delayMs);
                continue;
            }
            if (requireDefinitiveSuccess) {
                break;
            }
            logger.warn(`[${config_1.PLUGIN_ID}] Neo4j auth probe returned HTTP ${status}; continuing with managed credentials`);
            return "unknown";
        }
        catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            if (attempt < maxAttempts) {
                logger.warn(`[${config_1.PLUGIN_ID}] Neo4j auth probe failed on attempt ${attempt}/${maxAttempts}: ${lastError.message}; retrying in ${delayMs}ms`);
                await sleep(delayMs);
            }
        }
    }
    if (requireDefinitiveSuccess) {
        logger.warn(`[${config_1.PLUGIN_ID}] Neo4j auth probe did not confirm recovered credentials after ${maxAttempts} attempts${lastStatus != null ? ` (last HTTP status ${lastStatus})` : ""}${lastError ? ` (${lastError.message})` : ""}`);
        return "unknown";
    }
    logger.warn(`[${config_1.PLUGIN_ID}] Neo4j auth probe did not complete cleanly (${lastError?.message ?? "unknown error"}); continuing with managed credentials`);
    return "unknown";
}
async function reconcileNeo4jCredentials(api, instance, credentials, instanceName) {
    const probeResult = await verifyNeo4jCredentials(credentials, api.logger);
    if (probeResult !== "invalid") {
        return credentials;
    }
    api.logger.warn(`[${config_1.PLUGIN_ID}] Managed credentials were rejected for instance ${instanceName}; resetting the Neo4j data directory to reconcile auth state`);
    await instance.reset();
    const recoveredCredentials = await instance.start();
    const recoveredProbe = await verifyNeo4jCredentials(recoveredCredentials, api.logger, {
        maxAttempts: RECOVERY_PROBE_ATTEMPTS,
        delayMs: RECOVERY_PROBE_DELAY_MS,
        requireDefinitiveSuccess: false,
    });
    if (recoveredProbe === "valid") {
        api.logger.info(`[${config_1.PLUGIN_ID}] Recovered Neo4j credentials after resetting instance ${instanceName}`);
    }
    else {
        api.logger.warn(`[${config_1.PLUGIN_ID}] Neo4j HTTP auth probe could not confirm recovered credentials for instance ${instanceName}; proceeding and allowing the bridge to verify Bolt connectivity`);
    }
    return recoveredCredentials;
}
const plugin = {
    id: config_1.PLUGIN_ID,
    name: "Neo4j Memory",
    register(api) {
        (0, adapter_1.registerNeo4jTools)(api);
        (0, adapter_1.registerNeo4jHooks)(api);
        api.registerService({
            id: config_1.SERVICE_ID,
            start: async () => {
                const config = (0, config_1.getResolvedConfig)(api);
                api.logger.info(`[${config_1.PLUGIN_ID}] Starting Neo4j instance (${config.instance})...`);
                neo4jInstance = new neo4j_local_1.Neo4jLocal({
                    instanceName: config.instance,
                    ports: config.neo4jPorts,
                    ephemeral: config.ephemeral,
                });
                const credentials = await reconcileNeo4jCredentials(api, neo4jInstance, await neo4jInstance.start(), config.instance);
                api.logger.info(`[${config_1.PLUGIN_ID}] Neo4j running at ${credentials.uri}`);
                bridgeServer = new bridge_1.BridgeServer({
                    bridgePort: config.bridgePort,
                    agentId: config.agentId,
                    neo4jUri: credentials.uri,
                    neo4jUser: credentials.username,
                    neo4jPassword: credentials.password,
                    logger: api.logger,
                });
                await bridgeServer.start();
                api.logger.info(`[${config_1.PLUGIN_ID}] Bridge server healthy on port ${config.bridgePort}`);
            },
            stop: async () => {
                try {
                    if (bridgeServer) {
                        api.logger.info(`[${config_1.PLUGIN_ID}] Stopping bridge server...`);
                        await bridgeServer.stop();
                        bridgeServer = null;
                    }
                }
                catch (error) {
                    api.logger.warn(`[${config_1.PLUGIN_ID}] Failed to stop bridge cleanly: ${error instanceof Error ? error.message : String(error)}`);
                }
                try {
                    if (neo4jInstance) {
                        api.logger.info(`[${config_1.PLUGIN_ID}] Stopping Neo4j...`);
                        await neo4jInstance.stop();
                        neo4jInstance = null;
                    }
                }
                catch (error) {
                    api.logger.warn(`[${config_1.PLUGIN_ID}] Failed to stop Neo4j cleanly: ${error instanceof Error ? error.message : String(error)}`);
                }
            },
        });
    },
};
module.exports = plugin;
//# sourceMappingURL=index.js.map