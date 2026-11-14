# Configuration

`agt config edit` opens `config.json` and tells a running router to reload it. `agt config` prints it with any problems found.

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
  "aliases": { "fast": "groq/openai/gpt-oss-120b", "big": "gemini/gemini-3-flash-preview" },
  "providers": {
    "gemini": { "url": "https://generativelanguage.googleapis.com/v1beta/openai", "keyEnv": "GEMINI_API_KEY", "keepGeminiFields": true },
    "groq": { "url": "https://api.groq.com/openai/v1", "keyEnv": "GROQ_API_KEY" }
  },
  "lanes": {
    "plan": [["gemini", "gemini-3-flash-preview"], ["groq", "openai/gpt-oss-120b"]],
    "edit": [["groq", "openai/gpt-oss-120b"], ["gemini", "gemini-3-flash-preview"]]
  }
}
```

| Field | Meaning |
|---|---|
| `port` | Local router port (a change needs `agt router restart`) |
| `defaultLane` | Lane used when none is chosen |
| `cooldownSec` | How long a rate-limited model is parked when the provider gives no retry hint |
| `requestTimeoutSec` | Per-request timeout before failing over |
| `commandTimeoutSec` | Timeout for commands the agent runs |
| `maxSteps` | Model calls per message before it stops and asks you to continue |
| `maxToolChars` | Most characters of one tool result sent to the model (you still see everything) |
| `previewLines` | Diff lines shown before you choose `d` for the rest |
| `aliases` | Short names: `"fast": "provider/model-id"` (or a lane name) |
| `providers` | OpenAI-compatible endpoints. `keyEnv` is the variable holding the key. `keepGeminiFields` keeps Gemini's thought signatures |
| `lanes` | Ordered `["provider", "model-id"]` failover lists |

## Keys

Keys come from environment variables, or from `keys.env` in the data folder. Environment variables win. Manage the file with `agt setup` or `agt keys set <provider>`. Scripted: `echo "$KEY" | agt keys set groq --stdin`.

## Environment variables

| Variable | Meaning |
|---|---|
| `AGT_HOME` | Data folder (`AG_HOME` still works) |
| `AGT_NO_UPDATE_CHECK` | Set to skip the update check in `agt doctor` |
| `AGT_REGISTRY` | npm registry used for update checks (default `https://registry.npmjs.org`) |
| `NO_COLOR` | Turn colors off |
| `VISUAL` / `EDITOR` | Editor for `agt config edit` |
