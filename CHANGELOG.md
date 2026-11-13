# Changelog

## 1.0.0
First packaged release, assembled from the working Termux setup.

- Router: lanes with ordered fallback, per-provider cooldowns (honours `retry-after`), one short wait-and-retry on rate limits, request timeouts, `/health[?deep=1]`, `/stats`, `/config`, admin reset/reload/shutdown, daily stats persisted for 7 days, localhost-only with Host header check.
- Gemini 3 fix: tool calls written by other providers get Google's documented `skip_thought_signature_validator` value; Gemini-only fields are stripped before other providers see them.
- Agent: reviewed writes and edits (y/n/diff/view/stage), command confirmation with risk warnings, change log, per-change backups, `undo` with a modified-since check, saved sessions with resume, clipped tool output (30k chars), `read_file` on a folder gives a clear error.
- CLI: `chat`, `resume`, `router`, `health`, `stats`, `doctor`, `logs`, `sessions`, `show`, `changes`, `undo`, `config`.
- Default edit lane is Groq `gpt-oss-120b`, then Gemini (Qwen removed: it wrote malformed tool calls).
- Installer (`install.js`), one-step bootstrap (`scripts/bootstrap.js`), tests and CI.
