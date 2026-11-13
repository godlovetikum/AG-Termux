# Usage

## Commands

| Command | What it does |
|---|---|
| `ag` / `ag chat ["message"]` | Chat in the current folder. Flags: `--plan`, `--edit`, `--keep` (leave router running), `--debug` |
| `ag resume [id]` | Continue the latest chat for this folder, or a specific one |
| `ag router start\|stop\|restart\|status\|reset\|logs` | Control the router. `reset` clears cooldowns |
| `ag health [--deep] [--json]` | Router status. `--deep` tests each key live (uses no tokens) |
| `ag stats` | Requests per provider per day (UTC). An estimate: providers reset on their own clocks |
| `ag doctor` | Checks Node, git, diff, keys, live provider access, router, config |
| `ag logs [router\|agent] [-n 40] [-f] [--raw]` | Readable logs; `-f` follows |
| `ag sessions [n]` / `ag sessions rm <id>` | List or delete saved chats |
| `ag show <id> [--full]` | Print a saved chat |
| `ag changes [-n 15]` | Files and commands the agent touched or was denied |
| `ag undo [id] [--force]` | Restore a file the agent changed (asks first) |
| `ag config [show\|path\|edit]` | View or edit config; `edit` validates and hot-reloads the router |
| `ag help [command]`, `ag version` | |

Exit codes: `0` ok, `1` problem, `2` router has no usable provider (`ag health`).

## Chat commands

`/plan` `/edit` `/lane <name>` switch lane · `/new` fresh session (old one stays saved) ·
`/status` context size and router health · `/health [deep]` · `/stats` · `/log [n]` ·
`/changes` · `/undo [id]` · `/sessions` · `/debug` · `/exit`.

Pasting several lines sends them as one message. **Ctrl+C** cancels a running request; at the prompt it saves and quits.

## Reviewing changes

Before any write the agent shows a diff preview (20 lines by default; `previewLines` in config) and asks:

- `y` apply · `n` (or Enter) deny, with an optional reason sent back to the model
- `d` full diff · `v` view the whole proposed file
- `s` stage a copy in `~/.ag/proposed/` to open in your editor (the real file stays untouched)

Applied changes get a number (`#12`). A copy of the file from before the change is kept in `~/.ag/backups/`,
so `/undo` works even after you delete the chat. Undo refuses if the file changed since (use `--force` to override).

## A good loop for a phone

1. `git status` (so you can see what the agent changes) then `ag --plan`.
2. Ask it to read the relevant files and write a short plan.
3. `/edit`, then one small task at a time. Review each diff.
4. Commit and let CI run tests; paste failures back in.
5. `/new` when a chat gets long. It saves tokens and request quota.

Put stack, folder layout and rules in `AGENTS.md` or `GEMINI.md` in the project root. The agent loads either
automatically at the start of each session.

## Keeping secrets out

- Add `.env` files to `.gitignore`. The agent refuses to read `.env*` anyway, and warns if a command mentions one.
- If a secret ever reached a chat, rotate it and delete that chat: `ag sessions rm <id>`.
