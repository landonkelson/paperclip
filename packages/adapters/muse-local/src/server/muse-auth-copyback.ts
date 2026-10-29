import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { withDirectoryMergeLock } from "@paperclipai/adapter-utils/workspace-restore-merge";
import {
  IMPLAUSIBLE_EXPIRY_EXIT,
  USE_SOURCE_EXIT,
  decideMuseAuthMerge,
} from "./muse-auth-merge-decision.js";

/** Outcome of a copy-back attempt. No token material is ever surfaced. */
export type CopyBackMuseAuthOutcome = "copied" | "kept-host";

export interface CopyBackMuseAuthInput {
  /**
   * Reads the sandbox `auth.json` bytes back from the (about-to-be-destroyed)
   * sandbox. In production this is bound to the managed-runtime restore
   * context's `readFile` for `${assetDir}/muse/auth.json`.
   */
  readSandboxAuth: () => Promise<Buffer>;
  /**
   * Absolute path of the host credential to (maybe) overwrite — the host-managed
   * path configured by `env.MUSE_AUTH_PATH`.
   */
  hostAuthPath: string;
  /** Non-leaking progress sink: receives decision/outcome lines only. */
  log?: (line: string) => void | Promise<void>;
  /** Environment for the directory-merge-lock root resolution. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Guards, locks, and atomically installs a strictly-newer same-identity
 * sandbox Muse `auth.json` onto the host credential at teardown.
 */
export async function copyBackMuseAuth(
  input: CopyBackMuseAuthInput,
): Promise<CopyBackMuseAuthOutcome> {
  const { readSandboxAuth, hostAuthPath, log, env } = input;

  let sandboxAuthBytes: Buffer;
  try {
    sandboxAuthBytes = await readSandboxAuth();
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      await Promise.resolve(
        log?.(
          "[paperclip] Muse auth copy-back: no sandbox credential to copy back (absent auth.json); host credential kept.",
        ),
      ).catch(() => undefined);
      return "kept-host";
    }
    throw error;
  }

  const hostDir = path.dirname(hostAuthPath);
  await mkdir(hostDir, { recursive: true });

  try {
    return await withDirectoryMergeLock(
      hostDir,
      async (canonicalHostDir) => {
        const canonicalHostAuthPath = path.join(
          canonicalHostDir,
          path.basename(hostAuthPath),
        );
        const stagedTempPath = path.join(
          canonicalHostDir,
          `.auth.json.copyback-${process.pid}-${randomUUID()}.tmp`,
        );

        const handle = await open(stagedTempPath, "wx", 0o600);
        try {
          await handle.writeFile(sandboxAuthBytes);
          await handle.close();

          const decision = await decideMuseAuthMerge(
            stagedTempPath,
            canonicalHostAuthPath,
            { errorLabel: "muse auth copy-back" },
          );

          if (decision === USE_SOURCE_EXIT) {
            await rename(stagedTempPath, canonicalHostAuthPath);
            await Promise.resolve(
              log?.(
                "[paperclip] Muse auth copy-back: sandbox credential is strictly newer for the same identity; installed to the host at mode 0600.",
              ),
            ).catch(() => undefined);
            return "copied";
          }

          if (decision === IMPLAUSIBLE_EXPIRY_EXIT) {
            await Promise.resolve(
              log?.(
                "[paperclip] Muse auth copy-back: WARNING host credential kept (sandbox copy timestamp exceeded plausible future bound).",
              ),
            ).catch(() => undefined);
            return "kept-host";
          }

          await Promise.resolve(
            log?.(
              "[paperclip] Muse auth copy-back: host credential kept (sandbox copy is not a strictly-newer same-identity credential).",
            ),
          ).catch(() => undefined);
          return "kept-host";
        } finally {
          await handle.close().catch(() => undefined);
          await rm(stagedTempPath, { force: true }).catch(() => undefined);
        }
      },
      env,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code ?? "unknown";
    await Promise.resolve(
      log?.(`[paperclip] Muse auth copy-back failed (${code}); host credential kept.`),
    ).catch(() => undefined);
    throw error;
  }
}
