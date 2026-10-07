// glmClient.js
// Streaming client for the GLM Coding Plan's Anthropic-compatible endpoint (POST /v1/messages).
//   - one in-flight request at a time (GLM_MAX_CONCURRENT, default 1)
//   - exponential backoff on 429 / concurrency / 5xx
//   - SSE streaming with an idle (stall) timeout instead of a wall-clock cap
//   - cancellation via AbortSignal

// Coding Plan endpoint for Claude Code-style (Anthropic Messages) clients, per
// https://docs.z.ai/devpack/tool/others.md. Mainland-China accounts use
// https://open.bigmodel.cn/api/anthropic (https://docs.bigmodel.cn/cn/coding-plan/tool/claude).
const BASE_URL = (process.env.GLM_BASE_URL || "https://api.z.ai/api/anthropic").replace(/\/$/, "");
const API_KEY = process.env.GLM_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || "";
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.GLM_MAX_CONCURRENT || "1", 10));
const MAX_RETRIES = Math.max(0, parseInt(process.env.GLM_MAX_RETRIES || "4", 10));
const STALL_MS = parseInt(process.env.GLM_STALL_TIMEOUT_MS || "120000", 10);

let active = 0;
const waiters = [];
async function acquire() {
  if (active < MAX_CONCURRENT) { active++; return; }
  await new Promise((res) => waiters.push(res));
  active++;
}
function release() {
  active--;
  const next = waiters.shift();
  if (next) next();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CancelledError extends Error {
  constructor(msg = "cancelled by client") { super(msg); this.name = "CancelledError"; this.cancelled = true; }
}

function isRetryable(status, bodyText) {
  if ([429, 500, 502, 503].includes(status)) return true;
  return Boolean(bodyText && /concurren|rate.?limit|too\s+much/i.test(bodyText));
}

function backoff(attempt, bodyText) {
  const base = bodyText && /concurren|too\s+much/i.test(bodyText) ? 2000 : 800;
  return Math.min(base * 2 ** attempt + Math.random() * 400, 30000);
}

function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…[truncated]" : s;
}

/**
 * @param {object} p
 * @param {string} p.model
 * @param {Array} p.messages
 * @param {string} [p.system]
 * @param {number} p.maxTokens
 * @param {Array} [p.tools]
 * @param {(outTokens:number, tokPerSec:number)=>void} [p.onToken]
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<{text:string, usage:{input_tokens:number,output_tokens:number}, raw:object}>}
 */
export async function glmMessage({ model, messages, system, maxTokens, tools, onToken, signal }) {
  if (!API_KEY) throw new Error("GLM_API_KEY is not set. Register the server with: claude mcp add glm -s user -e GLM_API_KEY=... -- node <path>/src/index.js");

  const body = {
    model,
    max_tokens: maxTokens,
    messages,
    stream: true,
    ...(system ? { system } : {}),
    ...(tools && tools.length ? { tools } : {}),
  };

  await acquire();
  try {
    let attempt = 0;
    while (true) {
      if (signal?.aborted) throw new CancelledError();

      const ac = new AbortController();
      let stallTimer = null;
      const armStall = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => ac.abort(new Error("stalled")), STALL_MS);
      };
      const onExternalAbort = () => ac.abort(new CancelledError());
      if (signal) signal.addEventListener("abort", onExternalAbort, { once: true });
      const cleanup = () => {
        if (stallTimer) clearTimeout(stallTimer);
        if (signal) signal.removeEventListener("abort", onExternalAbort);
      };

      let res;
      try {
        armStall();
        res = await fetch(`${BASE_URL}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream",
            authorization: `Bearer ${API_KEY}`,
            "x-api-key": API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
      } catch (e) {
        cleanup();
        if (signal?.aborted) throw new CancelledError();
        if (attempt < MAX_RETRIES) { await sleep(backoff(attempt++)); continue; }
        throw new Error(`GLM request failed (network/timeout): ${e.message}`);
      }

      if (!res.ok) {
        let txt = "";
        try { txt = await res.text(); } catch {}
        cleanup();
        if (isRetryable(res.status, txt) && attempt < MAX_RETRIES) { await sleep(backoff(attempt++, txt)); continue; }
        throw new Error(`GLM API error ${res.status}: ${truncate(txt, 800)}`);
      }

      try {
        const result = await parseSSE(res.body, { armStall, onToken });
        cleanup();
        if (!result.text && !result.raw.content.some((b) => b.type === "tool_use") && attempt < MAX_RETRIES) {
          await sleep(backoff(attempt++));
          continue;
        }
        return result;
      } catch (e) {
        cleanup();
        if (signal?.aborted || e instanceof CancelledError) throw new CancelledError();
        if (attempt < MAX_RETRIES) { await sleep(backoff(attempt++)); continue; }
        throw new Error(`GLM stream failed: ${e.message}`);
      }
    }
  } finally {
    release();
  }
}

/** Parse an Anthropic-style SSE stream into { text, usage, raw } with content blocks rebuilt. */
async function parseSSE(stream, { armStall, onToken }) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const raw = { id: null, role: "assistant", model: null, stop_reason: null, content: [], usage: { input_tokens: 0, output_tokens: 0 } };
  const blocks = {};
  const start = Date.now();
  let outChars = 0;
  let lastEmit = 0;
  let curEvent = null;

  const mergeUsage = (u) => {
    if (!u) return;
    if (u.input_tokens) raw.usage.input_tokens = u.input_tokens;
    if (u.output_tokens != null) raw.usage.output_tokens = u.output_tokens;
  };
  const maybeEmit = (force) => {
    if (!onToken) return;
    const now = Date.now();
    if (!force && now - lastEmit < 600) return;
    lastEmit = now;
    const outTok = raw.usage.output_tokens || Math.round(outChars / 4);
    onToken(outTok, Math.round(outTok / Math.max((now - start) / 1000, 0.5)));
  };

  const handle = (evt, data) => {
    switch (evt) {
      case "message_start":
        if (data.message) {
          raw.id = data.message.id ?? raw.id;
          raw.model = data.message.model ?? raw.model;
          mergeUsage(data.message.usage);
        }
        break;
      case "content_block_start": {
        const b = { ...(data.content_block || {}) };
        if (b.type === "text" && b.text == null) b.text = "";
        if (b.type === "thinking" && b.thinking == null) b.thinking = "";
        if (b.type === "tool_use") b._json = "";
        blocks[data.index] = b;
        break;
      }
      case "content_block_delta": {
        const b = blocks[data.index] || (blocks[data.index] = { type: "text", text: "" });
        const d = data.delta || {};
        if (d.type === "text_delta") { b.text = (b.text || "") + (d.text || ""); outChars += (d.text || "").length; maybeEmit(); }
        else if (d.type === "thinking_delta") { b.thinking = (b.thinking || "") + (d.thinking || ""); outChars += (d.thinking || "").length; maybeEmit(); }
        else if (d.type === "signature_delta") { b.signature = (b.signature || "") + (d.signature || ""); }
        else if (d.type === "input_json_delta") { b._json = (b._json || "") + (d.partial_json || ""); }
        break;
      }
      case "content_block_stop": {
        const b = blocks[data.index];
        if (b && b.type === "tool_use") {
          try { b.input = JSON.parse(b._json || "{}"); } catch { b.input = {}; }
          delete b._json;
        }
        break;
      }
      case "message_delta":
        if (data.delta && data.delta.stop_reason != null) raw.stop_reason = data.delta.stop_reason;
        if (data.usage) { mergeUsage(data.usage); maybeEmit(); }
        break;
      default:
        break;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    armStall();
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line === "") { curEvent = null; continue; }
      if (line.startsWith("event:")) { curEvent = line.slice(6).trim(); continue; }
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let data;
        try { data = JSON.parse(payload); } catch { continue; }
        handle(curEvent || data.type, data);
      }
    }
  }

  raw.content = Object.keys(blocks).sort((a, b) => a - b).map((k) => blocks[k]);
  const text = raw.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  maybeEmit(true);
  return { text, usage: raw.usage, raw };
}

export const config = { BASE_URL, hasKey: Boolean(API_KEY) };
