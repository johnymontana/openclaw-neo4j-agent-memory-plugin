"use strict";
const neo4j_local_1 = require("@johnymontana/neo4j-local");
const config_1 = require("./config");
const bridge_1 = require("./bridge");
let neo4jInstance = null;
let bridgeServer = null;
const plugin = {
    id: config_1.PLUGIN_ID,
    name: "Neo4j Memory",
    register(api) {
        api.registerService({
            id: config_1.SERVICE_ID,
            start: async () => {
                const config = (0, config_1.getResolvedConfig)(api);
                api.logger.info(`[${config_1.PLUGIN_ID}] Starting Neo4j instance (${config.instance})...`);
                neo4jInstance = new neo4j_local_1.Neo4jLocal({
                    instanceName: config.instance,
                });
                const credentials = await neo4jInstance.start();
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