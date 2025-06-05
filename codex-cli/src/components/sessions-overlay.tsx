import type { TypeaheadItem } from "./typeahead-overlay.js";

import TypeaheadOverlay from "./typeahead-overlay.js";
import fs from "fs/promises";
import { Box, Text, useInput } from "ink";
import os from "os";
import path from "path";
import React, { useEffect, useState } from "react";

const SESSIONS_ROOT = path.join(os.homedir(), ".codex", "sessions");
const ERRORS_ROOT = path.join(SESSIONS_ROOT, "errors");

export type SessionMeta = {
  path: string;
  timestamp: string;
  userMessages: number;
  toolCalls: number;
  firstMessage: string;
};

async function loadSessions(): Promise<Array<SessionMeta>> {
  const sessions: Array<SessionMeta> = [];
  // Load sessions from main root and error subdirectory
  const roots = [SESSIONS_ROOT, ERRORS_ROOT];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = await fs.readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const filePath = path.join(root, entry);
      try {
        // eslint-disable-next-line no-await-in-loop
        const content = await fs.readFile(filePath, "utf-8");
        const data = JSON.parse(content) as {
          session?: { timestamp?: string };
          items?: Array<{
            type: string;
            role: string;
            content: Array<{ text: string }>;
          }>;
        };
        const items = Array.isArray(data.items) ? data.items : [];
        const firstUser = items.find(
          (i) => i?.type === "message" && i.role === "user",
        );
        const firstText =
          firstUser?.content?.[0]?.text?.replace(/\n/g, " ").slice(0, 16) ?? "";
        const userMessages = items.filter(
          (i) => i?.type === "message" && i.role === "user",
        ).length;
        const toolCalls = items.filter(
          (i) => i?.type === "function_call",
        ).length;
        sessions.push({
          path: filePath,
          timestamp: data.session?.timestamp || "",
          userMessages,
          toolCalls,
          firstMessage: firstText,
        });
      } catch {
        /* ignore invalid session */
      }
    }
  }
  // Sort by timestamp descending
  sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return sessions;
}

type Props = {
  onView: (sessionPath: string) => void;
  onResume: (sessionPath: string) => void;
  onExit: () => void;
};

export default function SessionsOverlay({
  onView,
  onResume,
  onExit,
}: Props): JSX.Element {
  const [items, setItems] = useState<Array<TypeaheadItem>>([]);
  const [mode, setMode] = useState<"view" | "resume">("view");

  useEffect(() => {
    (async () => {
      const sessions = await loadSessions();
      const formatted = sessions.map((s) => {
        const ts = s.timestamp
          ? new Date(s.timestamp).toLocaleString(undefined, {
              dateStyle: "short",
              timeStyle: "short",
            })
          : "";
        const first = s.firstMessage?.slice(0, 50);
        const label = `${ts} · ${s.userMessages} msgs/${s.toolCalls} tools · ${first}`;
        return { label, value: s.path } as TypeaheadItem;
      });
      setItems(formatted);
    })();
  }, []);

  useInput((_input, key) => {
    if (key.tab) {
      setMode((m) => (m === "view" ? "resume" : "view"));
    }
  });

  return (
    <TypeaheadOverlay
      title={mode === "view" ? "View session" : "Resume session"}
      description={
        <Box flexDirection="column">
          <Text>
            {mode === "view" ? "press enter to view" : "press enter to resume"}
          </Text>
          <Text dimColor>tab to toggle mode · esc to cancel</Text>
        </Box>
      }
      initialItems={items}
      onSelect={(value) => {
        if (mode === "view") {
          onView(value);
        } else {
          onResume(value);
        }
      }}
      onExit={onExit}
    />
  );
}
