import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectMetrics } from "../server.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "codex-token-dashboard-"));
try {
  const dayDir = path.join(root, "2026", "04", "27");
  await mkdir(dayDir, { recursive: true });
  await writeFile(
    path.join(dayDir, "rollout.jsonl"),
    [
      JSON.stringify({
        timestamp: "2026-04-27T01:00:00.000Z",
        type: "session_meta",
        payload: { id: "session-1", timestamp: "2026-04-27T01:00:00.000Z", model_provider: "openai" },
      }),
      JSON.stringify({
        timestamp: "2026-04-27T01:00:01.000Z",
        type: "turn_context",
        payload: { model: "gpt-5.2-codex" },
      }),
      JSON.stringify({
        timestamp: "2026-04-27T01:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Build the token report" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-27T01:01:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 500,
              output_tokens: 100,
              reasoning_output_tokens: 25,
              total_tokens: 1100,
            },
          },
        },
      }),
      JSON.stringify({
        timestamp: "2026-04-27T01:02:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 1600,
              cached_input_tokens: 900,
              output_tokens: 160,
              reasoning_output_tokens: 40,
              total_tokens: 1760,
            },
          },
        },
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const metrics = await collectMetrics({ sessionsRoot: root, range: "all" });
  assert.equal(metrics.scannedFiles, 1);
  assert.equal(metrics.logicalSessions, 1);
  assert.equal(metrics.activeSessions, 1);
  assert.equal(metrics.byModel.length, 1);
  assert.equal(metrics.byModel[0].key, "gpt-5.2-codex");
  assert.equal(metrics.byDay.length, 1);
  assert.equal(metrics.byDay[0].key, "2026-04-27");
  assert.equal(metrics.byDay[0].totals.totalTokens, 1760);
  assert.ok(metrics.byDay[0].cost.totalUsd > 0);
  assert.equal(metrics.totals.totalTokens, 1760);
  assert.equal(metrics.totals.inputTokens, 1600);
  assert.equal(metrics.totals.cachedInputTokens, 900);
  assert.equal(metrics.totals.outputTokens, 160);
  assert.ok(metrics.cost.totalUsd > 0);
  assert.equal(metrics.cost.unpricedEvents, 0);
  assert.equal(metrics.sessions[0].title, "Build the token report");
  console.log("smoke ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
