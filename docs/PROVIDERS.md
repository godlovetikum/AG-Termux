# Providers

agt works with any provider that offers an **OpenAI-compatible `/chat/completions` endpoint with tool (function) calling**. The agent depends on tool calls to read, edit and run things locally.

## Adding one

1. Add it under `providers` (`agt config edit`), for example Cerebras:
   ```json
   "cerebras": { "url": "https://api.cerebras.ai/v1", "keyEnv": "CEREBRAS_API_KEY" }
   ```
2. Add the key: `agt keys set cerebras`.
3. See which model ids it offers: `agt models cerebras --live`.
4. Use one of them: pin it with `/model cerebras/<model-id>`, or add `["cerebras", "<model-id>"]` to a lane.

Check a new provider with `agt doctor` (it tests the key live) before relying on it.

## Not a fit: Manus

Manus is not a drop-in model for a lane. As of this release its API is an agent-task API, not a tool-calling chat model:

- Work runs as asynchronous **tasks** you poll for results, not as a request that returns a reply.
- Its OpenAI compatibility is the Responses API for those tasks (v1 docs, now deprecated in favour of API v2), not `/chat/completions`.
- The agent runs in Manus's own cloud sandbox with its own tools; it cannot call agt's local tools, so it cannot edit your local files through the edit lane.
- The v1 compatibility docs cap each request at roughly 5,000 tokens of text, and usage is metered in credits.

It could make sense later as a separate "delegate a research task" command, but not as a model in a failover lane.

## Gemini notes

Gemini 3 requires a "thought signature" on tool calls in the history. The router adds Google's documented placeholder for tool calls written by other providers, so you can switch between Gemini and other models mid-chat.
