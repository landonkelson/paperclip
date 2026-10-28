import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const runProcessMock = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: JSON.stringify({ payload_type: "run.terminal.completed", payload: { text: "Task completed." } }),
    stderr: "",
  })),
);

const prepareRuntimeMock = vi.hoisted(() =>
  vi.fn(async () => ({
    workspaceRemoteDir: "/remote/workspace",
    assetDirs: { runConfig: "/remote/config" },
    restoreWorkspace: async () => {},
  })),
);

vi.mock("@paperclipai/adapter-utils/execution-target", () => ({
  readAdapterExecutionTarget: ({ executionTarget }: { executionTarget?: unknown }) =>
    executionTarget ?? { kind: "local" },
  prepareAdapterExecutionTargetRuntime: prepareRuntimeMock,
  resolveAdapterExecutionTargetCommandForLogs: async (cmd: string) => cmd,
  runAdapterExecutionTargetProcess: runProcessMock,
}));

import { execute } from "./execute.js";

const tempRoots: string[] = [];

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-muse-test-"));
  tempRoots.push(root);
  return root;
}

function makeContext(root: string, overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-123",
    agent: {
      id: "agent-123",
      companyId: "company-123",
      name: "Muse Agent",
      adapterType: "muse_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: { cwd: root, model: "muse-wonder-1.0", reasoningEffort: "high" },
    context: {},
    authToken: "agent-auth-token",
    onLog: async () => {},
    ...overrides,
  };
}

describe("muse_local execute", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    runProcessMock.mockClear();
    prepareRuntimeMock.mockClear();
    process.env.DATABASE_URL = "postgres://secret-user:secret-pass@localhost:5432/paperclip";
    process.env.HOST_SECRET = "super-secret-value";
  });

  afterEach(async () => {
    process.env = { ...origEnv };
    for (const root of tempRoots) {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
    tempRoots.length = 0;
  });

  it("redacts host environment secrets in onMeta to prevent credential leakage into database", async () => {
    const root = await makeTempRoot();
    const onMeta = vi.fn(async () => {});
    const ctx = makeContext(root, { onMeta });

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(onMeta).toHaveBeenCalledTimes(1);

    const loggedMeta = onMeta.mock.calls[0]![0];
    const loggedEnv = loggedMeta.env as Record<string, string>;

    // Host secrets must NOT leak into logged environment
    expect(loggedEnv.DATABASE_URL).toBeUndefined();
    expect(loggedEnv.HOST_SECRET).toBeUndefined();

    // Standard run variables should be present
    expect(loggedEnv.PAPERCLIP_RUN_ID).toBe("run-123");
    expect(loggedEnv.PAPERCLIP_API_KEY).toBe("agent-auth-token");
    expect(loggedEnv.MUSE_NO_AUTO_UPDATE).toBe("1");
  });

  it("preserves pre-existing user files and directories in .agents during skill staging cleanup", async () => {
    const root = await makeTempRoot();
    const userAgentsDir = path.join(root, ".agents");
    await fs.mkdir(userAgentsDir, { recursive: true });
    const userRuleFile = path.join(userAgentsDir, "custom-agent-rule.md");
    await fs.writeFile(userRuleFile, "# User rule\nDo not delete me.", "utf8");

    const ctx = makeContext(root);
    await execute(ctx);

    // .agents and userRuleFile must still exist
    const stillExists = await fs.access(userRuleFile).then(() => true).catch(() => false);
    expect(stillExists).toBe(true);
    const content = await fs.readFile(userRuleFile, "utf8");
    expect(content).toBe("# User rule\nDo not delete me.");
  });

  it("passes model and reasoningEffort to CLI execution", async () => {
    const root = await makeTempRoot();
    const onMeta = vi.fn(async () => {});
    const ctx = makeContext(root, {
      onMeta,
      config: { cwd: root, model: "muse-wonder-full-1.0", reasoningEffort: "xhigh" },
    });

    await execute(ctx);
    expect(runProcessMock).toHaveBeenCalledTimes(1);

    const callArgs = runProcessMock.mock.calls[0]![3] as string[];
    expect(callArgs).toContain("--model");
    expect(callArgs).toContain("muse-wonder-full-1.0");
    expect(callArgs).toContain("--reasoning-effort");
    expect(callArgs).toContain("xhigh");
  });
});
