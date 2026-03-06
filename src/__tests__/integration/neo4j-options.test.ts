import { describe, it, expect, afterAll } from "vitest";
import { Neo4jLocal } from "@johnymontana/neo4j-local";

describe("Neo4j with custom options", () => {
  let instance: Neo4jLocal | null = null;

  afterAll(async () => {
    if (instance) {
      try {
        await instance.stop();
      } catch {
        // best effort cleanup
      }
    }
  });

  it("starts with custom instance name and ports", async () => {
    instance = new Neo4jLocal({
      instanceName: "integration-test-options",
      ports: {
        bolt: 17687,
        http: 17474,
        https: 17473,
      },
      ephemeral: true,
    });

    const credentials = await instance.start();

    expect(credentials.uri).toContain("17687");
    expect(credentials.username).toBe("neo4j");
  });

  it("reports correct ports in status", async () => {
    expect(instance).not.toBeNull();
    const status = await instance!.getStatus();
    expect(status.ports.bolt).toBe(17687);
    expect(status.ports.http).toBe(17474);
  });

  it("cleans up on stop", async () => {
    expect(instance).not.toBeNull();
    await instance!.stop();

    const status = await instance!.getStatus();
    expect(status.state).toBe("stopped");
    instance = null;
  });
});
