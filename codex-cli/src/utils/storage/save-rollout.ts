import type { ResponseItem } from "openai/resources/responses/responses";

import { loadConfig } from "../config";
import { log } from "../logger/log.js";
import fs from "fs/promises";
import os from "os";
import path from "path";

const SESSIONS_ROOT = path.join(os.homedir(), ".codex", "sessions");

async function saveRolloutAsync(
  sessionId: string,
  items: Array<ResponseItem>,
): Promise<void> {
  // Ensure sessions root exists
  await fs.mkdir(SESSIONS_ROOT, { recursive: true });
  // Prepare error directory for sessions with tool call errors
  const errorsRoot = path.join(SESSIONS_ROOT, "errors");
  await fs.mkdir(errorsRoot, { recursive: true });
  // Determine if any tool call in this session resulted in an error (non-zero exitCode)
  const hasError = items.some((item) => {
    // Only tool call output items include tool output metadata
    const t = (item as any).type;
    if (t === 'function_call_output' || t === 'local_shell_call_output') {
      try {
        const parsed = JSON.parse((item as any).output || '{}');
        const meta = parsed.metadata as { exitCode?: number; error?: unknown } | undefined;
        // Treat non-zero exit codes or explicit errors as failures
        if (meta) {
          if (meta.exitCode !== undefined && meta.exitCode !== 0) return true;
          if (meta.error !== undefined) return true;
        }
      } catch {
        return false;
      }
    }
    return false;
  });
  const targetRoot = hasError ? errorsRoot : SESSIONS_ROOT;
  // Build filename and path
  const timestamp = new Date().toISOString();
  const ts = timestamp.replace(/[:.]/g, "-").slice(0, 10);
  const filename = `rollout-${ts}-${sessionId}.json`;
  const filePath = path.join(targetRoot, filename);
  const config = loadConfig();

  try {
    // Include session_id and model in the saved rollout metadata
    const sessionMeta = {
      session_id: sessionId,
      model: config.model,
      timestamp,
      instructions: config.instructions,
    };
    await fs.writeFile(
      filePath,
      JSON.stringify(
        {
          session: sessionMeta,
          items,
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch (error) {
    log(`error: failed to save rollout to ${filePath}: ${error}`);
  }
}

export function saveRollout(
  sessionId: string,
  items: Array<ResponseItem>,
): void {
  // Best-effort. We also do not log here in case of failure as that should be taken care of
  // by `saveRolloutAsync` already.
  saveRolloutAsync(sessionId, items).catch(() => {});
}
