# Troubleshooting

Start with `ag doctor`. It names the problem and prints a fix under each failure.

## Install

| Symptom | Fix |
|---|---|
| `node: command not found` | `pkg install nodejs` |
| `ag: command not found` after install | Open a new Termux session (or `hash -r`). Check `ls $PREFIX/bin/ag` |
| bootstrap says `HTTP 404` | The repo name or branch is wrong: `AG_REPO=you/ag-termux AG_REF=main` |
| `curl: command not found` | `pkg install curl` (or use the zip route) |

## Keys

| Symptom | Fix |
|---|---|
| `GROQ_API_KEY is not set` | Put `export GROQ_API_KEY="..."` in `~/.keys`, then `source ~/.keys` |
| `stray quotes or spaces` | Remove extra quotes or trailing spaces around the key in `~/.keys` |
| `HTTP 401/403` | The key was rejected. Create a new one |

## Router and models

| Symptom | Fix |
|---|---|
| `router did not start` | `ag logs router --raw`, or `cat ~/.ag/logs/router.out`. Port busy? Change `port` and `ag router restart` |
| `port 4000 is already in use` | An old router is running: `ag router stop`, or `pkill -f router.js` |
| `429 rate limit ... try again in 1.6s` | The router waits and retries once if the wait is 15s or less. Groq's free tier is about 8,000 tokens/min, so big files fail on size alone: use `/plan` (Gemini first) or `/new` |
| `Function call is missing a thought_signature` | Fixed in the router (dummy signature added). If it still appears: `/new`, then `/plan` keeps a session entirely on Gemini |
| Groq `tool_use_failed` | The model wrote a malformed tool call. Retry, or reword. The router falls back to the next provider |
| A lane is `degraded` | A provider is parked. `ag health` shows the countdown; `ag router reset` clears it |
| 404 from a provider | The model ID is wrong or retired. `ag config edit` and use a current ID |
| Stats look wrong | They count requests by UTC day. Provider quotas reset on their own clocks |

## Gemini CLI on Termux (separate tool, not part of `ag`)

If you also use Google's Gemini CLI and it says *"You need to install Termux for this module to work on Android"*,
its clipboard library checks for `TERMUX_VERSION`, which some launch methods don't set:

```sh
echo 'export TERMUX_VERSION=0.118' >> ~/.bashrc && source ~/.bashrc
```

If it also fails with `/usr/bin/env` not found: `termux-fix-shebang $(readlink -f $(which gemini))`.
Gemini CLI speaks Google's API format, so it cannot use the `ag` router. It is a fine separate tool for big first-pass reading.

## Still stuck

```sh
ag doctor
ag logs router -n 60
ag logs agent -n 40
ag health --deep
```
Run the chat with `ag --debug` to see tool calls and model round-trips.
