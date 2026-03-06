import { describe, it, expect, afterAll } from "vitest";
import { Neo4jLocal } from "@johnymontana/neo4j-local";

describe("Neo4j lifecycle", () => {
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

  it("starts a Neo4j instance and returns credentials", async () => {
    instance = new Neo4jLocal({
      instanceName: "integration-test-lifecycle",
      ephemeral: true,
    });

    const credentials = await instance.start();

    expect(credentials).toBeDefined();
    expect(credentials.uri).toMatch(/^bolt:\/\//);
    expect(credentials.username).toBe("neo4j");
    expect(credentials.password).toBeTruthy();
  });

  it("reports running status after start", async () => {
    expect(instance).not.toBeNull();
    const status = await instance!.getStatus();
    expect(status.state).toBe("running");
    expect(status.pid).toBeGreaterThan(0);
  });

  it("getCredentials returns the same credentials", () => {
    expect(instance).not.toBeNull();
    const creds = instance!.getCredentials();
    expect(creds.uri).toMatch(/^bolt:\/\//);
    expect(creds.username).toBe("neo4j");
    expect(creds.password).toBeTruthy();
  });

  it("stops the instance cleanly", async () => {
    expect(instance).not.toBeNull();
    await instance!.stop();

    const status = await instance!.getStatus();
    expect(status.state).toBe("stopped");
    instance = null;
  });
});
