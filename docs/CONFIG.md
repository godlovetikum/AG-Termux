# Configuration

`ag config edit` opens `~/.ag/config.json`, validates it, and tells the running router to reload.
(A changed `port` needs `ag router restart`.) The file is created with defaults on first run and is never overwritten.

```json
{
  "port": 4000,
  "defaultLane": "edit",
  "cooldownSec": 300,
  "requestTimeoutSec": 120,
  "commandTimeoutSec": 120,
  "maxSteps": 25,
  "maxToolChars": 30000,
  "previewLines": 20,
  "providers": {
    "gemini": { "url": "https://generativelanguage.googleapis.com/v1beta/openai", "keyEnv": "GEMINI_API_KEY", "keepGeminiFields": true },
    "groq":   { "url": "https://api.groq.com/openai/v1", "keyEnv": "GROQ_API_KEY" }
  },
  "lanes": {
    "plan": [["gemini", "gemini-3-flash-preview"], ["groq", "openai/gpt-oss-120b"]],
    "edit": [["groq", "openai/gpt-oss-120b"], ["gemini", "gemini-3-flash-preview"]]
  }
}
```

| Key | Meaning |
|---|---|
| `lanes` | Name → ordered list of `[provider, model]`. The router tries them in order. The agent's model name is the lane name |
| `providers.*.keyEnv` | Name of the environment variable holding the key (keys are never stored in the config) |
| `keepGeminiFields` | Set on Gemini-style providers so thought signatures are kept (and added when missing) |
| `cooldownSec` | How long a rate-limited provider is parked when it gives no `retry-after` |
| `requestTimeoutSec` | A provider that hangs this long is skipped |
| `maxToolChars` | Cap on a single tool result sent to the model (protects free quotas) |
| `maxSteps` | Tool-call rounds per message before the agent stops and asks you to say "continue" |

Cooldowns: rate limit honours `retry-after` (max 1h); bad key or unknown model (401/403/404) parks 15 min; server error 1 min.
If every provider in a lane is parked, the router tries them anyway.

## Adding a provider (any OpenAI-compatible API)

Get a key, add it to `~/.keys`, then add a provider and use it in a lane. Example, Cerebras:

```sh
echo 'export CEREBRAS_API_KEY="..."' >> ~/.keys && source ~/.keys
ag config edit
```

```json
"providers": { "cerebras": { "url": "https://api.cerebras.ai/v1", "keyEnv": "CEREBRAS_API_KEY" } },
"lanes": { "edit": [["groq","openai/gpt-oss-120b"], ["cerebras","<model id from their docs>"], ["gemini","gemini-3-flash-preview"]] }
```

Look up the exact model ID in the provider's docs or its `/models` endpoint; IDs change. OpenRouter works the same way
(`https://openrouter.ai/api/v1`, model IDs ending in `:free`). Run `ag doctor` afterwards: it probes every provider you have a key for.

## Environment variables

| | |
|---|---|
| `AG_HOME` | Data folder (default `~/.ag`) |
| `EDITOR` | Used by `ag config edit` (default `nano`) |
| `NO_COLOR` | Disable colors |
