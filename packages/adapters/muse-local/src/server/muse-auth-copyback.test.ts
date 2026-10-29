import { chmod, lstat, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { copyBackMuseAuth } from "./muse-auth-copyback.js";

describe("copyBackMuseAuth", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await chmod(dir, 0o700).catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  const ACCOUNT_ID = "muse-account-12345";
  const OTHER_ACCOUNT_ID = "muse-account-99999";

  function auth(input: {
    accountId?: string;
    expiresAt?: string;
    lastRefresh?: string;
    marker: string;
  }): string {
    return JSON.stringify(
      {
        account_id: input.accountId ?? ACCOUNT_ID,
        token: `token-${input.marker}`,
        ...(input.expiresAt ? { expires_at: input.expiresAt } : {}),
        ...(input.lastRefresh ? { last_refresh: input.lastRefresh } : {}),
      },
      null,
      2,
    );
  }

  async function makeHostDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-muse-copyback-"));
    cleanupDirs.push(dir);
    return dir;
  }

  const now = Date.now();
  const NEWER = new Date(now + 2 * 60_000).toISOString();
  const OLDER = new Date(now + 60_000).toISOString();

  async function runCopyBack(input: {
    sandboxAuth: string | (() => Promise<Buffer>);
    hostAuth?: string;
    hostDir?: string;
  }): Promise<{
    outcome: Awaited<ReturnType<typeof copyBackMuseAuth>>;
    finalHostAuth: string | null;
    finalHostMode: number | null;
    logs: string[];
    leftoverEntries: string[];
  }> {
    const hostDir = input.hostDir ?? (await makeHostDir());
    const hostAuthPath = path.join(hostDir, "auth.json");
    if (input.hostAuth !== undefined) {
      await writeFile(hostAuthPath, input.hostAuth, { mode: 0o600 });
    }

    const readSandboxAuth =
      typeof input.sandboxAuth === "function"
        ? input.sandboxAuth
        : async () => Buffer.from(input.sandboxAuth as string, "utf8");

    const logs: string[] = [];
    const outcome = await copyBackMuseAuth({
      readSandboxAuth,
      hostAuthPath,
      log: (line) => {
        logs.push(line);
      },
    });

    const finalHostAuth = await readFile(hostAuthPath, "utf8").catch(
      (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : Promise.reject(error)),
    );
    const finalHostMode = finalHostAuth === null ? null : (await lstat(hostAuthPath)).mode & 0o777;
    const leftoverEntries = (await readdir(hostDir)).filter((name) => name !== "auth.json");
    return { outcome, finalHostAuth, finalHostMode, logs, leftoverEntries };
  }

  it("installs a strictly-newer same-identity credential at mode 0600", async () => {
    const sandboxAuth = auth({ expiresAt: NEWER, marker: "sandbox-newer-SECRET" });
    const hostAuth = auth({ expiresAt: OLDER, marker: "host-older-SECRET" });

    const result = await runCopyBack({ sandboxAuth, hostAuth });

    expect(result.outcome).toBe("copied");
    expect(result.finalHostAuth).toBe(sandboxAuth);
    expect(result.finalHostMode).toBe(0o600);
    expect(result.leftoverEntries).toEqual([]);
    expect(result.logs.join("\n")).not.toContain("SECRET");
  });

  it("keeps host credential when sandbox copy is older, tied, or from a different identity", async () => {
    const hostKeep = auth({ expiresAt: OLDER, marker: "host-keep" });
    const cases = [
      {
        name: "tie",
        sandboxAuth: auth({ expiresAt: OLDER, marker: "sandbox-tie" }),
        hostAuth: hostKeep,
      },
      {
        name: "sandbox older",
        sandboxAuth: auth({ expiresAt: new Date(now).toISOString(), marker: "sandbox-older" }),
        hostAuth: hostKeep,
      },
      {
        name: "identity mismatch",
        sandboxAuth: auth({ accountId: OTHER_ACCOUNT_ID, expiresAt: NEWER, marker: "sandbox-other" }),
        hostAuth: hostKeep,
      },
      {
        name: "sandbox unusable JSON",
        sandboxAuth: "{invalid-json",
        hostAuth: hostKeep,
      },
      {
        name: "sandbox missing token material",
        sandboxAuth: JSON.stringify({ account_id: ACCOUNT_ID, expires_at: NEWER }),
        hostAuth: hostKeep,
      },
    ];

    for (const testCase of cases) {
      const result = await runCopyBack({
        sandboxAuth: testCase.sandboxAuth,
        hostAuth: testCase.hostAuth,
      });
      expect(result.outcome, testCase.name).toBe("kept-host");
      expect(result.finalHostAuth, testCase.name).toBe(testCase.hostAuth);
      expect(result.finalHostMode, testCase.name).toBe(0o600);
      expect(result.leftoverEntries, testCase.name).toEqual([]);
    }
  });

  it("returns kept-host and does not throw when sandbox auth.json is absent", async () => {
    const hostAuth = auth({ expiresAt: OLDER, marker: "host-keep" });
    const result = await runCopyBack({
      sandboxAuth: async () => {
        const error = new Error("File not found") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
      hostAuth,
    });

    expect(result.outcome).toBe("kept-host");
    expect(result.finalHostAuth).toBe(hostAuth);
    expect(result.leftoverEntries).toEqual([]);
  });

  it("rejects when timestamp sits implausibly far in the future", async () => {
    const implausibleFuture = new Date(now + 500 * 24 * 60 * 60 * 1000).toISOString();
    const sandboxAuth = auth({ expiresAt: implausibleFuture, marker: "sandbox-poisoned" });
    const hostAuth = auth({ expiresAt: OLDER, marker: "host-keep" });

    const result = await runCopyBack({ sandboxAuth, hostAuth });
    expect(result.outcome).toBe("kept-host");
    expect(result.finalHostAuth).toBe(hostAuth);
  });
});
