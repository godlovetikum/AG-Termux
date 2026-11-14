# Troubleshooting

Start with `agt doctor`. It names the problem and prints a fix under each failure.

## Install and commands

| Symptom | Fix |
|---|---|
| `npm: command not found` / `node: command not found` | Install Node.js 18.17+ (Termux: `pkg install nodejs`) |
| `agt: command not found` after install | Open a new terminal. Check `npm bin -g` (older npm) or `npm prefix -g` is on your PATH |
| `EEXIST` when installing | An old `agt` command exists. Remove it (`rm "$(command -v agt)"`) or add `--force` |
| `bad interpreter: /usr/bin/env` (Termux) | Reinstall (`npm install -g agt-cli`): the postinstall step fixes the launcher. Or run `termux-fix-shebang "$(command -v agt)"` |
| PowerShell: "running scripts is disabled" | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or run from Command Prompt |
| `agt` runs a different program | Another tool uses the name. Use `agt-cli` instead |
| Permission errors on `npm install -g` (macOS/Linux) | Use a user-level npm prefix (`npm config set prefix ~/.npm-global` and add it to PATH) rather than `sudo` |

## Keys

| Symptom | Fix |
|---|---|
| `GROQ_API_KEY is not set` | `agt keys set groq` (or `agt setup`) |
| `stray quotes or spaces` | `agt keys set groq` again: paste only the key |
| `HTTP 401/403` | The key was rejected. Create a new one and set it again |
| Key is set but `agt doctor` says "from environment" | A real environment variable overrides `keys.env`. Unset it or update it |

## The router and rate limits

| Symptom | Fix |
|---|---|
| `all providers failed` | Read the per-provider errors printed under it. `agt logs router` has the history |
| `HTTP 429` / "rate limit" | Free-tier cap. The router waits briefly and fails over. `agt health` shows what is parked; `agt router reset` clears it |
| Request too large for a provider | Use `/compact` or `/new`, or pin a large-context model: `/model big` |
| `port 4000 is already in use` | Change `port` in `agt config edit`, then `agt router restart` |
| Router runs old code after an update | `agt router restart` |

## Models

| Symptom | Fix |
|---|---|
| Unknown model for a provider | `agt models <provider> --live` lists valid ids |
| Gemini says a thought signature is missing | Update (`agt update`); older versions did not add the placeholder |
| A model writes broken tool calls | Remove it from the lane, or pin a different one |

## Windows notes

Shell commands the agent runs use `cmd.exe`; the agent is told this. Use Git Bash or WSL if you want POSIX commands. Line endings are preserved when editing files.

## Still stuck

`agt logs agent` and `agt logs router` hold the details. Include `agt doctor` output when asking for help.
