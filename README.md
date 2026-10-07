<a id="top"></a>

<div align="center">
  <h1>glm-subagent-mcp</h1>
</div>

<div align="center">

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node 18+](https://img.shields.io/badge/Node-18%2B-339933.svg?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-plugin-6366f1.svg)](https://modelcontextprotocol.io/)
[![Tools](https://img.shields.io/badge/Tools-1-0ea5e9.svg)](#-how-it-works)
[![GLM](https://img.shields.io/badge/GLM-Coding%20Plan-111827.svg)](https://docs.z.ai/devpack/overview)

**With this MCP server, Claude Code can call a GLM model as a sub-agent.**

**English** | [简体中文](README.zh-CN.md)

[What It Does](#-what-it-does) | [Quick Start](#-quick-start) | [How It Works](#-how-it-works) | [Settings](#-settings) | [Safety](#-safety) | [Acknowledgements](#-acknowledgements)

</div>

---

## 💡 What It Does

The server adds one tool, `glm_agent`, to Claude Code. Name it in a prompt and Claude hands the task to a GLM model. GLM reads and edits files and runs commands in your project folder, then returns a summary, the changed files, and its token usage. The work is billed to your GLM Coding Plan, and Claude's context only receives the summary.

```text
Use glm_agent to add unit tests for utils.py in this repo, then summarize what changed.
```

GLM works well on clear, self-contained tasks: scaffolding, tests, translation, docs, small refactors. Tasks that depend on the whole conversation should stay on Claude, since GLM cannot see it.

## 🚀 Quick Start

You need Claude Code, Node.js 18 or newer, and an API key from a GLM Coding Plan.

**1. Download and install**

```bash
git clone https://github.com/HOWILLMAKEIT/glm-subagent-mcp.git
cd glm-subagent-mcp
npm install
```

**2. Add it to Claude Code**

```bash
claude mcp add glm -s user -e GLM_API_KEY=YOUR_KEY -- node /absolute/path/to/glm-subagent-mcp/src/index.js
```

If your Coding Plan account is on the mainland-China site (bigmodel.cn), add one more setting. The default address is the international one:

```bash
claude mcp add glm -s user -e GLM_API_KEY=YOUR_KEY -e GLM_BASE_URL=https://open.bigmodel.cn/api/anthropic -- node /absolute/path/to/glm-subagent-mcp/src/index.js
```

**3. Restart Claude Code and ask for it by name**

```text
Delegate the README translation to GLM with glm_agent. Work in /path/to/project.
```

To check the setup without a key, run `npm test`. It runs the whole flow against a fake GLM server on your machine.

## 🔍 How It Works

```mermaid
flowchart LR
    A["You"] -->|"use glm_agent to ..."| B["Claude Code"]
    B -->|"task + project folder"| C["glm_agent"]
    C <-->|"what next? / here is the result"| D["GLM model"]
    C <-->|"read, edit, run commands"| E[("your project folder")]
    C -->|"short report"| B
```

1. Claude calls `glm_agent` with a task and the project folder's absolute path.
2. `glm_agent` asks GLM what to do. GLM answers with a step such as "read this file" or "run this command". `glm_agent` carries out the step in your folder and tells GLM the result. This repeats until GLM says it is done, or after 30 rounds.
3. Claude receives GLM's summary, the list of changed files, and the token counts.

### Tool options

| Option    | Required | Meaning                                                               |
| :-------- | :------: | :-------------------------------------------------------------------- |
| `task`    |    ✅    | What GLM should do. Write it in full, since GLM cannot see your chat. |
| `workdir` |    ✅    | Absolute path of the folder GLM works in.                             |
| `context` |          | Extra background or constraints.                                      |
| `model`   |          | `glm-5.3` (default) or `glm-5.3-flash`.                               |

GLM has five actions inside that folder: read a file, write a file, edit a file, list a directory, and run a shell command.

## 📋 Settings

Pass settings with `-e NAME=value` when you run `claude mcp add`.

| Setting        | Default                          | Meaning                                                                                                    |
| :------------- | :------------------------------- | :--------------------------------------------------------------------------------------------------------- |
| `GLM_API_KEY`  | none                             | Your Coding Plan API key. Required.                                                                        |
| `GLM_BASE_URL` | `https://api.z.ai/api/anthropic` | Coding Plan address. Mainland-China accounts: `https://open.bigmodel.cn/api/anthropic`                     |
| `GLM_MODEL`    | `glm-5.3`                        | Model to use. The Coding Plan supports `glm-5.3` and `glm-5.3-flash`.                                      |

Z.ai warns that using the wrong address means your Coding Plan quota is not used ([docs](https://docs.z.ai/devpack/tool/others.md), accessed 2026-10-07).

<details>
<summary>Advanced settings</summary>

| Setting                     | Default  | Meaning                                                             |
| :-------------------------- | :------- | :------------------------------------------------------------------ |
| `GLM_AGENT_MAX_ITERS`       | `30`     | Maximum rounds per task                                             |
| `GLM_AGENT_BASH_TIMEOUT_MS` | `120000` | Time limit for one shell command                                    |
| `GLM_MAX_TOKENS`            | `32768`  | Output limit per round (this project's choice, not an official cap) |
| `GLM_MAX_CONCURRENT`        | `1`      | Requests sent to GLM at the same time                               |
| `GLM_STALL_TIMEOUT_MS`      | `120000` | How long to wait in silence before retrying                         |

</details>

## 🔒 Safety

- File actions only work inside the folder you pass as `workdir`. Paths outside it are refused, including paths that reach outside through symbolic links.
- Shell commands start in `workdir` but are **not** restricted. GLM can run any command, so use this on folders you are fine letting it change.
- Your code is sent to Z.ai's servers. Keep secrets and regulated code on your own machine.
- Z.ai's FAQ says the Coding Plan is limited to officially supported tools and products ([FAQ](https://docs.z.ai/devpack/faq.md), accessed 2026-10-07). Whether a self-made plug-in like this one is allowed is for you to confirm.

## 📢 Status

Tested end to end against a fake GLM server, and once against the mainland-China Coding Plan address (open.bigmodel.cn) with `glm-5.3`. The international z.ai address has not been tested.

## 🙏 Acknowledgements

Thanks to [djerok/glm-mcp](https://github.com/djerok/glm-mcp) (MIT). This project started from its GLM client and agent loop.

<p align="right"><a href="#top">🔝Back to top</a></p>
