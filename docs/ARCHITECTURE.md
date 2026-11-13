# Architecture

```
src/common.js   shared: paths, config load/validate, colors, log formatting, provider probe
src/router.js   HTTP server on 127.0.0.1:<port>: lanes, fallback, cooldowns, health, stats
src/ag.js       CLI: chat loop, tools, review/undo, sessions, doctor, router control
install.js      copies src/ to ~/ag, writes launcher, keys template, shell hook
scripts/bootstrap.js   downloads the repo files from GitHub and runs install.js
```

## Request flow

1. The agent sends an OpenAI-style `chat/completions` request to `http://127.0.0.1:4000/v1`, with `model` set to a lane name (`plan`/`edit`) and a tool list.
2. The router looks up the lane, drops providers with no key, skips ones that are cooling down, and tries each in order.
3. Per attempt it rewrites the body for that provider (real model ID; Gemini signature handling), forwards with a timeout, and on success streams the response straight back with `x-router-via` / `x-router-attempts` headers.
4. Failures set a cooldown (see CONFIG) and the next provider is tried. A 429 with a short wait is retried once on the same provider. Switching only happens before a response starts, so an answer is never mixed from two models.
5. If everything fails, the router returns 503 with every attempt and its error, and the agent prints them in full.

## The agent loop

Per user message: call the model → print its text → run each requested tool → append results → repeat until the model stops asking for tools or `maxSteps` is reached. Tools: `list_dir`, `read_file`, `write_file`, `edit_file` (exact unique snippet), `run_command`.
All paths are resolved inside the project folder; `.env*` and `.git` are refused. Writes and commands go through confirmation. If the first model call of a message fails, that message is dropped from the history so the chat stays valid and you can simply retry.

## Data folder (`~/.ag`, mode 700)

| Path | Contents |
|---|---|
| `config.json` | Your providers, lanes, limits |
| `sessions/<id>.json` | Full chat history, usage, folder, lane |
| `changes.jsonl` | Every write/edit/command with status (applied, denied, failed), undo records |
| `backups/<session>/` | File contents from before each change |
| `proposed/` | Copies staged with `s` |
| `logs/router.log`, `agent.log` | JSON lines (metadata only), rotated at 2 MB |
| `router.pid`, `router-stats.json` | Process id; per-day request counts (7 days) |

## Design choices

- No dependencies: only Node built-ins (`http`, `fetch`, `fs`, `child_process`), so nothing has to compile on Android.
- The router is a separate process so it can be used by other OpenAI-compatible tools (Aider, OpenCode) pointed at `http://127.0.0.1:4000/v1`, and so it survives `ag --keep`.
- The router starts detached and `ag` stops it on exit only if `ag` started it.
