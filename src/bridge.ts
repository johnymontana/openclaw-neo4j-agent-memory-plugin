import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as http from "node:http";

const MIN_PYTHON_MAJOR = 3;
const MIN_PYTHON_MINOR = 10;
const BRIDGE_HEALTH_STARTUP_TIMEOUT_SECONDS = 30;

export interface BridgeOptions {
  bridgePort: number;
  agentId: string;
  neo4jUri: string;
  neo4jUser: string;
  neo4jPassword: string;
  logger: {
    info(msg: string): void;
    warn(msg: string): void;
  };
}

interface PythonRuntime {
  command: string;
  executable: string;
  version: string;
}

interface PyVenvConfig {
  executable?: string;
  home?: string;
  version?: string;
}

export class BridgeServer {
  private process: ChildProcess | null = null;
  private readonly serverDir: string;
  private readonly venvDir: string;
  private readonly options: BridgeOptions;

  constructor(options: BridgeOptions) {
    this.options = options;
    this.serverDir = path.join(__dirname, "..", "server");
    this.venvDir = path.join(this.serverDir, ".venv");
  }

  async start(): Promise<void> {
    const python = this.findPython();
    this.options.logger.info(`[openclaw-neo4j-memory] Using ${python}`);

    const venvPython = this.ensureVenv(python);
    this.installDependencies(venvPython);

    const mainScript = path.join(this.serverDir, "main.py");

    this.process = spawn(venvPython, [mainScript], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: {
        ...process.env,
        AGENT_ID: this.options.agentId,
        BRIDGE_PORT: String(this.options.bridgePort),
        NEO4J_URI: this.options.neo4jUri,
        NEO4J_USER: this.options.neo4jUser,
        NEO4J_PASSWORD: this.options.neo4jPassword,
      },
    });

    this.process.unref();

    if (this.process.stdout) {
      this.pipeLines(this.process.stdout, (line) =>
        this.options.logger.info(`[openclaw-neo4j-memory] ${line}`)
      );
    }
    if (this.process.stderr) {
      this.pipeLines(this.process.stderr, (line) =>
        this.options.logger.warn(`[openclaw-neo4j-memory] ${line}`)
      );
    }

    this.process.on("error", (err) => {
      this.options.logger.warn(
        `[openclaw-neo4j-memory] Bridge process error: ${err.message}`
      );
    });

    // Race health check against early process exit
    const earlyExit = new Promise<never>((_resolve, reject) => {
      this.process!.once("close", (code) => {
        reject(
          new Error(
            `Bridge server process exited unexpectedly with code ${code ?? "unknown"}`
          )
        );
      });
    });

    await Promise.race([
      this.waitForHealth(BRIDGE_HEALTH_STARTUP_TIMEOUT_SECONDS),
      earlyExit,
    ]);
    this.options.logger.info(
      `[openclaw-neo4j-memory] Bridge server started (PID ${this.process.pid})`
    );
  }

  async stop(): Promise<void> {
    if (!this.process || this.process.pid == null) {
      return;
    }

    const pid = this.process.pid;

    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return; // already dead
    }

    const stopped = await this.waitForExit(pid, 5000);
    if (!stopped) {
      this.options.logger.warn(
        `[openclaw-neo4j-memory] Bridge did not exit after 5s, sending SIGKILL`
      );
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already dead
      }
    }

    this.process = null;
  }

  getPid(): number | null {
    return this.process?.pid ?? null;
  }

  private findPython(): string {
    const candidates = [
      "python3.12",
      "python3.11",
      "python3.10",
      "python3",
      "python",
    ];

    for (const cmd of candidates) {
      try {
        const version = execFileSync(cmd, [
          "-c",
          "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')",
        ], { encoding: "utf8", timeout: 5000 }).trim();

        const [major, minor] = version.split(".").map(Number);
        if (
          major > MIN_PYTHON_MAJOR ||
          (major === MIN_PYTHON_MAJOR && minor >= MIN_PYTHON_MINOR)
        ) {
          return cmd;
        }
      } catch {
        continue;
      }
    }

    throw new Error(
      `Python >= ${MIN_PYTHON_MAJOR}.${MIN_PYTHON_MINOR} is required but not found in PATH`
    );
  }

  private inspectPython(command: string): PythonRuntime {
    const output = execFileSync(command, [
      "-c",
      "import sys; print(sys.executable); print(f'{sys.version_info.major}.{sys.version_info.minor}')",
    ], { encoding: "utf8", timeout: 5000 });

    const [executable, version] = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (!executable || !version) {
      throw new Error(`Unable to inspect Python runtime for ${command}`);
    }

    return { command, executable, version };
  }

  private getVenvPythonCandidates(version?: string): string[] {
    const binDir = path.join(this.venvDir, "bin");
    return Array.from(new Set([
      path.join(binDir, "python"),
      path.join(binDir, "python3"),
      version ? path.join(binDir, `python${version}`) : null,
    ].filter((candidate): candidate is string => Boolean(candidate))));
  }

  private isRunnableExecutable(filePath: string): boolean {
    try {
      if (!fs.existsSync(filePath)) {
        return false;
      }

      return (fs.statSync(filePath).mode & 0o111) !== 0;
    } catch {
      return false;
    }
  }

  private readPyVenvConfig(): PyVenvConfig {
    const configPath = path.join(this.venvDir, "pyvenv.cfg");
    if (!fs.existsSync(configPath)) {
      return {};
    }

    try {
      const raw = fs.readFileSync(configPath, "utf8");
      const parsed: PyVenvConfig = {};

      for (const line of raw.split(/\r?\n/)) {
        const [rawKey, ...rest] = line.split("=");
        if (!rawKey || rest.length === 0) {
          continue;
        }

        const key = rawKey.trim();
        const value = rest.join("=").trim();
        if (key === "version") parsed.version = value;
        if (key === "home") parsed.home = value;
        if (key === "executable") parsed.executable = value;
      }

      return parsed;
    } catch {
      return {};
    }
  }

  private repairPackagedVenv(runtime: PythonRuntime): void {
    const config = this.readPyVenvConfig();
    const version = config.version ?? runtime.version;
    const candidates = this.getVenvPythonCandidates(version);
    const needsRepair = candidates.some((candidate) => !this.isRunnableExecutable(candidate));

    if (!needsRepair) {
      return;
    }

    const binDir = path.join(this.venvDir, "bin");
    this.options.logger.info(
      `[openclaw-neo4j-memory] Repairing packaged virtualenv interpreter shims in ${binDir}`
    );

    fs.mkdirSync(binDir, { recursive: true });
    for (const candidate of candidates) {
      fs.rmSync(candidate, { force: true });
      fs.symlinkSync(runtime.executable, candidate);
    }
  }

  private resolveVenvPython(version?: string): string {
    for (const candidate of this.getVenvPythonCandidates(version)) {
      if (this.isRunnableExecutable(candidate)) {
        return candidate;
      }
    }

    throw new Error(
      `[openclaw-neo4j-memory] Virtualenv is missing a runnable Python interpreter in ${this.venvDir}`
    );
  }

  private ensureVenv(python: string): string {
    if (!fs.existsSync(this.venvDir)) {
      this.options.logger.info(
        `[openclaw-neo4j-memory] Creating virtualenv in ${this.venvDir}`
      );
      execFileSync(python, ["-m", "venv", this.venvDir], {
        timeout: 30000,
      });
    }

    const runtime = this.inspectPython(python);
    this.repairPackagedVenv(runtime);
    return this.resolveVenvPython(this.readPyVenvConfig().version ?? runtime.version);
  }

  private installDependencies(venvPython: string): void {
    const requirementsFile = path.join(this.serverDir, "requirements.txt");

    try {
      execFileSync(venvPython, [
        "-c",
        "import fastapi, uvicorn, neo4j",
      ], { timeout: 5000 });
      return; // already installed
    } catch {
      // need to install
    }

    this.options.logger.info(
      `[openclaw-neo4j-memory] Installing Python dependencies`
    );
    execFileSync(venvPython, ["-m", "pip", "install", "--upgrade", "pip", "--quiet"], {
      timeout: 60000,
    });
    execFileSync(venvPython, ["-m", "pip", "install", "-r", requirementsFile, "--quiet"], {
      timeout: 120000,
    });
  }

  waitForHealth(maxWaitSeconds: number): Promise<void> {
    const url = `http://localhost:${this.options.bridgePort}/memory/health`;
    return new Promise((resolve, reject) => {
      let settled = false;
      let elapsed = 0;
      let interval: ReturnType<typeof setInterval> | null = null;

      const check = () => {
        if (settled) return;

        http
          .get(url, (res) => {
            res.resume(); // drain response body to free the socket
            if (!settled && res.statusCode === 200) {
              settled = true;
              if (interval) clearInterval(interval);
              resolve();
            }
          })
          .on("error", () => {
            // server not ready yet
          });
      };

      // Check immediately, then every second
      check();

      if (settled) return; // resolved synchronously on first check

      interval = setInterval(() => {
        elapsed++;
        if (elapsed >= maxWaitSeconds) {
          if (!settled) {
            settled = true;
            clearInterval(interval!);
            reject(
              new Error(
                `Bridge server did not become healthy within ${maxWaitSeconds}s`
              )
            );
          }
          return;
        }
        check();
      }, 1000);
    });
  }

  private waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const start = Date.now();
      const interval = setInterval(() => {
        try {
          process.kill(pid, 0); // check if alive
        } catch {
          clearInterval(interval);
          resolve(true);
          return;
        }
        if (Date.now() - start >= timeoutMs) {
          clearInterval(interval);
          resolve(false);
        }
      }, 200);
    });
  }

  private pipeLines(
    stream: NodeJS.ReadableStream,
    onLine: (line: string) => void
  ): void {
    let buffer = "";
    stream.on("data", (chunk: Buffer) => {
      buffer += String(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) onLine(trimmed);
      }
    });
    stream.on("end", () => {
      const trimmed = buffer.trim();
      if (trimmed) onLine(trimmed);
    });
  }
}
