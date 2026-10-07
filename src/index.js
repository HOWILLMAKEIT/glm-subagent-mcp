#!/usr/bin/env node
// glm-subagent-mcp: one tool, glm_agent. Claude Code calls it; a GLM Coding Plan model does
// the work inside `workdir` with read/write/edit/list/bash tools and returns a summary.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runGlmAgent } from "./glmAgent.js";

// GLM Coding Plan models: glm-5.3, glm-5.3-flash (https://docs.z.ai/devpack/faq.md).
const DEFAULT_MODEL = process.env.GLM_MODEL || "glm-5.3";
const MAX_TOKENS = parseInt(process.env.GLM_MAX_TOKENS || "32768", 10);
const CHARACTER_LIMIT = 50000;

const server = new McpServer({ name: "glm-subagent-mcp", version: "0.1.0" });

function makeProgress(extra) {
  const token = extra?._meta?.progressToken;
  let seq = 0;
  return (message) => {
    if (token == null || !extra?.sendNotification) return;
    extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++seq, message } }).catch(() => {});
  };
}

server.registerTool(
  "glm_agent",
  {
    title: "Run a GLM sub-agent",
    description:
      "Delegate a self-contained coding task to a GLM sub-agent (use when the user asks for GLM or glm_agent, " +
      "or wants to save Claude tokens). GLM works inside `workdir` with its own " +
      "read/write/edit/list/bash tools and returns a summary plus the list of changed files. Give a complete " +
      "task description (goal, constraints, how to verify); GLM does not see this conversation. " +
      "`workdir` must be an absolute path. File tools cannot leave `workdir`; bash is not sandboxed.",
    inputSchema: {
      task: z.string().min(1).describe("Complete, self-contained task for the sub-agent."),
      workdir: z.string().min(1).describe("Absolute path of the directory GLM works in."),
      context: z.string().optional().describe("Optional extra background or constraints."),
      model: z.string().optional().describe(`GLM model id. Default ${DEFAULT_MODEL}. Coding Plan models: glm-5.3, glm-5.3-flash.`),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({ task, workdir, context, model }, extra) => {
    const chosen = model || DEFAULT_MODEL;
    try {
      const r = await runGlmAgent({ model: chosen, task, context, workdir, maxTokens: MAX_TOKENS, onProgress: makeProgress(extra), signal: extra?.signal });
      let status = "done";
      if (r.cancelled) status = "CANCELLED (partial)";
      else if (r.hitCap) status = "HIT ITERATION CAP (may be incomplete)";
      const text =
        `[glm_agent] ${chosen} | ${status} | ${r.iters} iterations | dir=${r.root}\n` +
        `tokens: ${r.usage.input_tokens} in / ${r.usage.output_tokens} out\n` +
        `changed files: ${r.changedFiles.length ? r.changedFiles.join(", ") : "(none)"}\n\n` +
        `=== GLM SUMMARY ===\n${r.text || "(no summary)"}`;
      return { content: [{ type: "text", text: text.length > CHARACTER_LIMIT ? text.slice(0, CHARACTER_LIMIT) + "\n…[truncated]" : text }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `glm_agent failed: ${e.message}` }] };
    }
  }
);

await server.connect(new StdioServerTransport());
