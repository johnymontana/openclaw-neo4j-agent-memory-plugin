import { Neo4jLocal } from "@johnymontana/neo4j-local";
import { PLUGIN_ID, SERVICE_ID, getResolvedConfig, type OpenClawApi } from "./config";
import { BridgeServer } from "./bridge";

let neo4jInstance: Neo4jLocal | null = null;
let bridgeServer: BridgeServer | null = null;

const plugin = {
  id: PLUGIN_ID,
  name: "Neo4j Memory",

  register(api: OpenClawApi) {
    api.registerService({
      id: SERVICE_ID,

      start: async () => {
        const config = getResolvedConfig(api);

        api.logger.info(
          `[${PLUGIN_ID}] Starting Neo4j instance (${config.instance})...`
        );

        neo4jInstance = new Neo4jLocal({
          instanceName: config.instance,
        });

        const credentials = await neo4jInstance.start();
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
