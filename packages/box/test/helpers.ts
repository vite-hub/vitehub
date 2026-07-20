import type { Box, BoxProcess, BoxSession } from "../src/index.ts";

export interface TestSession {
  readonly defaultWorkingDirectory: string;
  readonly env: Record<string, string>;
  readonly home: string;
  readonly id: string;
  readonly root: string;
  destroy(): Promise<void>;
  getPortUrl(options: { port: number; protocol?: "http" | "https" | "ws" }): Promise<string>;
  readBinaryFile(options: { abortSignal?: AbortSignal; path: string }): Promise<Uint8Array | null>;
  readTextFile(options: { abortSignal?: AbortSignal; path: string }): Promise<string | null>;
  run(options: {
    abortSignal?: AbortSignal;
    command: string;
    env?: Record<string, string>;
    workingDirectory?: string;
  }): Promise<{ exitCode: number; stderr: string; stdout: string }>;
  spawn(options: {
    abortSignal?: AbortSignal;
    command: string;
    env?: Record<string, string>;
    workingDirectory?: string;
  }): Promise<{
    pid?: number;
    stderr: ReadableStream<Uint8Array>;
    stdout: ReadableStream<Uint8Array>;
    kill(): Promise<void>;
    wait(): Promise<{ exitCode: number }>;
  }>;
  stop(): Promise<void>;
  writeBinaryFile(options: {
    abortSignal?: AbortSignal;
    content: Uint8Array;
    path: string;
  }): Promise<void>;
  writeTextFile(options: {
    abortSignal?: AbortSignal;
    content: string;
    path: string;
  }): Promise<void>;
}

export function boxProvider(box: Box) {
  return {
    async createSession(options: {
      abortSignal?: AbortSignal;
      onFirstCreate?: (
        session: TestSession,
        context: { abortSignal?: AbortSignal },
      ) => Promise<void>;
      sessionId?: string;
    } = {}) {
      const session = await box.open({
        id: options.sessionId,
        ...(options.onFirstCreate
          ? {
              async initialize(session, context) {
                await options.onFirstCreate!(await adaptSession(session), {
                  abortSignal: context.signal,
                });
              },
            }
          : {}),
        signal: options.abortSignal,
      });
      const adapted = await adaptSession(session);
      return adapted;
    },
  };
}

async function adaptSession(session: BoxSession): Promise<TestSession> {
  const envResult = await session.exec("/usr/bin/env -0");
  const env = Object.fromEntries(
    envResult.stdout
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf("=");
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
  );
  const home = env.HOME;
  const root = home.slice(0, -"/home".length);
  return {
    defaultWorkingDirectory: session.cwd,
    env,
    home,
    id: session.id,
    root,
    async destroy() {
      await session.close();
    },
    async getPortUrl(options) {
      if (!session.ports) throw new Error("Box session does not expose ports.");
      return String(await session.ports.expose(options.port, { protocol: options.protocol })).replace(
        /\/$/,
        "",
      );
    },
    async readBinaryFile(options) {
      return await session.files.read(options.path, { signal: options.abortSignal });
    },
    async readTextFile(options) {
      const contents = await session.files.read(options.path, { signal: options.abortSignal });
      return contents ? new TextDecoder().decode(contents) : null;
    },
    async run(options) {
      const result = await session.exec(options.command, [], {
        cwd: options.workingDirectory,
        env: options.env,
        signal: options.abortSignal,
      });
      return { exitCode: result.code, stderr: result.stderr, stdout: result.stdout };
    },
    async spawn(options) {
      if (!session.spawn) throw new Error("Box session does not support processes.");
      return adaptProcess(await session.spawn(options.command, [], {
        cwd: options.workingDirectory,
        env: options.env,
        signal: options.abortSignal,
      }));
    },
    async stop() {
      await session.close();
    },
    async writeBinaryFile(options) {
      await session.files.write(options.path, options.content, { signal: options.abortSignal });
    },
    async writeTextFile(options) {
      await session.files.write(
        options.path,
        new TextEncoder().encode(options.content),
        { signal: options.abortSignal },
      );
    },
  };
}

function adaptProcess(process: BoxProcess) {
  return {
    pid: process.pid,
    stderr: process.stderr,
    stdout: process.stdout,
    async kill() {
      await process.kill();
    },
    async wait() {
      const result = await process.wait();
      return { exitCode: result.code };
    },
  };
}
