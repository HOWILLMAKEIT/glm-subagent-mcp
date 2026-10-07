// glmAgent.js
// Runs GLM as a tool-using coding agent on the local filesystem.
// All file tools are confined to `workdir` (symlinks resolved). run_bash starts in `workdir`
// but a shell command itself is NOT sandboxed.

import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute, join, sep } from "node:path";
import { exec } from "node:child_process";
import { glmMessage } from "./glmClient.js";

const MAX_ITERS = parseInt(process.env.GLM_AGENT_MAX_ITERS || "30", 10);
const BASH_TIMEOUT = parseInt(process.env.GLM_AGENT_BASH_TIMEOUT_MS || "120000", 10);
const FILE_READ_CAP = 100000;
const BASH_OUT_CAP = 30000;

const TOOLS = [
  { name: "read_file", description: "Read a UTF-8 text file (path relative to the working dir).",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "write_file", description: "Create or overwrite a file. Creates parent dirs as needed.",
    input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace an exact substring in a file. old_string must appear exactly once.",
    input_schema: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["path", "old_string", "new_string"] } },
  { name: "list_dir", description: "List entries in a directory. Defaults to '.'.",
    input_schema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "run_bash", description: "Run a shell command in the working dir; returns stdout+stderr.",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
];

const outside = (rel) => rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel);

/** Resolve `p` against `root`; throw if the real path (after symlinks) leaves `root`. */
export function confine(root, p) {
  const abs = isAbsolute(p || "") ? resolve(p) : resolve(root, p || ".");
  if (outside(relative(root, abs))) throw new Error(`path outside workdir: ${p}`);
  let cur = abs;
  while (!existsSync(cur)) cur = dirname(cur);
  if (outside(relative(realpathSync(root), realpathSync(cur)))) throw new Error(`path outside workdir (symlink): ${p}`);
  return abs;
}

export async function runGlmAgent({ model, task, context, workdir, maxTokens, onProgress, signal }) {
  if (!workdir || !isAbsolute(workdir)) throw new Error("workdir must be an absolute path");
  if (!existsSync(workdir) || !statSync(workdir).isDirectory()) throw new Error(`workdir does not exist or is not a directory: ${workdir}`);
  const root = resolve(workdir);
  const changed = new Set();

  async function runTool(name, input) {
    try {
      switch (name) {
        case "read_file": {
          const txt = await readFile(confine(root, input.path), "utf8");
          return txt.length > FILE_READ_CAP ? txt.slice(0, FILE_READ_CAP) + "\n…[truncated]" : txt;
        }
        case "write_file": {
          const abs = confine(root, input.path);
          await mkdir(dirname(abs), { recursive: true });
          await writeFile(abs, input.content ?? "", "utf8");
          changed.add(relative(root, abs));
          return `Wrote ${(input.content ?? "").length} chars to ${input.path}.`;
        }
        case "edit_file": {
          const abs = confine(root, input.path);
          let cur;
          try { cur = await readFile(abs, "utf8"); } catch { return `ERROR: cannot read ${input.path} to edit.`; }
          const occ = cur.split(input.old_string).length - 1;
          if (occ === 0) return `ERROR: old_string not found in ${input.path}. Read the file and retry with an exact match.`;
          if (occ > 1) return `ERROR: old_string appears ${occ} times in ${input.path}; add surrounding lines to make it unique.`;
          await writeFile(abs, cur.replace(input.old_string, () => input.new_string), "utf8");
          changed.add(relative(root, abs));
          return `Edited ${input.path} (1 replacement).`;
        }
        case "list_dir": {
          const abs = confine(root, input.path || ".");
          const entries = await Promise.all((await readdir(abs)).map(async (e) => {
            try { return (await stat(join(abs, e))).isDirectory() ? e + "/" : e; } catch { return e; }
          }));
          return entries.join("\n") || "(empty)";
        }
        case "run_bash": {
          return await new Promise((done) => {
            exec(input.command, { cwd: root, timeout: BASH_TIMEOUT, maxBuffer: 10 * 1024 * 1024, signal }, (err, stdout, stderr) => {
              const out = `${stdout || ""}${stderr || ""}${err ? `\n[exit ${err.code ?? "?"}] ${err.killed ? "killed (timeout or cancelled)" : ""}` : ""}`;
              done((out.trim() || "(no output)").slice(0, BASH_OUT_CAP));
            });
          });
        }
        default:
          return `ERROR: unknown tool ${name}`;
      }
    } catch (e) {
      return `ERROR (${name}): ${e.message}`;
    }
  }

  const system =
    `You are a capable coding agent operating directly on a local repository.\n` +
    `Working directory: ${root}\n` +
    `File tools only work inside this directory. Make changes yourself with the tools and run tests/builds to verify. ` +
    `Tools: read_file, write_file, edit_file, list_dir, run_bash. When fully done, stop calling tools and reply ` +
    `with a concise summary of what you changed and how you verified it.`;

  const messages = [{ role: "user", content: context ? `${task}\n\n--- CONTEXT ---\n${context}` : task }];
  const usage = { input_tokens: 0, output_tokens: 0 };
  let lastText = "";
  let iters = 0;
  let cancelled = false;
  let finished = false;
  const emit = (msg) => { try { onProgress?.(msg); } catch {} };

  for (; iters < MAX_ITERS; iters++) {
    if (signal?.aborted) { cancelled = true; break; }
    const baseOut = usage.output_tokens;
    emit(`iter ${iters + 1}/${MAX_ITERS} — GLM generating…`);
    let raw, u;
    try {
      ({ raw, usage: u } = await glmMessage({
        model, system, messages, maxTokens, tools: TOOLS, signal,
        onToken: (outTok, tps) => emit(`iter ${iters + 1}/${MAX_ITERS} · ${baseOut + outTok} tok · ${tps} tok/s`),
      }));
    } catch (e) {
      if (e && e.cancelled) { cancelled = true; break; }
      throw e;
    }
    usage.input_tokens += u.input_tokens || 0;
    usage.output_tokens += u.output_tokens || 0;
    const content = raw.content || [];
    const textParts = content.filter((b) => b.type === "text").map((b) => b.text);
    if (textParts.length) lastText = textParts.join("\n").trim();
    const toolUses = content.filter((b) => b.type === "tool_use");
    if (raw.stop_reason !== "tool_use" || toolUses.length === 0) { finished = true; break; }
    messages.push({ role: "assistant", content });
    const results = [];
    for (const tu of toolUses) {
      emit(`iter ${iters + 1}/${MAX_ITERS} · ${tu.name} ${String(tu.input?.path ?? tu.input?.command ?? "").slice(0, 60)}`);
      results.push({ type: "tool_result", tool_use_id: tu.id, content: String(await runTool(tu.name, tu.input || {})) });
    }
    messages.push({ role: "user", content: results });
  }

  return { text: lastText, iters: iters + (finished ? 1 : 0), finished, hitCap: !finished && !cancelled, cancelled, usage, root, changedFiles: [...changed] };
}
