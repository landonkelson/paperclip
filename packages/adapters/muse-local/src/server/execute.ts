import {
  runAdapterExecutionTargetProcess,
  readAdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import { fileURLToPath } from "node:url";
const __moduleDir = path.dirname(fileURLToPath(import.meta.url));
import {
  asString,
  asNumber,
  materializePaperclipSkillCopy,
  isPaperclipSkillSourceMissing,
  readPaperclipRuntimeSkillEntries,
  resolveLegacyPaperclipDesiredSkillNames as resolveMuseDesiredSkillNames,
  buildSkillLibraryManifestMarkdown,
  parseObject,
  renderTemplate,
  hydrateFreshSessionHandoff,
  selectInitialCommunicationGuidance,
  selectPaperclipPromptSections,
  isPaperclipRecoveryWakePayload,
  joinPromptSections,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
} from "@paperclipai/adapter-utils/server-utils";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const {
    runId,
    agent,
    runtime,
    config = {},
    context = {},
    executionTarget: rawExecutionTarget,
    onLog,
    onMeta,
    onSpawn,
    authToken,
  } = ctx;

  const executionTarget = readAdapterExecutionTarget({
    executionTarget: rawExecutionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });

  const configuredCommand = asString(config.command, "muse");
  const fallbackPath = path.join(os.homedir(), ".local/bin/muse");
  const command =
    configuredCommand === "muse" && (await fs.access(fallbackPath).then(() => true).catch(() => false))
      ? fallbackPath
      : configuredCommand;

  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const configuredCwd = asString(config.cwd, "");
  const cwd = workspaceCwd || configuredCwd || process.cwd();

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(parseObject(config.env) as Record<string, string>),
    MUSE_NO_AUTO_UPDATE: "1",
    PAPERCLIP_RUN_ID: runId,
  };
  if (authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  // Ensure $XDG_CONFIG_HOME/muse/auth.json is populated from MUSE_AUTH_PATH or fallback
  const xdgConfig = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config");
  const targetAuth = path.join(xdgConfig, "muse", "auth.json");
  const sourceCandidates = [
    env.MUSE_AUTH_PATH,
    path.join(env.HOME || os.homedir(), ".config/muse/auth.json"),
  ].filter(Boolean) as string[];

  for (const src of sourceCandidates) {
    if (src && src !== targetAuth && (await fs.access(src).then(() => true).catch(() => false))) {
      try {
        const data = await fs.readFile(src, "utf8");
        await fs.mkdir(path.join(xdgConfig, "muse"), { recursive: true, mode: 0o700 });
        await fs.writeFile(targetAuth, data, { mode: 0o600 });
        break;
      } catch {}
    }
  }

  // Session resolution
  const runtimeSessionParams = parseObject(runtime?.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime?.sessionId ?? "");
  const canResumeSession = runtimeSessionId.length > 0;
  const resumeSessionId = canResumeSession ? runtimeSessionId : null;
  // Skills resolution and staging
  const museSkillEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkillNames = new Set(resolveMuseDesiredSkillNames(config, museSkillEntries));
  const selectedSkills = museSkillEntries.filter(
    (entry) => desiredSkillNames.has(entry.key) && !isPaperclipSkillSourceMissing(entry),
  );

  for (const entry of museSkillEntries.filter((e) => desiredSkillNames.has(e.key))) {
    if (isPaperclipSkillSourceMissing(entry) && onLog) {
      await onLog(
        "stderr",
        `[paperclip] Warning: skill "${entry.key}" is enabled for this agent but its files are unavailable and it was not mounted${
          entry.missingDetail ? `: ${entry.missingDetail}` : "."
        }\n`,
      );
    }
  }

  const skillManifest = buildSkillLibraryManifestMarkdown({
    entries: museSkillEntries,
    desiredSkillKeys: desiredSkillNames,
  });

  const stagedCleanup: Array<{ kind: "dir" | "file"; path: string }> = [];
  const ensureCleanupDir = (candidate: string) => stagedCleanup.push({ kind: "dir", path: candidate });

  if (selectedSkills.length > 0) {
    const stagingRoots = [
      { dir: path.join(cwd, ".agents"), skillsDir: path.join(cwd, ".agents", "skills") },
      { dir: path.join(cwd, ".muse"), skillsDir: path.join(cwd, ".muse", "skills") },
    ];

    for (const { dir, skillsDir } of stagingRoots) {
      const dirExisted = await fs.access(dir).then(() => true).catch(() => false);
      if (!dirExisted) {
        await fs.mkdir(dir, { recursive: true });
        ensureCleanupDir(dir);
      }
      const skillsDirExisted = await fs.access(skillsDir).then(() => true).catch(() => false);
      if (!skillsDirExisted) {
        await fs.mkdir(skillsDir, { recursive: true });
        ensureCleanupDir(skillsDir);
      }
      for (const skill of selectedSkills) {
        const target = path.join(skillsDir, skill.runtimeName);
        const targetExists = await fs.access(target).then(() => true).catch(() => false);
        if (targetExists) {
          if (onLog) {
            await onLog("stdout", `[paperclip] Muse skill target already exists at ${target}; leaving it unchanged.\n`);
          }
          continue;
        }
        try {
          await materializePaperclipSkillCopy(skill.source, target);
          ensureCleanupDir(target);
        } catch (err: unknown) {
          if (onLog) {
            await onLog(
              "stderr",
              `[paperclip] Failed to stage skill "${skill.key}" to ${target}: ${
                err instanceof Error ? err.message : String(err)
              }\n`,
            );
          }
        }
      }
    }
  }

  // Instructions
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  let instructionsPrefix = "";
  if (instructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(instructionsFilePath, "utf8");
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`;
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      if (onLog) {
        await onLog("stdout", `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`);
      }
    }
  }

  const promptTemplate = asString(
    config.promptTemplate,
    context.conversationMode === true
      ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE
      : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE
  );
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };

  await hydrateFreshSessionHandoff(ctx, { resumedSession: Boolean(resumeSessionId) });
  const renderedBootstrapPrompt =
    !resumeSessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const { taskContextNote, wakePrompt } = selectPaperclipPromptSections(context, {
    resumedSession: Boolean(resumeSessionId),
    includeCommunicationGuidance: false,
  });
  const shouldUseResumeDeltaPrompt = Boolean(resumeSessionId) && wakePrompt.length > 0;
  const promptInstructionsPrefix = shouldUseResumeDeltaPrompt ? "" : instructionsPrefix;
  const renderedPrompt =
    shouldUseResumeDeltaPrompt || isPaperclipRecoveryWakePayload(context.paperclipWake)
      ? ""
      : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();

  let prompt = joinPromptSections([
    promptInstructionsPrefix,
    skillManifest ? `${skillManifest}\n\n` : "",
    renderedBootstrapPrompt,
    selectInitialCommunicationGuidance(context, { resumedSession: Boolean(resumeSessionId) }),
    wakePrompt,
    sessionHandoffNote,
    taskContextNote,
    renderedPrompt,
  ]);

  if (!prompt || !prompt.trim()) {
    prompt = "Please proceed with your assigned tasks.";
  }

  const tmpPrompt = path.join(os.tmpdir(), `muse-prompt-${runId}.txt`);
  await fs.writeFile(tmpPrompt, prompt, "utf8");

  const args = [
    "exec",
    "--json",
    "--yolo",
    "--workspace",
    cwd,
    "--prompt-file",
    tmpPrompt,
  ];

  if (resumeSessionId) {
    args.push("--session-id", resumeSessionId);
  }

  const model = asString(config.model, "muse-wonder-1.0");
  args.push("--model", model);

  const effort = config.reasoningEffort || config.effort || config.modelReasoningEffort;
  if (effort && effort !== "auto") {
    args.push("--reasoning-effort", String(effort));
  }
  if (config.extraArgs && Array.isArray(config.extraArgs)) {
    args.push(...(config.extraArgs as string[]));
  }

  if (onMeta) {
    await onMeta({
      adapterType: "muse_local",
      command,
      cwd,
      commandArgs: args,
      env,
      prompt,
      context,
    });
  }

  let stdout = "";
  let stderr = "";
  let resolvedSessionId = resumeSessionId;
  let summary = "";
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
  };

  try {
    const proc = await runAdapterExecutionTargetProcess(runId, executionTarget, command, args, {
      cwd,
      env,
      timeoutSec: asNumber(config.timeoutSec, 600),
      graceSec: asNumber(config.graceSec, 15),
      onSpawn,
      onRuntimeProgress: ctx.onRuntimeProgress,
      onLog: async (stream, chunk) => {
        if (onLog) {
          await onLog(stream, chunk);
        }
        if (stream === "stdout") {
          stdout += chunk;
        } else {
          stderr += chunk;
        }
      },
    });

    // Parse events from stdout
    const lines = stdout.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as {
          stream?: { kind?: string; id?: string };
          payload_type?: string;
          payload?: { text?: string; models?: Array<{ input_tokens?: number; output_tokens?: number; cached_tokens?: number }> };
        };
        if (obj.stream?.kind === "session" && obj.stream?.id) {
          resolvedSessionId = obj.stream.id;
        }
        if (obj.payload_type === "run.terminal.completed" && obj.payload?.text) {
          summary = obj.payload.text;
        }
        if (obj.payload_type === "run.usage" && Array.isArray(obj.payload?.models)) {
          for (const m of obj.payload.models) {
            usage.inputTokens += asNumber(m.input_tokens, 0);
            usage.outputTokens += asNumber(m.output_tokens, 0);
            usage.cachedInputTokens += asNumber(m.cached_tokens, 0);
          }
        }
      } catch {}
    }

    // Sync back credentials if updated
    if (env.MUSE_AUTH_PATH && env.MUSE_AUTH_PATH !== targetAuth) {
      try {
        const updated = await fs.readFile(targetAuth, "utf8");
        await fs.writeFile(env.MUSE_AUTH_PATH, updated, { mode: 0o600 });
      } catch {}
    }

    const failed = (proc.exitCode ?? 0) !== 0;
    const errorMessage = failed
      ? (proc.stderr?.trim() || `Muse exited with code ${proc.exitCode ?? -1}`)
      : null;

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: proc.timedOut,
      errorMessage,
      errorCode: failed ? "muse_failed" : null,
      errorFamily: null,
      retryNotBefore: null,
      usage,
      usageBasis: "per_run",
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionId ? { sessionId: resolvedSessionId, cwd } : null,
      sessionDisplayId: resolvedSessionId,
      provider: "muse",
      biller: "meta",
      model,
      billingType: "subscription",
      costUsd: null,
      resultJson: {
        stdout: proc.stdout,
        stderr: proc.stderr,
      },
      summary: summary || (failed ? "" : "Task completed."),
      clearSession: false,
    };
  } finally {
    await fs.unlink(tmpPrompt).catch(() => {});
    for (const entry of [...stagedCleanup].reverse()) {
      if (entry.kind === "file") {
        await fs.rm(entry.path, { force: true }).catch(() => undefined);
      } else {
        await fs.rm(entry.path, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}
