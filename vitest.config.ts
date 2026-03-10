import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/__tests__/unit/**/*.test.ts"],
          testTimeout: 5000,
        },
      },
      {
        test: {
          name: "integration",
          include: ["src/__tests__/integration/**/*.test.ts"],
          testTimeout: 120000,
        },
      },
      {
        test: {
          name: "e2e",
          include: ["src/__tests__/e2e/**/*.test.ts"],
          fileParallelism: false,
          hookTimeout: 120000,
          testTimeout: 180000,
        },
      },
    ],
  },
});
