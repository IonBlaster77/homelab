// Pi -> Langfuse tracing, home-grown (no npm dependencies) so no third-party
// code runs in the pod that holds the model sign-in. Same shape as the Claude
// Code Stop hook: one trace per Pi run ("Pi run"), a generation per model call
// with token usage, a span per tool call, everything masked and truncated
// before it leaves the pod. Sent as OTLP/HTTP JSON to Langfuse in-cluster.
//
// Installed into ~/.pi/agent/extensions/ by the install-pi initContainer from
// the pi-extension-langfuse ConfigMap. Credentials: /etc/pi-langfuse/{public-key,
// secret-key} (secret pi-langfuse). Opt out per run with PI_LANGFUSE_DISABLE=1.
// Export failures are logged to stderr and never fail the run.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const BASE_URL = process.env.PI_LANGFUSE_BASE_URL || "http://langfuse-web.langfuse.svc.cluster.local:3000";
const CRED_DIR = process.env.PI_LANGFUSE_CREDENTIALS_DIR || "/etc/pi-langfuse";
const LIMIT = { text: 4000, toolInput: 2000, toolOutput: 1500 };

const MASKS: [RegExp, string][] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
  [/AGE-SECRET-KEY-1[0-9A-Z]{20,}/g, "[REDACTED AGE KEY]"],
  [/\b(?:pk|sk)-lf-[A-Za-z0-9-]{8,}/g, "[REDACTED LANGFUSE KEY]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[REDACTED GITHUB TOKEN]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED AWS KEY]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED JWT]"],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 [REDACTED]"],
  // key=value / key: value / "key": "value" for secret-ish names (*arr apikey= URLs included)
  [/\b((?:[a-z0-9_]*[_-])?(?:api[_-]?key|apikey|token|secret|password|passwd|pwd|access[_-]?key|private[_-]?key|client[_-]?secret|auth))(\s*["']?\s*[:=]\s*["']?)([^\s"'&,;}\]]{6,})/gi, "$1$2[REDACTED]"],
  // YAML lines like `key: LS0tLS1C...` (Talos configs, k8s Secrets)
  [/^(\s*-?\s*(?:key|crt|cert|ca|token|secret|data|password|value)\s*:\s*)([A-Za-z0-9+/=_-]{24,})\s*$/gim, "$1[REDACTED]"],
  // long base64 blobs with mixed case + digits (not lowercase hex digests)
  [/(?<![A-Za-z0-9+/])(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[0-9])[A-Za-z0-9+/]{48,}={0,2}/g, "[REDACTED BASE64]"],
];

export function mask(value: unknown, limit: number): string {
  let text = typeof value === "string" ? value : value === undefined ? "" : safeJson(value);
  for (const [rx, repl] of MASKS) text = text.replace(rx, repl);
  return text.length > limit ? `${text.slice(0, limit)}... [truncated, ${text.length} chars]` : text;
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
}

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const nanos = (ms: number) => `${BigInt(Math.round(ms)) * 1000000n}`;
const attr = (key: string, value: string | number | boolean) => ({
  key,
  value: typeof value === "number" ? (Number.isInteger(value) ? { intValue: `${value}` } : { doubleValue: value })
    : typeof value === "boolean" ? { boolValue: value } : { stringValue: value },
});

interface Gen { model: string; provider: string; start: number; end: number; usage: any; text: string; toolCalls: string[]; error?: string; stopReason?: string }
interface Tool { id: string; name: string; args: unknown; start: number; end?: number; result?: unknown; isError?: boolean; parent?: string }

function readCreds(): { pk: string; sk: string } | null {
  try {
    const pk = readFileSync(`${CRED_DIR}/public-key`, "utf8").trim();
    const sk = readFileSync(`${CRED_DIR}/secret-key`, "utf8").trim();
    return pk && sk ? { pk, sk } : null;
  } catch { return null; }
}

export default function (pi: any) {
  if (process.env.PI_LANGFUSE_DISABLE === "1") return;
  let runStart = 0, prompt = "", gens: Gen[] = [], tools = new Map<string, Tool>(), runIndex = 0;
  const reset = () => { runStart = 0; prompt = ""; gens = []; tools = new Map(); };

  pi.on("agent_start", () => { if (!runStart) runStart = Date.now(); });

  pi.on("message_end", (event: any) => {
    const m = event?.message;
    if (!m) return;
    if (!runStart) runStart = Date.now();
    if (m.role === "user" && !prompt) prompt = textOf(m.content);
    if (m.role === "assistant") {
      const start = typeof m.timestamp === "number" ? m.timestamp : Date.now();
      gens.push({
        model: m.responseModel || m.model || "unknown", provider: m.provider || "", start,
        end: start + (typeof m.durationMs === "number" ? m.durationMs : 0) || Date.now(),
        usage: m.usage || {}, text: textOf(m.content),
        toolCalls: Array.isArray(m.content) ? m.content.filter((b: any) => b?.type === "toolCall").map((b: any) => b.name) : [],
        error: m.errorMessage, stopReason: m.stopReason,
      });
    }
  });

  pi.on("tool_execution_start", (e: any) => {
    tools.set(e.toolCallId, { id: e.toolCallId, name: e.toolName, args: e.args, start: Date.now(), parent: e.parentToolCallId });
  });
  pi.on("tool_execution_end", (e: any) => {
    const t = tools.get(e.toolCallId) || { id: e.toolCallId, name: e.toolName, args: undefined, start: Date.now() };
    t.end = Date.now(); t.result = e.result; t.isError = e.isError;
    tools.set(e.toolCallId, t);
  });

  pi.on("agent_settled", async (e: any, ctx: any) => {
    if (!gens.length && !tools.size) { reset(); return; }
    const creds = readCreds();
    if (!creds) { console.error("[pi-langfuse] no credentials, trace dropped"); reset(); return; }
    runIndex += 1;
    const traceId = hex(16), rootId = hex(8), spanIds = new Map<string, string>();
    const end = Date.now(), last = gens[gens.length - 1];
    let sessionId = "";
    try { sessionId = ctx?.sessionManager?.getSessionId?.() || ""; } catch {}
    const spans: any[] = [{
      traceId, spanId: rootId, name: "Pi run", kind: 1,
      startTimeUnixNano: nanos(runStart || end), endTimeUnixNano: nanos(end),
      attributes: [
        attr("langfuse.trace.name", "Pi run"),
        ...(sessionId ? [attr("langfuse.session.id", sessionId)] : []),
        ...(process.env.PAPERCLIP_AGENT_ID ? [attr("langfuse.user.id", `paperclip-agent:${process.env.PAPERCLIP_AGENT_ID}`)] : []),
        attr("langfuse.trace.input", mask(prompt, LIMIT.text)),
        attr("langfuse.trace.output", mask(last?.text || "", LIMIT.text)),
        attr("langfuse.trace.metadata.run_index", runIndex),
        attr("langfuse.trace.metadata.aborted", !!e?.aborted),
        ...(process.env.PAPERCLIP_RUN_ID ? [attr("langfuse.trace.metadata.paperclip_run_id", process.env.PAPERCLIP_RUN_ID)] : []),
      ],
    }];
    gens.forEach((g, i) => {
      const u = g.usage || {};
      const usage: Record<string, number> = { input: u.input || 0, output: u.output || 0 };
      if (u.cacheRead) usage.cache_read_input_tokens = u.cacheRead;
      if (u.cacheWrite) usage.cache_creation_input_tokens = u.cacheWrite;
      if (u.reasoning) usage.output_reasoning_tokens = u.reasoning;
      const a = [
        attr("langfuse.observation.type", "generation"),
        attr("langfuse.observation.model.name", g.model),
        attr("langfuse.observation.usage_details", JSON.stringify(usage)),
        attr("langfuse.observation.output", mask(g.text || (g.toolCalls.length ? `[tool calls: ${g.toolCalls.join(", ")}]` : ""), LIMIT.text)),
        attr("langfuse.observation.metadata.provider", g.provider),
      ];
      if (u.cost?.total > 0) a.push(attr("langfuse.observation.cost_details", JSON.stringify({ total: u.cost.total })));
      if (g.error) { a.push(attr("langfuse.observation.level", "ERROR")); a.push(attr("langfuse.observation.status_message", mask(g.error, 500))); }
      spans.push({ traceId, spanId: hex(8), parentSpanId: rootId, name: `LLM call ${i + 1}`, kind: 1,
        startTimeUnixNano: nanos(g.start), endTimeUnixNano: nanos(Math.max(g.end, g.start)), attributes: a });
    });
    for (const t of tools.values()) spanIds.set(t.id, hex(8));
    for (const t of tools.values()) {
      const a = [
        attr("langfuse.observation.type", "tool"),
        attr("langfuse.observation.input", mask(t.args, LIMIT.toolInput)),
        attr("langfuse.observation.output", mask(typeof t.result === "object" ? textOf(t.result?.content) || t.result : t.result, LIMIT.toolOutput)),
      ];
      if (t.isError) a.push(attr("langfuse.observation.level", "ERROR"));
      spans.push({ traceId, spanId: spanIds.get(t.id), parentSpanId: (t.parent && spanIds.get(t.parent)) || rootId,
        name: `Tool: ${t.name}`, kind: 1, startTimeUnixNano: nanos(t.start), endTimeUnixNano: nanos(t.end || end), attributes: a });
    }
    const body = { resourceSpans: [{
      resource: { attributes: [attr("service.name", "pi"), attr("service.version", process.env.PI_VERSION || "")] },
      scopeSpans: [{ scope: { name: "pi-langfuse-homelab" }, spans }],
    }] };
    reset();
    try {
      const res = await fetch(`${BASE_URL}/api/public/otel/v1/traces`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`${creds.pk}:${creds.sk}`).toString("base64")}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) console.error(`[pi-langfuse] export HTTP ${res.status}`);
    } catch (err: any) {
      console.error(`[pi-langfuse] export failed: ${err?.message || err}`);
    }
  });
}
