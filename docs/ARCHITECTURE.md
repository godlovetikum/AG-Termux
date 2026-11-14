# Architecture

```
terminal ──▶ agt (src/cli.js) ──HTTP──▶ router (src/router.js) ──▶ Gemini / Groq / ...
              │ tools: read, edit, run                │ lanes, cooldowns, retries, health
              └─ sessions, backups, change log        └─ stats, logs
```

| File | Role |
|---|---|
| `bin/agt.js` | Launcher (`agt`, `agt-cli`) |
| `src/cli.js` | Commands, chat loop, tools, review flow |
| `src/router.js` | Local OpenAI-compatible server: lanes, pins, failover, `/health`, `/stats`, admin |
| `src/common.js` | Paths, config, target resolution (lane / alias / `provider/model`), colors, probes |
| `src/keys.js` | `keys.env` reading and writing |
| `src/textutil.js` | Diff, line-ending handling, project-folder path check |
| `scripts/postinstall.js` | Termux launcher fix |

## Router

`POST /v1/chat/completions` takes a `model` that is a lane, an alias or `provider/model-id`. A lane is tried in order, skipping parked models; a pin is tried alone. On `429` with a short retry hint it waits once and retries; otherwise it parks the model (`retry-after` honoured) and moves on. Other endpoints: `GET /health[?deep=1]`, `/stats`, `/config`, `/v1/models`, and `POST /admin/reset|reload|shutdown`. It binds to `127.0.0.1`, checks the Host header and requires JSON bodies, so web pages cannot use it.

## Agent

Tool results are sent to the model clipped to `maxToolChars` but shown to you in full. Every write goes through `review()`; applied changes are backed up and logged in `changes.jsonl` with a hash so `undo` can refuse if the file changed since.

## Tests

`npm test` (Node's built-in runner, no dependencies) covers the router against mock providers, the CLI, the diff engine (random round-trips), line endings, keys, update checks, the Termux postinstall, and packs and installs the real npm tarball. `npm run test:e2e` drives the chat through a pseudo-terminal (Linux/macOS).
