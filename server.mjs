#!/usr/bin/env node

import http from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_PORT = Number(process.env.CODEX_TOKEN_DASHBOARD_PORT || process.env.PORT || 8766);
const DEFAULT_HOST = process.env.CODEX_TOKEN_DASHBOARD_HOST || "127.0.0.1";
const DEFAULT_SESSIONS_ROOT =
  process.env.CODEX_TOKEN_DASHBOARD_SESSIONS_ROOT ||
  path.join(os.homedir(), ".codex", "sessions");

const PRICING_SOURCE_URL = "https://developers.openai.com/api/docs/pricing";
const METRICS_CACHE_TTL_MS = Number(process.env.CODEX_TOKEN_DASHBOARD_CACHE_TTL_MS || 10_000);
const MAX_FILE_CACHE_ENTRIES = Number(process.env.CODEX_TOKEN_DASHBOARD_FILE_CACHE_ENTRIES || 1_000);
const fileCache = new Map();
const metricsCache = new Map();
const inFlightMetrics = new Map();

const BASE_PRICING = {
  "gpt-5.5": {
    input: 5,
    cachedInput: 0.5,
    output: 30,
    note: "OpenAI Standard short-context flagship rate.",
  },
  "gpt-5.4": {
    input: 2.5,
    cachedInput: 0.25,
    output: 15,
    note: "OpenAI Standard short-context flagship rate.",
  },
  "gpt-5.2": {
    input: 1.75,
    cachedInput: 0.175,
    output: 14,
    note: "OpenAI Standard short-context flagship rate.",
  },
  "gpt-5.1": {
    input: 1.25,
    cachedInput: 0.125,
    output: 10,
    note: "OpenAI Standard short-context flagship rate.",
  },
  "gpt-5": {
    input: 1.25,
    cachedInput: 0.125,
    output: 10,
    note: "OpenAI Standard short-context flagship rate.",
  },
  "gpt-5-mini": {
    input: 0.25,
    cachedInput: 0.025,
    output: 2,
    note: "OpenAI Standard short-context flagship rate.",
  },
  "gpt-5-nano": {
    input: 0.05,
    cachedInput: 0.005,
    output: 0.4,
    note: "OpenAI Standard short-context flagship rate.",
  },
  "gpt-4.1": {
    input: 2,
    cachedInput: 0.5,
    output: 8,
    note: "OpenAI Standard token rate.",
  },
};

const MODEL_ALIASES = {
  "gpt-5.2-codex": {
    pricingModel: "gpt-5.2",
    estimated: false,
    note: "Local Codex log alias mapped to official gpt-5.2 pricing.",
  },
  "gpt-5-codex": {
    pricingModel: "gpt-5",
    estimated: false,
    note: "Local Codex log alias mapped to official gpt-5 pricing.",
  },
  "gpt-5.3-codex": {
    pricingModel: null,
    estimated: false,
    note: "No official matching GPT pricing row in the provided OpenAI pricing table.",
  },
};

const PRO_PRICING = {
  "gpt-5.5-pro": {
    input: 30,
    cachedInput: null,
    output: 180,
    note: "OpenAI Standard short-context pro rate.",
  },
  "gpt-5.4-pro": {
    input: 30,
    cachedInput: null,
    output: 180,
    note: "OpenAI Standard short-context pro rate.",
  },
  "gpt-5.2-pro": {
    input: 21,
    cachedInput: null,
    output: 168,
    note: "OpenAI Standard short-context pro rate.",
  },
  "gpt-5-pro": {
    input: 15,
    cachedInput: null,
    output: 120,
    note: "OpenAI Standard short-context pro rate.",
  },
};

const MINI_NANO_PRICING = {
  "gpt-5.4-mini": {
    input: 0.75,
    cachedInput: 0.075,
    output: 4.5,
    note: "OpenAI Standard short-context flagship rate.",
  },
  "gpt-5.4-nano": {
    input: 0.2,
    cachedInput: 0.02,
    output: 1.25,
    note: "OpenAI Standard short-context flagship rate.",
  },
};

Object.assign(BASE_PRICING, PRO_PRICING, MINI_NANO_PRICING);

const LONG_CONTEXT_PRICING = {
  "gpt-5.5": {
    input: 10,
    cachedInput: 1,
    output: 45,
    note: "OpenAI Standard long-context flagship rate.",
  },
  "gpt-5.5-pro": {
    input: 60,
    cachedInput: null,
    output: 270,
    note: "OpenAI Standard long-context pro rate.",
  },
  "gpt-5.4": {
    input: 5,
    cachedInput: 0.5,
    output: 22.5,
    note: "OpenAI Standard long-context flagship rate.",
  },
  "gpt-5.4-pro": {
    input: 60,
    cachedInput: null,
    output: 270,
    note: "OpenAI Standard long-context pro rate.",
  },
};

function loadPricing() {
  if (!process.env.CODEX_TOKEN_DASHBOARD_PRICING_JSON) return BASE_PRICING;
  try {
    return {
      ...BASE_PRICING,
      ...JSON.parse(process.env.CODEX_TOKEN_DASHBOARD_PRICING_JSON),
    };
  } catch {
    return BASE_PRICING;
  }
}

const PRICING = loadPricing();

function zeroTotals() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

function cloneTotals(value = {}) {
  return {
    inputTokens: safeInt(value.inputTokens),
    cachedInputTokens: safeInt(value.cachedInputTokens),
    outputTokens: safeInt(value.outputTokens),
    reasoningOutputTokens: safeInt(value.reasoningOutputTokens),
    totalTokens: safeInt(value.totalTokens),
  };
}

function safeInt(value) {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function totalsFromUsage(usage = {}) {
  return {
    inputTokens: safeInt(usage.input_tokens),
    cachedInputTokens: safeInt(usage.cached_input_tokens),
    outputTokens: safeInt(usage.output_tokens),
    reasoningOutputTokens: safeInt(usage.reasoning_output_tokens),
    totalTokens: safeInt(usage.total_tokens),
  };
}

function addTotals(target, delta) {
  target.inputTokens += delta.inputTokens;
  target.cachedInputTokens += delta.cachedInputTokens;
  target.outputTokens += delta.outputTokens;
  target.reasoningOutputTokens += delta.reasoningOutputTokens;
  target.totalTokens += delta.totalTokens;
}

function subtractTotals(current, previous) {
  if (!previous) return cloneTotals(current);
  return {
    inputTokens: current.inputTokens - previous.inputTokens,
    cachedInputTokens: current.cachedInputTokens - previous.cachedInputTokens,
    outputTokens: current.outputTokens - previous.outputTokens,
    reasoningOutputTokens: current.reasoningOutputTokens - previous.reasoningOutputTokens,
    totalTokens: current.totalTokens - previous.totalTokens,
  };
}

function hasPositiveTotals(value) {
  return (
    value.inputTokens > 0 ||
    value.cachedInputTokens > 0 ||
    value.outputTokens > 0 ||
    value.reasoningOutputTokens > 0 ||
    value.totalTokens > 0
  );
}

function hasNegativeTotals(value) {
  return (
    value.inputTokens < 0 ||
    value.cachedInputTokens < 0 ||
    value.outputTokens < 0 ||
    value.reasoningOutputTokens < 0 ||
    value.totalTokens < 0
  );
}

function normalizeModel(value) {
  return String(value || "unknown").trim() || "unknown";
}

function pricingFor(model) {
  const normalized = normalizeModel(model).toLowerCase();
  const alias = MODEL_ALIASES[normalized];
  if (alias?.pricingModel === null) return null;
  const lookupModel = alias?.pricingModel || normalized;
  if (PRICING[lookupModel]) {
    return {
      model: lookupModel,
      ...PRICING[lookupModel],
      estimated: Boolean(PRICING[lookupModel].estimated || alias?.estimated),
      note: alias?.note || PRICING[lookupModel].note,
    };
  }
  if (normalized.startsWith("gpt-5.5-pro")) return { model: "gpt-5.5-pro", ...PRICING["gpt-5.5-pro"] };
  if (normalized.startsWith("gpt-5.5")) return { model: "gpt-5.5", ...PRICING["gpt-5.5"] };
  if (normalized.startsWith("gpt-5.4-pro")) return { model: "gpt-5.4-pro", ...PRICING["gpt-5.4-pro"] };
  if (normalized.startsWith("gpt-5.4-mini")) return { model: "gpt-5.4-mini", ...PRICING["gpt-5.4-mini"] };
  if (normalized.startsWith("gpt-5.4-nano")) return { model: "gpt-5.4-nano", ...PRICING["gpt-5.4-nano"] };
  if (normalized.startsWith("gpt-5.4")) return { model: "gpt-5.4", ...PRICING["gpt-5.4"] };
  if (normalized.startsWith("gpt-5.2-pro")) return { model: "gpt-5.2-pro", ...PRICING["gpt-5.2-pro"] };
  if (normalized.startsWith("gpt-5.2")) return { model: "gpt-5.2", ...PRICING["gpt-5.2"] };
  if (normalized.startsWith("gpt-5.1")) return { model: "gpt-5.1", ...PRICING["gpt-5.1"] };
  if (normalized.startsWith("gpt-5-mini")) return { model: "gpt-5-mini", ...PRICING["gpt-5-mini"] };
  if (normalized.startsWith("gpt-5-nano")) return { model: "gpt-5-nano", ...PRICING["gpt-5-nano"] };
  if (normalized.startsWith("gpt-5-pro")) return { model: "gpt-5-pro", ...PRICING["gpt-5-pro"] };
  if (normalized === "gpt-5" || normalized.startsWith("gpt-5-")) return { model: "gpt-5", ...PRICING["gpt-5"] };
  if (normalized.startsWith("gpt-4.1")) return { model: "gpt-4.1", ...PRICING["gpt-4.1"] };
  return null;
}

function costFor(model, totals) {
  const pricing = pricingFor(model);
  if (!pricing) {
    return {
      totalUsd: 0,
      inputUsd: 0,
      cachedInputUsd: 0,
      outputUsd: 0,
      priced: false,
      estimated: false,
      pricingModel: null,
      note: "No matching OpenAI pricing entry.",
    };
  }

  const cachedInput = pricing.cachedInput === null ? 0 : Math.min(totals.cachedInputTokens, totals.inputTokens);
  const billableInput = Math.max(0, totals.inputTokens - cachedInput);
  const inputUsd = (billableInput / 1_000_000) * pricing.input;
  const cachedInputUsd = (cachedInput / 1_000_000) * (pricing.cachedInput || 0);
  const outputUsd = (totals.outputTokens / 1_000_000) * pricing.output;

  return {
    totalUsd: inputUsd + cachedInputUsd + outputUsd,
    inputUsd,
    cachedInputUsd,
    outputUsd,
    priced: true,
    estimated: Boolean(pricing.estimated),
    pricingModel: pricing.model,
    note: pricing.note,
  };
}

function addCost(target, delta) {
  target.totalUsd += delta.totalUsd;
  target.inputUsd += delta.inputUsd;
  target.cachedInputUsd += delta.cachedInputUsd;
  target.outputUsd += delta.outputUsd;
  if (!delta.priced) target.unpricedEvents += 1;
  if (delta.estimated) target.estimatedEvents += 1;
}

function zeroCost() {
  return {
    totalUsd: 0,
    inputUsd: 0,
    cachedInputUsd: 0,
    outputUsd: 0,
    unpricedEvents: 0,
    estimatedEvents: 0,
  };
}

function mergeBucket(map, key, delta, model) {
  if (!map.has(key)) {
    map.set(key, {
      key,
      totals: zeroTotals(),
      cost: zeroCost(),
      models: new Map(),
      events: 0,
    });
  }
  const bucket = map.get(key);
  addTotals(bucket.totals, delta);
  addCost(bucket.cost, costFor(model, delta));
  bucket.models.set(model, (bucket.models.get(model) || 0) + delta.totalTokens);
  bucket.events += 1;
  return bucket;
}

function localDay(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeTitle(text, limit = 120) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 3).trim()}...`;
}

function isNoiseTitle(text) {
  const lowered = String(text || "").toLowerCase();
  return [
    "agents.md instructions",
    "<instructions>",
    "<environment_context>",
    "filesystem sandboxing defines",
    "# codex desktop context",
    "<app-context>",
    "<skills_instructions>",
  ].some((marker) => lowered.includes(marker));
}

function shouldParseLine(line, hasTitle) {
  return (
    line.includes('"type":"session_meta"') ||
    line.includes('"type":"turn_context"') ||
    line.includes('"type":"token_count"') ||
    (!hasTitle && line.includes('"type":"response_item"') && line.includes('"role":"user"'))
  );
}

function fileChanged(left, right) {
  return left.size !== right.size || left.mtimeMs !== right.mtimeMs;
}

function cacheFileRollout(fileInfo, rollout) {
  fileCache.set(fileInfo.file, {
    size: fileInfo.size,
    mtimeMs: fileInfo.mtimeMs,
    lastUsed: Date.now(),
    rollout,
  });
  if (fileCache.size <= MAX_FILE_CACHE_ENTRIES) return;
  const entries = [...fileCache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  for (const [file] of entries.slice(0, fileCache.size - MAX_FILE_CACHE_ENTRIES)) {
    fileCache.delete(file);
  }
}

async function listJsonlFiles(root) {
  const files = [];
  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(next);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const info = await stat(next);
          files.push({
            file: next,
            size: info.size,
            mtimeMs: info.mtimeMs,
          });
        } catch {
          // The Codex session directory can change while we scan it.
        }
      }
    }
  }
  await walk(root);
  return files.sort((left, right) => left.file.localeCompare(right.file));
}

function filesForRange(files, rangeInfo) {
  if (!rangeInfo.since) return files;
  const sinceMs = rangeInfo.since.getTime();
  return files.filter((file) => file.mtimeMs >= sinceMs);
}

async function parseSessionFile(fileInfo) {
  const rollout = {
    file: fileInfo.file,
    sessionId: "",
    title: "",
    provider: "",
    originator: "",
    source: "",
    cwd: "",
    cliVersion: "",
    startedAt: null,
    latestModel: "unknown",
    parseErrors: 0,
    events: [],
  };
  let currentModel = "unknown";

  const input = createReadStream(fileInfo.file, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!shouldParseLine(line, Boolean(rollout.title))) continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      rollout.parseErrors += 1;
      continue;
    }

    if (record.type === "session_meta") {
      const payload = record.payload || {};
      rollout.sessionId ||= String(payload.id || "");
      rollout.provider ||= String(payload.model_provider || "");
      rollout.originator ||= String(payload.originator || "");
      rollout.source ||= String(payload.source || "");
      rollout.cwd ||= String(payload.cwd || "");
      rollout.cliVersion ||= String(payload.cli_version || "");
      rollout.startedAt ||= parseTimestamp(payload.timestamp || record.timestamp);
      continue;
    }

    if (record.type === "turn_context") {
      const payload = record.payload || {};
      currentModel = normalizeModel(payload.model || currentModel);
      rollout.latestModel = currentModel;
      rollout.startedAt ||= parseTimestamp(record.timestamp);
      continue;
    }

    if (record.type === "response_item" && !rollout.title) {
      const payload = record.payload || {};
      if (payload.type === "message" && payload.role === "user") {
        for (const item of payload.content || []) {
          if (item.type !== "input_text") continue;
          const title = normalizeTitle(item.text);
          if (title && !isNoiseTitle(title)) {
            rollout.title = title;
            break;
          }
        }
      }
      continue;
    }

    if (record.type !== "event_msg") continue;
    const payload = record.payload || {};
    if (payload.type !== "token_count") continue;
    const info = payload.info || {};
    if (!info.total_token_usage) continue;

    const timestamp = parseTimestamp(record.timestamp);
    if (!timestamp) continue;

    rollout.events.push({
      timestamp,
      model: normalizeModel(currentModel || rollout.latestModel),
      totals: totalsFromUsage(info.total_token_usage),
      lastTotals: info.last_token_usage ? totalsFromUsage(info.last_token_usage) : null,
    });
  }

  return rollout;
}

async function parseSessionFileCached(fileInfo) {
  const cached = fileCache.get(fileInfo.file);
  if (cached && !fileChanged(cached, fileInfo)) {
    cached.lastUsed = Date.now();
    return cached.rollout;
  }

  try {
    const rollout = await parseSessionFile(fileInfo);
    cacheFileRollout(fileInfo, rollout);
    return rollout;
  } catch {
    const rollout = {
      file: fileInfo.file,
      sessionId: "",
      title: "",
      provider: "",
      originator: "",
      source: "",
      cwd: "",
      cliVersion: "",
      startedAt: null,
      latestModel: "unknown",
      parseErrors: 1,
      events: [],
    };
    cacheFileRollout(fileInfo, rollout);
    return rollout;
  }
}

function resolveRange(range) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (range === "today") return { since: todayStart, label: "Today" };
  if (range === "7d") {
    const since = new Date(todayStart);
    since.setDate(since.getDate() - 6);
    return { since, label: "Last 7 days" };
  }
  if (range === "30d") {
    const since = new Date(todayStart);
    since.setDate(since.getDate() - 29);
    return { since, label: "Last 30 days" };
  }
  return { since: null, label: "All time" };
}

function inRange(date, rangeInfo) {
  return !rangeInfo.since || date >= rangeInfo.since;
}

function summarizeModels(modelMap) {
  return [...modelMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([model, totalTokens]) => ({ model, totalTokens }));
}

function dominantModel(modelMap) {
  const models = summarizeModels(modelMap);
  return models[0]?.model || "unknown";
}

function bucketToJson(bucket) {
  return {
    key: bucket.key,
    totals: bucket.totals,
    cost: bucket.cost,
    models: summarizeModels(bucket.models),
    events: bucket.events,
  };
}

export async function collectMetrics(options = {}) {
  const sessionsRoot = path.resolve(options.sessionsRoot || DEFAULT_SESSIONS_ROOT);
  const range = options.range || "all";
  const rangeInfo = resolveRange(range);
  const files = await listJsonlFiles(sessionsRoot);
  const candidateFiles = filesForRange(files, rangeInfo);
  const groups = new Map();
  let parseErrors = 0;

  for (const file of candidateFiles) {
    const rollout = await parseSessionFileCached(file);
    parseErrors += rollout.parseErrors;
    const key = rollout.sessionId || file.file;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rollout);
  }

  const totals = zeroTotals();
  const cost = zeroCost();
  const byModel = new Map();
  const byDay = new Map();
  const sessions = [];
  let eventCount = 0;
  let firstEventAt = null;
  let lastEventAt = null;

  for (const [sessionId, rollouts] of groups.entries()) {
    const events = rollouts.flatMap((rollout) => rollout.events);
    events.sort((left, right) => {
      const timeDelta = left.timestamp.getTime() - right.timestamp.getTime();
      if (timeDelta !== 0) return timeDelta;
      return left.totals.totalTokens - right.totals.totalTokens;
    });

    let previousTotals = null;
    const sessionTotals = zeroTotals();
    const sessionCost = zeroCost();
    const sessionModels = new Map();
    let includedEvents = 0;

    for (const event of events) {
      let delta = subtractTotals(event.totals, previousTotals);
      if (
        rangeInfo.since &&
        previousTotals === null &&
        inRange(event.timestamp, rangeInfo) &&
        event.lastTotals &&
        hasPositiveTotals(event.lastTotals)
      ) {
        delta = cloneTotals(event.lastTotals);
      }
      if (delta.totalTokens < 0 || hasNegativeTotals(delta)) {
        if (event.lastTotals && hasPositiveTotals(event.lastTotals)) {
          delta = cloneTotals(event.lastTotals);
        } else {
          continue;
        }
      }

      if (previousTotals === null || event.totals.totalTokens > previousTotals.totalTokens) {
        previousTotals = event.totals;
      }

      if (!hasPositiveTotals(delta) || !inRange(event.timestamp, rangeInfo)) continue;

      const model = normalizeModel(event.model);
      const eventCost = costFor(model, delta);
      addTotals(totals, delta);
      addCost(cost, eventCost);
      addTotals(sessionTotals, delta);
      addCost(sessionCost, eventCost);
      sessionModels.set(model, (sessionModels.get(model) || 0) + delta.totalTokens);
      mergeBucket(byModel, model, delta, model);
      mergeBucket(byDay, localDay(event.timestamp), delta, model);
      eventCount += 1;
      includedEvents += 1;
      if (!firstEventAt || event.timestamp < firstEventAt) firstEventAt = event.timestamp;
      if (!lastEventAt || event.timestamp > lastEventAt) lastEventAt = event.timestamp;
    }

    if (includedEvents > 0) {
      const firstRollout = rollouts
        .slice()
        .sort((left, right) => (left.startedAt?.getTime() || 0) - (right.startedAt?.getTime() || 0))[0];
      sessions.push({
        sessionId,
        title: rollouts.find((rollout) => rollout.title)?.title || "(untitled)",
        startedAt: firstRollout?.startedAt?.toISOString() || null,
        cwd: rollouts.find((rollout) => rollout.cwd)?.cwd || "",
        source: rollouts.find((rollout) => rollout.source)?.source || "",
        originator: rollouts.find((rollout) => rollout.originator)?.originator || "",
        cliVersion: rollouts.find((rollout) => rollout.cliVersion)?.cliVersion || "",
        model: dominantModel(sessionModels),
        models: summarizeModels(sessionModels),
        totals: sessionTotals,
        cost: sessionCost,
        events: includedEvents,
      });
    }
  }

  const modelRows = [...byModel.values()]
    .map(bucketToJson)
    .sort((left, right) => right.totals.totalTokens - left.totals.totalTokens);
  const dayRows = [...byDay.values()]
    .map(bucketToJson)
    .sort((left, right) => right.key.localeCompare(left.key));

  sessions.sort((left, right) => {
    const leftDate = left.startedAt ? new Date(left.startedAt).getTime() : 0;
    const rightDate = right.startedAt ? new Date(right.startedAt).getTime() : 0;
    return rightDate - leftDate;
  });

  return {
    generatedAt: new Date().toISOString(),
    sessionsRoot,
    range,
    rangeLabel: rangeInfo.label,
    scannedFiles: candidateFiles.length,
    totalFiles: files.length,
    logicalSessions: groups.size,
    activeSessions: sessions.length,
    eventCount,
    parseErrors,
    firstEventAt: firstEventAt?.toISOString() || null,
    lastEventAt: lastEventAt?.toISOString() || null,
    totals,
    cost,
    byModel: modelRows,
    byDay: dayRows,
    sessions: sessions.slice(0, 100),
    pricing: {
      sourceUrl: PRICING_SOURCE_URL,
      mode: "OpenAI Standard short-context token rates, USD per 1M tokens.",
      outputNote: "reasoning_output_tokens is displayed separately, but it is not added again because output_tokens is used for output billing.",
      models: PRICING,
    },
  };
}

function metricsCacheKey(options) {
  return `${path.resolve(options.sessionsRoot || DEFAULT_SESSIONS_ROOT)}:${options.range || "all"}`;
}

async function collectMetricsForRequest(options = {}) {
  const key = metricsCacheKey(options);
  const now = Date.now();
  const cached = metricsCache.get(key);
  if (cached && now - cached.cachedAt < METRICS_CACHE_TTL_MS) {
    return cached.value;
  }

  const inFlight = inFlightMetrics.get(key);
  if (inFlight) return inFlight;

  const promise = collectMetrics(options)
    .then((value) => {
      metricsCache.set(key, { cachedAt: Date.now(), value });
      return value;
    })
    .finally(() => {
      inFlightMetrics.delete(key);
    });
  inFlightMetrics.set(key, promise);
  return promise;
}

function htmlPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Codex Token Dashboard</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #ffffff;
      --subtle: #f7f7f5;
      --panel: #ffffff;
      --line: #e5e5e0;
      --line-strong: #d6d6d0;
      --text: #202123;
      --muted: #6e6e6a;
      --soft-text: #4b5563;
      --accent: #10a37f;
      --accent-dark: #0e8f70;
      --accent-soft: #e7f8f2;
      --warn: #b45309;
      --danger-soft: #fff7ed;
      --shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
    }
    * { box-sizing: border-box; }
    html {
      overflow-x: hidden;
    }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
      line-height: 1.5;
      overflow-x: hidden;
    }
    header {
      border-bottom: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.94);
      position: sticky;
      top: 0;
      z-index: 5;
      backdrop-filter: blur(14px);
    }
    .bar {
      max-width: 1160px;
      margin: 0 auto;
      padding: 14px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
    }
    h1 {
      margin: 0;
      font-size: 16px;
      font-weight: 650;
      letter-spacing: 0;
    }
    .brand-sub {
      margin-top: 2px;
      color: var(--muted);
      font-size: 12px;
    }
    .controls {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .range-segment,
    .lang-segment {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      min-height: 38px;
      padding: 3px;
      border-radius: 8px;
      background: #ececea;
      border: 1px solid #e2e2de;
    }
    .range-button,
    .lang-button {
      border: 0;
      background: transparent;
      color: #5f5f5b;
      min-height: 30px;
      border-radius: 7px;
      padding: 0 13px;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }
    .range-button.is-active,
    .lang-button.is-active {
      background: #ffffff;
      color: var(--text);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
    }
    button.primary {
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--text);
      min-height: 38px;
      border-radius: 7px;
      padding: 0 14px;
      font: inherit;
      cursor: pointer;
      font-weight: 650;
    }
    button.primary {
      border-color: var(--accent-dark);
      background: var(--accent);
      color: white;
    }
    button.primary:disabled {
      opacity: 0.64;
      cursor: default;
    }
    main {
      max-width: 1160px;
      margin: 0 auto;
      padding: 34px 24px 56px;
    }
    .hero {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      gap: 24px;
      margin-bottom: 26px;
    }
    .eyebrow {
      margin: 0 0 8px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 600;
    }
    .hero-title {
      margin: 0;
      max-width: 760px;
      font-size: clamp(34px, 4vw, 56px);
      line-height: 1.04;
      font-weight: 700;
      letter-spacing: 0;
    }
    .hero-meta {
      min-width: 240px;
      color: var(--muted);
      font-size: 13px;
      text-align: right;
    }
    .hero-meta strong {
      color: var(--text);
      font-weight: 650;
    }
    .overview {
      display: grid;
      grid-template-columns: 1.1fr 1fr 1fr 1fr;
      border: 1px solid var(--line-strong);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: var(--shadow);
      overflow: hidden;
      margin-bottom: 30px;
    }
    .metric {
      min-width: 0;
      padding: 22px 24px;
      border-right: 1px solid var(--line);
    }
    .metric:last-child { border-right: 0; }
    .label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 10px;
    }
    .value {
      font-size: clamp(26px, 3vw, 40px);
      line-height: 1;
      font-weight: 720;
      letter-spacing: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .sub {
      margin-top: 10px;
      color: var(--muted);
      font-size: 13px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .calendar-title-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 12px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .calendar-switch {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      min-height: 34px;
      padding: 3px;
      border-radius: 8px;
      background: #ececea;
      border: 1px solid #e2e2de;
    }
    .calendar-mode-button {
      border: 0;
      background: transparent;
      color: #5f5f5b;
      min-height: 26px;
      min-width: 58px;
      border-radius: 7px;
      padding: 0 10px;
      font: inherit;
      font-size: 13px;
      font-weight: 650;
      cursor: pointer;
      white-space: nowrap;
    }
    .calendar-mode-button.is-active {
      background: #ffffff;
      color: var(--text);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
    }
    .calendar-wrap {
      padding: 16px;
      overflow: auto;
    }
    .calendar-weekdays,
    .calendar-grid {
      display: grid;
      grid-template-columns: repeat(7, minmax(88px, 1fr));
      gap: 8px;
      min-width: 700px;
    }
    .calendar-weekdays {
      margin-bottom: 8px;
    }
    .calendar-weekday {
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
      text-align: center;
    }
    .calendar-cell {
      min-height: 76px;
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 10px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 8px;
      background: #fbfbfa;
    }
    .calendar-cell.is-empty {
      visibility: hidden;
    }
    .calendar-day {
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
      font-variant-numeric: tabular-nums;
    }
    .calendar-value {
      color: var(--text);
      font-size: 16px;
      font-weight: 720;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .calendar-subvalue {
      color: var(--muted);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #calendarPanel[data-mode="tokens"] .calendar-level-1 { background: #eef8f5; border-color: #d5eee7; }
    #calendarPanel[data-mode="tokens"] .calendar-level-2 { background: #d5f0e8; border-color: #b5e2d6; }
    #calendarPanel[data-mode="tokens"] .calendar-level-3 { background: #aee1d3; border-color: #87d0be; }
    #calendarPanel[data-mode="tokens"] .calendar-level-4 { background: #76cbb4; border-color: #55b69b; }
    #calendarPanel[data-mode="tokens"] .calendar-level-5 { background: #24a783; border-color: #16866a; }
    #calendarPanel[data-mode="tokens"] .calendar-level-5 .calendar-day,
    #calendarPanel[data-mode="tokens"] .calendar-level-5 .calendar-value,
    #calendarPanel[data-mode="tokens"] .calendar-level-5 .calendar-subvalue {
      color: #ffffff;
    }
    #calendarPanel[data-mode="cost"] .calendar-level-1 { background: #fff7ed; border-color: #fed7aa; }
    #calendarPanel[data-mode="cost"] .calendar-level-2 { background: #ffedd5; border-color: #fdba74; }
    #calendarPanel[data-mode="cost"] .calendar-level-3 { background: #fed7aa; border-color: #fb923c; }
    #calendarPanel[data-mode="cost"] .calendar-level-4 { background: #fdba74; border-color: #f97316; }
    #calendarPanel[data-mode="cost"] .calendar-level-5 { background: #c2410c; border-color: #9a3412; }
    #calendarPanel[data-mode="cost"] .calendar-level-5 .calendar-day,
    #calendarPanel[data-mode="cost"] .calendar-level-5 .calendar-value,
    #calendarPanel[data-mode="cost"] .calendar-level-5 .calendar-subvalue {
      color: #ffffff;
    }
    .section-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.6fr) minmax(320px, 0.9fr);
      gap: 24px;
      align-items: start;
    }
    section {
      margin-top: 30px;
    }
    .section-title {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin: 0 0 12px;
    }
    h2 {
      margin: 0;
      font-size: 22px;
      font-weight: 680;
      letter-spacing: 0;
    }
    .section-note {
      color: var(--muted);
      font-size: 13px;
    }
    .panel {
      border: 1px solid var(--line-strong);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: var(--shadow);
      overflow: hidden;
      max-width: 100%;
    }
    .table-wrap {
      overflow: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 760px;
    }
    #modelTable { min-width: 620px; }
    #sessionTable { min-width: 820px; }
    th, td {
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      white-space: nowrap;
    }
    th {
      position: sticky;
      top: 0;
      background: #fbfbfa;
      color: var(--soft-text);
      font-size: 12px;
      font-weight: 650;
      z-index: 1;
    }
    td {
      font-size: 14px;
    }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
    tr:last-child td { border-bottom: 0; }
    tbody tr:hover { background: #fbfbfa; }
    .muted { color: var(--muted); }
    .pill {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 4px 9px;
      background: var(--accent-soft);
      color: #115e59;
      font-size: 12px;
      font-weight: 700;
    }
    .warn {
      color: var(--warn);
      font-weight: 650;
    }
    .warn-pill {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 4px 9px;
      background: var(--danger-soft);
      color: var(--warn);
      font-size: 12px;
      font-weight: 700;
    }
    .model-name {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-weight: 650;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: var(--accent);
      flex: 0 0 auto;
    }
    .summary-list {
      padding: 6px 0;
    }
    .summary-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 15px 18px;
      border-bottom: 1px solid var(--line);
    }
    .summary-row:last-child { border-bottom: 0; }
    .summary-k {
      color: var(--muted);
      font-size: 13px;
    }
    .summary-v {
      color: var(--text);
      font-variant-numeric: tabular-nums;
      font-weight: 650;
      text-align: right;
    }
    .model-card-list {
      display: grid;
      gap: 10px;
      padding: 14px;
    }
    .model-card {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      background: #fff;
    }
    .model-card-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: baseline;
      margin-bottom: 10px;
    }
    .model-card-name {
      font-weight: 700;
      font-size: 15px;
    }
    .bar-track {
      height: 8px;
      border-radius: 999px;
      background: #ededeb;
      overflow: hidden;
      margin: 10px 0 8px;
    }
    .bar-fill {
      height: 100%;
      border-radius: inherit;
      background: var(--accent);
      width: 0%;
    }
    .card-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      color: var(--muted);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    .title-cell {
      max-width: 520px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .session-sub {
      margin-top: 4px;
      color: var(--muted);
      font-size: 12px;
      max-width: 520px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .footer-note {
      margin: 22px 0 0;
      color: var(--muted);
      font-size: 13px;
    }
    @media (max-width: 980px) {
      .hero { align-items: flex-start; flex-direction: column; }
      .hero-meta { text-align: left; }
      .overview { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .metric:nth-child(2) { border-right: 0; }
      .metric:nth-child(-n + 2) { border-bottom: 1px solid var(--line); }
      .section-grid { grid-template-columns: 1fr; }
      .calendar-title-actions { justify-content: flex-start; }
    }
    @media (max-width: 620px) {
      main { padding: 14px; }
      .bar { align-items: flex-start; flex-direction: column; padding: 12px 14px; }
      .controls { justify-content: flex-start; }
      .range-segment { width: 100%; overflow: auto; }
      .overview { grid-template-columns: 1fr; }
      .metric { border-right: 0; border-bottom: 1px solid var(--line); }
      .metric:last-child { border-bottom: 0; }
      .hero-title { font-size: 34px; }
      .calendar-weekdays,
      .calendar-grid { grid-template-columns: repeat(7, 84px); min-width: 636px; }
      table { min-width: 640px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="bar">
      <div>
        <h1>Codex Token Dashboard</h1>
        <div class="brand-sub" data-i18n="brandSub">本地用量与预估费用</div>
      </div>
      <div class="controls">
        <div class="range-segment" id="rangeSegment" aria-label="Range">
          <button class="range-button" type="button" data-range="today" data-i18n="rangeToday">今天</button>
          <button class="range-button" type="button" data-range="7d" data-i18n="range7d">7 天</button>
          <button class="range-button" type="button" data-range="30d" data-i18n="range30d">30 天</button>
          <button class="range-button" type="button" data-range="all" data-i18n="rangeAll">全部</button>
        </div>
        <div class="lang-segment" id="langSegment" aria-label="Language">
          <button class="lang-button" type="button" data-lang="zh">中文</button>
          <button class="lang-button" type="button" data-lang="en">EN</button>
        </div>
        <button id="refresh" class="primary" type="button" data-i18n="refresh">刷新</button>
      </div>
    </div>
  </header>
  <main>
    <div class="hero">
      <div>
        <p class="eyebrow" id="rangeLabel">今天</p>
        <h2 class="hero-title" data-i18n="heroTitle">清晰查看 Codex 用量。</h2>
      </div>
      <div class="hero-meta" id="meta">加载中...</div>
    </div>

    <div class="overview">
      <div class="metric"><div class="label" data-i18n="estimatedCost">预估费用</div><div class="value" id="totalCost">-</div><div class="sub" id="costSub">-</div></div>
      <div class="metric"><div class="label" data-i18n="totalTokens">总消耗量</div><div class="value" id="totalTokens">-</div><div class="sub" id="tokenSub">-</div></div>
      <div class="metric"><div class="label" data-i18n="input">输入</div><div class="value" id="inputTokens">-</div><div class="sub" id="cachedTokens">-</div></div>
      <div class="metric"><div class="label" data-i18n="output">输出</div><div class="value" id="outputTokens">-</div><div class="sub" id="reasoningTokens">-</div></div>
    </div>

    <section>
      <div class="section-title">
        <h2 data-i18n="calendarTitle">每日日历</h2>
        <div class="calendar-title-actions">
          <span class="section-note" id="calendarNote"></span>
          <div class="calendar-switch" aria-label="Calendar metric">
            <button class="calendar-mode-button" type="button" data-calendar-mode="tokens" data-i18n="calendarTokens">消耗量</button>
            <button class="calendar-mode-button" type="button" data-calendar-mode="cost" data-i18n="calendarCost">费用</button>
          </div>
        </div>
      </div>
      <div class="panel" id="calendarPanel" data-mode="tokens">
        <div class="calendar-wrap">
          <div class="calendar-weekdays" id="calendarWeekdays"></div>
          <div class="calendar-grid" id="calendarGrid"></div>
        </div>
      </div>
    </section>

    <div class="section-grid">
      <section>
        <div class="section-title"><h2 data-i18n="modelCost">模型成本</h2><span class="section-note" id="modelNote"></span></div>
        <div class="panel">
          <div class="table-wrap"><table id="modelTable"></table></div>
        </div>
      </section>

      <section>
        <div class="section-title"><h2 data-i18n="distribution">分布</h2><span class="section-note" id="distributionNote"></span></div>
        <div class="panel">
          <div id="modelCards" class="model-card-list"></div>
          <div class="summary-list" id="summaryList"></div>
        </div>
      </section>
    </div>

    <section>
      <div class="section-title"><h2 data-i18n="recentSessions">最近会话</h2><span class="section-note" id="sessionNote"></span></div>
      <div class="panel">
        <div class="table-wrap"><table id="sessionTable"></table></div>
      </div>
    </section>
    <p class="footer-note" id="footerNote"></p>
  </main>
  <script>
    const I18N = {
      zh: {
        pageTitle: 'Codex Token Dashboard',
        brandSub: '本地用量与预估费用',
        rangeAria: '时间范围',
        languageAria: '语言',
        calendarMetricAria: '日历指标',
        rangeToday: '今天',
        range7d: '7 天',
        range30d: '30 天',
        rangeAll: '全部',
        refresh: '刷新',
        refreshing: '刷新中...',
        loading: '加载中...',
        loadFailed: '加载失败：',
        heroTitle: '清晰查看 Codex 用量。',
        estimatedCost: '预估费用',
        totalTokens: '总消耗量',
        input: '输入',
        output: '输出',
        calendarTitle: '每日日历',
        calendarTokens: '消耗量',
        calendarCost: '费用',
        modelCost: '模型成本',
        distribution: '分布',
        recentSessions: '最近会话',
        rangeLabelToday: '今天',
        rangeLabel7d: '最近 7 天',
        rangeLabel30d: '最近 30 天',
        rangeLabelAll: '全部',
        sessionsUnit: '个会话',
        eventsUnit: '个事件',
        filesScanned: '已扫描 {scanned} 个文件',
        filesScannedOf: '已扫描 {scanned} / {total} 个文件',
        updated: '更新于',
        totalSub: '总计',
        cachedSub: '缓存输入',
        reasoningSub: '推理输出',
        standardRates: 'OpenAI 标准费率',
        pricingLink: 'OpenAI 价格',
        topSessions: '前 {count} 个会话',
        tableModel: '模型',
        tableTokens: '消耗量',
        tableCost: '费用',
        tableStatus: '状态',
        tableSession: '会话',
        priced: '已计价',
        unpriced: '未计价',
        estimated: '估算',
        tokensUnit: 'tokens',
        peak: '峰值',
        noRecords: '无记录',
        summaryLatestDay: '最新日期',
        summaryDayCost: '当日费用',
        summaryInputTokens: '输入 tokens',
        summaryCachedInput: '缓存输入',
        summaryOutputTokens: '输出 tokens',
        outputNote: 'reasoning_output_tokens 会单独展示，但不会重复计费，因为输出计费用的是 output_tokens。',
        weekdays: ['日', '一', '二', '三', '四', '五', '六'],
      },
      en: {
        pageTitle: 'Codex Token Dashboard',
        brandSub: 'Local usage and estimated cost',
        rangeAria: 'Range',
        languageAria: 'Language',
        calendarMetricAria: 'Calendar metric',
        rangeToday: 'Today',
        range7d: '7 days',
        range30d: '30 days',
        rangeAll: 'All',
        refresh: 'Refresh',
        refreshing: 'Refreshing...',
        loading: 'Loading...',
        loadFailed: 'Failed to load: ',
        heroTitle: 'See your Codex usage clearly.',
        estimatedCost: 'Estimated cost',
        totalTokens: 'Total tokens',
        input: 'Input',
        output: 'Output',
        calendarTitle: 'Daily calendar',
        calendarTokens: 'Usage',
        calendarCost: 'Cost',
        modelCost: 'Model cost',
        distribution: 'Distribution',
        recentSessions: 'Recent sessions',
        rangeLabelToday: 'Today',
        rangeLabel7d: 'Last 7 days',
        rangeLabel30d: 'Last 30 days',
        rangeLabelAll: 'All time',
        sessionsUnit: 'sessions',
        eventsUnit: 'events',
        filesScanned: '{scanned} files scanned',
        filesScannedOf: '{scanned} of {total} files scanned',
        updated: 'Updated',
        totalSub: 'total',
        cachedSub: 'cached',
        reasoningSub: 'reasoning',
        standardRates: 'OpenAI Standard rates',
        pricingLink: 'OpenAI pricing',
        topSessions: 'Top {count} sessions',
        tableModel: 'Model',
        tableTokens: 'Tokens',
        tableCost: 'Cost',
        tableStatus: 'Status',
        tableSession: 'Session',
        priced: 'priced',
        unpriced: 'unpriced',
        estimated: 'estimated',
        tokensUnit: 'tokens',
        peak: 'Peak',
        noRecords: 'No records',
        summaryLatestDay: 'Latest day',
        summaryDayCost: 'Day cost',
        summaryInputTokens: 'Input tokens',
        summaryCachedInput: 'Cached input',
        summaryOutputTokens: 'Output tokens',
        outputNote: 'reasoning_output_tokens is displayed separately, but it is not added again because output_tokens is used for output billing.',
        weekdays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
      },
    };
    const RANGES = ['today', '7d', '30d', 'all'];
    const LANGS = ['zh', 'en'];
    const state = {
      range: normalizeRange(readStorage('codexTokenRange', 'today')),
      calendarMode: readStorage('codexCalendarMetric', 'tokens') === 'cost' ? 'cost' : 'tokens',
      lang: normalizeLang(readStorage('codexTokenLanguage', 'zh')),
      latestData: null,
      loading: false
    };
    let loadController = null;
    let loadSeq = 0;
    const rangeButtons = Array.from(document.querySelectorAll('.range-button'));
    const calendarModeButtons = Array.from(document.querySelectorAll('.calendar-mode-button'));
    const langButtons = Array.from(document.querySelectorAll('.lang-button'));
    rangeButtons.forEach(button => {
      button.addEventListener('click', () => {
        state.range = button.dataset.range;
        writeStorage('codexTokenRange', state.range);
        syncRangeButtons();
        load({ force: true });
      });
    });
    calendarModeButtons.forEach(button => {
      button.addEventListener('click', () => {
        state.calendarMode = button.dataset.calendarMode;
        writeStorage('codexCalendarMetric', state.calendarMode);
        syncCalendarButtons();
        if (state.latestData) renderCalendar(state.latestData);
      });
    });
    langButtons.forEach(button => {
      button.addEventListener('click', () => {
        state.lang = normalizeLang(button.dataset.lang);
        writeStorage('codexTokenLanguage', state.lang);
        applyLanguage();
      });
    });
    document.getElementById('refresh').addEventListener('click', () => load({ force: true }));

    function readStorage(key, fallback) {
      try {
        return localStorage.getItem(key) || fallback;
      } catch {
        return fallback;
      }
    }
    function writeStorage(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {}
    }
    function normalizeRange(value) {
      return RANGES.includes(value) ? value : 'today';
    }
    function normalizeLang(value) {
      return LANGS.includes(value) ? value : 'zh';
    }
    function locale() {
      return state.lang === 'en' ? 'en-US' : 'zh-CN';
    }
    function t(key) {
      return (I18N[state.lang] && I18N[state.lang][key]) || I18N.en[key] || key;
    }
    function template(key, values) {
      return t(key).replace(/\\{(\\w+)\\}/g, (_, name) => values[name] ?? '');
    }
    function syncRangeButtons() {
      rangeButtons.forEach(button => button.classList.toggle('is-active', button.dataset.range === state.range));
    }
    function syncCalendarButtons() {
      calendarModeButtons.forEach(button => button.classList.toggle('is-active', button.dataset.calendarMode === state.calendarMode));
      document.getElementById('calendarPanel').dataset.mode = state.calendarMode;
    }
    function syncLangButtons() {
      langButtons.forEach(button => button.classList.toggle('is-active', button.dataset.lang === state.lang));
    }
    function applyLanguage() {
      document.documentElement.lang = state.lang === 'en' ? 'en' : 'zh-CN';
      document.title = t('pageTitle');
      document.querySelectorAll('[data-i18n]').forEach(element => {
        element.textContent = t(element.dataset.i18n);
      });
      document.getElementById('rangeSegment').setAttribute('aria-label', t('rangeAria'));
      document.getElementById('langSegment').setAttribute('aria-label', t('languageAria'));
      document.querySelector('.calendar-switch').setAttribute('aria-label', t('calendarMetricAria'));
      syncLangButtons();
      document.getElementById('refresh').textContent = state.loading ? t('refreshing') : t('refresh');
      if (state.latestData) {
        render(state.latestData);
      } else {
        document.getElementById('rangeLabel').textContent = rangeLabel(state.range);
        document.getElementById('meta').textContent = t('loading');
      }
    }
    function n(value) {
      return new Intl.NumberFormat('en-US').format(value || 0);
    }
    function compact(value) {
      return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value || 0);
    }
    function usd(value) {
      const options = value >= 100
        ? { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }
        : { style: 'currency', currency: 'USD', minimumFractionDigits: 4, maximumFractionDigits: 4 };
      return new Intl.NumberFormat('en-US', options).format(value || 0);
    }
    function shortDateTime(value) {
      if (!value) return '-';
      const options = state.lang === 'en'
        ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
        : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };
      return new Intl.DateTimeFormat(locale(), options).format(new Date(value));
    }
    function dayModels(models) { return (models || []).slice(0, 3).map(item => item.model).join(', ') || '-'; }
    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }
    function costNote(cost) {
      const notes = [];
      if (cost?.unpricedEvents) notes.push('<span class="warn-pill">' + n(cost.unpricedEvents) + ' ' + t('unpriced') + '</span>');
      if (cost?.estimatedEvents) notes.push('<span class="pill">' + n(cost.estimatedEvents) + ' ' + t('estimated') + '</span>');
      return notes.join(' · ');
    }
    function modelShare(row, data) {
      if (!data.totals.totalTokens) return 0;
      return Math.max(0, Math.min(100, (row.totals.totalTokens / data.totals.totalTokens) * 100));
    }
    function filesScanned(data) {
      if (data.totalFiles && data.totalFiles !== data.scannedFiles) {
        return template('filesScannedOf', { scanned: n(data.scannedFiles), total: n(data.totalFiles) });
      }
      return template('filesScanned', { scanned: n(data.scannedFiles) });
    }
    function rangeLabel(range) {
      if (range === '7d') return t('rangeLabel7d');
      if (range === '30d') return t('rangeLabel30d');
      if (range === 'all') return t('rangeLabelAll');
      return t('rangeLabelToday');
    }
    function parseDayKey(value) {
      if (!value) return null;
      const parts = String(value).slice(0, 10).split('-').map(Number);
      if (parts.length !== 3 || parts.some(part => !Number.isFinite(part))) return null;
      return new Date(parts[0], parts[1] - 1, parts[2]);
    }
    function dayKey(date) {
      return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0')
      ].join('-');
    }
    function addDays(date, amount) {
      const next = new Date(date);
      next.setDate(next.getDate() + amount);
      return next;
    }
    function dayLabel(key) {
      const date = parseDayKey(key);
      const options = state.lang === 'en' ? { month: 'short', day: 'numeric' } : { month: 'numeric', day: 'numeric' };
      return date ? new Intl.DateTimeFormat(locale(), options).format(date) : key;
    }
    function calendarRange(data) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (data.range === '7d') return { start: addDays(today, -6), end: today };
      if (data.range === '30d') return { start: addDays(today, -29), end: today };
      if (data.range === 'all') {
        const first = parseDayKey(data.firstEventAt) || parseDayKey(data.byDay[data.byDay.length - 1]?.key) || today;
        return { start: first, end: today };
      }
      return { start: today, end: today };
    }
    function calendarValue(row) {
      if (!row) return 0;
      return state.calendarMode === 'cost' ? row.cost.totalUsd : row.totals.totalTokens;
    }
    function calendarValueText(value) {
      return state.calendarMode === 'cost' ? usd(value) : compact(value);
    }
    function calendarSubText(row) {
      if (!row) return '';
      return state.calendarMode === 'cost' ? n(row.totals.totalTokens) + ' ' + t('tokensUnit') : usd(row.cost.totalUsd);
    }
    function calendarLevel(value, maxValue) {
      if (!value || !maxValue) return 0;
      const ratio = value / maxValue;
      if (ratio >= 0.8) return 5;
      if (ratio >= 0.55) return 4;
      if (ratio >= 0.32) return 3;
      if (ratio >= 0.14) return 2;
      return 1;
    }
    function renderCalendar(data) {
      document.getElementById('calendarWeekdays').innerHTML = t('weekdays')
        .map(day => '<div class="calendar-weekday">' + day + '</div>')
        .join('');

      const rowsByDay = new Map((data.byDay || []).map(row => [row.key, row]));
      const range = calendarRange(data);
      const days = [];
      for (let cursor = new Date(range.start); cursor <= range.end; cursor = addDays(cursor, 1)) {
        days.push(dayKey(cursor));
      }
      const maxValue = days.reduce((max, key) => Math.max(max, calendarValue(rowsByDay.get(key))), 0);
      const peakKey = days.reduce((best, key) => {
        return calendarValue(rowsByDay.get(key)) > calendarValue(rowsByDay.get(best)) ? key : best;
      }, days[0]);
      const leading = range.start.getDay();
      const blanks = Array.from({ length: leading }, () => '<div class="calendar-cell is-empty"></div>').join('');
      const cells = days.map(key => {
        const row = rowsByDay.get(key);
        const value = calendarValue(row);
        const level = calendarLevel(value, maxValue);
        const title = key + ' · ' + n(row?.totals.totalTokens || 0) + ' ' + t('tokensUnit') + ' · ' + usd(row?.cost.totalUsd || 0);
        return '<div class="calendar-cell calendar-level-' + level + '" title="' + escapeHtml(title) + '">' +
          '<div class="calendar-day">' + escapeHtml(dayLabel(key)) + '</div>' +
          '<div><div class="calendar-value">' + escapeHtml(calendarValueText(value)) + '</div>' +
          '<div class="calendar-subvalue">' + escapeHtml(calendarSubText(row)) + '</div></div>' +
        '</div>';
      }).join('');
      document.getElementById('calendarGrid').innerHTML = blanks + cells;
      document.getElementById('calendarNote').textContent = maxValue
        ? t('peak') + ' ' + calendarValueText(maxValue) + ' · ' + dayLabel(peakKey)
        : t('noRecords');
    }
    function renderTable(id, columns, rows) {
      const head = '<thead><tr>' + columns.map(col => '<th class="' + (col.num ? 'num' : '') + '">' + escapeHtml(col.label) + '</th>').join('') + '</tr></thead>';
      const body = '<tbody>' + rows.map(row => '<tr>' + columns.map(col => '<td class="' + (col.num ? 'num' : '') + '">' + col.render(row) + '</td>').join('') + '</tr>').join('') + '</tbody>';
      document.getElementById(id).innerHTML = head + body;
    }
    async function load(options = {}) {
      if (state.loading && !options.force) return;
      if (loadController) loadController.abort();
      const seq = ++loadSeq;
      loadController = new AbortController();
      state.loading = true;
      const button = document.getElementById('refresh');
      button.disabled = true;
      button.textContent = t('refreshing');
      try {
        const res = await fetch('/api/metrics?range=' + encodeURIComponent(state.range), {
          cache: 'no-store',
          signal: loadController.signal,
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        if (seq !== loadSeq) return;
        render(data);
      } catch (error) {
        if (error.name === 'AbortError') return;
        document.getElementById('meta').innerHTML = '<span class="warn">' + t('loadFailed') + escapeHtml(error.message || error) + '</span>';
      } finally {
        if (seq === loadSeq) {
          state.loading = false;
          loadController = null;
          button.disabled = false;
          button.textContent = t('refresh');
        }
      }
    }
    function render(data) {
      state.latestData = data;
      document.getElementById('rangeLabel').textContent = rangeLabel(data.range);
      document.getElementById('meta').innerHTML = [
        '<div><strong>' + n(data.activeSessions) + '</strong> ' + t('sessionsUnit') + ' · <strong>' + n(data.eventCount) + '</strong> ' + t('eventsUnit') + '</div>',
        '<div>' + filesScanned(data) + '</div>',
        '<div>' + t('updated') + ' ' + shortDateTime(data.generatedAt) + '</div>'
      ].join('');
      document.getElementById('totalTokens').textContent = compact(data.totals.totalTokens);
      document.getElementById('tokenSub').textContent = n(data.totals.totalTokens) + ' ' + t('totalSub');
      document.getElementById('totalCost').textContent = usd(data.cost.totalUsd);
      document.getElementById('costSub').innerHTML = costNote(data.cost) || t('standardRates');
      document.getElementById('inputTokens').textContent = compact(data.totals.inputTokens);
      document.getElementById('cachedTokens').textContent = n(data.totals.cachedInputTokens) + ' ' + t('cachedSub');
      document.getElementById('outputTokens').textContent = n(data.totals.outputTokens);
      document.getElementById('reasoningTokens').textContent = n(data.totals.reasoningOutputTokens) + ' ' + t('reasoningSub');
      document.getElementById('modelNote').innerHTML = '<a href="' + data.pricing.sourceUrl + '" target="_blank" rel="noreferrer">' + t('pricingLink') + '</a>';
      document.getElementById('distributionNote').textContent = dayModels(data.byModel.map(row => ({ model: row.key, totalTokens: row.totals.totalTokens })));
      document.getElementById('sessionNote').textContent = template('topSessions', { count: Math.min(data.sessions.length, 12) });
      document.getElementById('footerNote').textContent = t('outputNote');
      renderCalendar(data);

      renderTable('modelTable', [
        { label: t('tableModel'), render: row => '<span class="model-name"><span class="dot"></span>' + escapeHtml(row.key) + '</span>' },
        { label: t('tableTokens'), num: true, render: row => n(row.totals.totalTokens) },
        { label: t('tableCost'), num: true, render: row => usd(row.cost.totalUsd) },
        { label: t('tableStatus'), render: row => costNote(row.cost) || '<span class="pill">' + t('priced') + '</span>' }
      ], data.byModel);

      const maxModels = data.byModel.slice(0, 4);
      document.getElementById('modelCards').innerHTML = maxModels.map(row => {
        const share = modelShare(row, data);
        return '<div class="model-card">' +
          '<div class="model-card-head"><div class="model-card-name">' + escapeHtml(row.key) + '</div><div>' + usd(row.cost.totalUsd) + '</div></div>' +
          '<div class="bar-track"><div class="bar-fill" style="width:' + share.toFixed(2) + '%"></div></div>' +
          '<div class="card-row"><span>' + n(row.totals.totalTokens) + ' ' + t('tokensUnit') + '</span><span>' + share.toFixed(1) + '%</span></div>' +
        '</div>';
      }).join('');
      const latestDay = data.byDay[0];
      document.getElementById('summaryList').innerHTML = [
        [t('summaryLatestDay'), latestDay ? latestDay.key : '-'],
        [t('summaryDayCost'), latestDay ? usd(latestDay.cost.totalUsd) : '-'],
        [t('summaryInputTokens'), n(data.totals.inputTokens)],
        [t('summaryCachedInput'), n(data.totals.cachedInputTokens)],
        [t('summaryOutputTokens'), n(data.totals.outputTokens)]
      ].map(item => '<div class="summary-row"><div class="summary-k">' + item[0] + '</div><div class="summary-v">' + item[1] + '</div></div>').join('');

      renderTable('sessionTable', [
        { label: t('tableSession'), render: row => '<div class="title-cell" title="' + escapeHtml(row.title) + '">' + escapeHtml(row.title) + '</div><div class="session-sub">' + escapeHtml(shortDateTime(row.startedAt)) + ' · ' + escapeHtml(row.originator || row.source || '-') + '</div>' },
        { label: t('tableModel'), render: row => escapeHtml(row.model) },
        { label: t('tableTokens'), num: true, render: row => n(row.totals.totalTokens) },
        { label: t('tableCost'), num: true, render: row => usd(row.cost.totalUsd) }
      ], data.sessions.slice(0, 12));
    }
    syncRangeButtons();
    syncCalendarButtons();
    applyLanguage();
    load();
    setInterval(load, 30000);
  </script>
</body>
</html>`;
}

async function handleRequest(req, res, options) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      send(res, 200, htmlPage(), "text/html; charset=utf-8");
      return;
    }
    if (url.pathname === "/api/health") {
      const sessionsRoot = path.resolve(options.sessionsRoot);
      let exists = false;
      try {
        exists = (await stat(sessionsRoot)).isDirectory();
      } catch {
        exists = false;
      }
      sendJson(res, 200, { ok: true, sessionsRoot, exists });
      return;
    }
    if (url.pathname === "/api/metrics") {
      const range = url.searchParams.get("range") || "all";
      const metrics = await collectMetricsForRequest({ sessionsRoot: options.sessionsRoot, range });
      sendJson(res, 200, metrics);
      return;
    }
    send(res, 404, "Not found", "text/plain; charset=utf-8");
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message || String(error) });
  }
}

function send(res, status, body, type) {
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8");
}

function parseCliArgs(argv) {
  const args = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    sessionsRoot: DEFAULT_SESSIONS_ROOT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") args.host = argv[++index];
    if (arg === "--port") args.port = Number(argv[++index]);
    if (arg === "--sessions-root") args.sessionsRoot = argv[++index];
  }
  return args;
}

export function startServer(options = {}) {
  const serverOptions = {
    host: options.host || DEFAULT_HOST,
    port: Number(options.port || DEFAULT_PORT),
    sessionsRoot: path.resolve(options.sessionsRoot || DEFAULT_SESSIONS_ROOT),
  };
  const server = http.createServer((req, res) => handleRequest(req, res, serverOptions));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(serverOptions.port, serverOptions.host, () => {
      server.off("error", reject);
      resolve({ server, options: serverOptions });
    });
  });
}

if (process.argv[1] === __filename) {
  const args = parseCliArgs(process.argv.slice(2));
  startServer(args)
    .then(({ options }) => {
      console.log(`Codex Token Dashboard: http://${options.host}:${options.port}/`);
      console.log(`Sessions root: ${options.sessionsRoot}`);
    })
    .catch((error) => {
      console.error(error.stack || error.message || String(error));
      process.exit(1);
    });
}
