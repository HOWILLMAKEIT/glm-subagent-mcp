// End-to-end test with a mock Anthropic-style SSE server (no real key or network needed).
import http from "node:http";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), "glm-work-"));
const outsideDir = mkdtempSync(join(tmpdir(), "glm-outside-"));
writeFileSync(join(outsideDir, "secret.txt"), "secret");
symlinkSync(outsideDir, join(work, "link"));

const sse = (events) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
const toolTurn = (id, name, input) => sse([
  ["message_start", { message: { id: "m", role: "assistant", model: "glm-5.3", usage: { input_tokens: 10 } } }],
  ["content_block_start", { index: 0, content_block: { type: "tool_use", id, name, input: {} } }],
  ["content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }],
  ["content_block_stop", { index: 0 }],
  ["message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }],
  ["message_stop", {}],
]);
const textTurn = (t) => sse([
  ["message_start", { message: { id: "m", role: "assistant", model: "glm-5.3", usage: { input_tokens: 10 } } }],
  ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { index: 0, delta: { type: "text_delta", text: t } }],
  ["content_block_stop", { index: 0 }],
  ["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }],
  ["message_stop", {}],
]);

const script = [
  toolTurn("t1", "write_file", { path: "out/hello.txt", content: "hi" }),
  toolTurn("t2", "read_file", { path: "../../etc/passwd" }),
  toolTurn("t3", "read_file", { path: "link/secret.txt" }),
  toolTurn("t4", "run_bash", { command: "echo bash-ok" }),
  textTurn("all done"),
];
const seen = [];
let n = 0;
const srv = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(script[n++]);
  });
});
await new Promise((r) => srv.listen(0, r));

const client = new Client({ name: "test", version: "0" });
await client.connect(new StdioClientTransport({
  command: "node", args: [join(HERE, "..", "src", "index.js")],
  env: { ...process.env, GLM_API_KEY: "k", GLM_BASE_URL: `http://127.0.0.1:${srv.address().port}` },
}));

const tools = (await client.listTools()).tools;
assert.deepEqual(tools.map((t) => t.name), ["glm_agent"]);

const bad = await client.callTool({ name: "glm_agent", arguments: { task: "x", workdir: "relative/path" } });
assert.equal(bad.isError, true);

const r = await client.callTool({ name: "glm_agent", arguments: { task: "do it", workdir: work } });
const text = r.content[0].text;
console.log(text);
assert.ok(!r.isError);
assert.equal(readFileSync(join(work, "out/hello.txt"), "utf8"), "hi");
assert.ok(text.includes("changed files: out/hello.txt"));
assert.ok(text.includes("all done"));
assert.equal(seen[0].url, "/v1/messages");
assert.equal(seen[0].auth, "Bearer k");
assert.equal(seen[0].body.model, "glm-5.3");
const results = (i) => seen[i].body.messages.at(-1).content[0].content;
assert.match(results(2), /path outside workdir/);
assert.match(results(3), /path outside workdir \(symlink\)/);
assert.match(results(4), /bash-ok/);
console.log("\nALL TESTS PASSED");
await client.close();
srv.close();
