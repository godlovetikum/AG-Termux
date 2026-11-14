# Usage

## The review step

Whenever the agent wants to write or edit a file you see the change first:

```
▸ EDIT src/app.js
  +3 -1 lines
  @@ -10,4 +10,6 @@ ...
apply? [y]es [n]o [d]iff [v]iew file [s]tage ›
```

| Key | Does |
|---|---|
| `y` | Apply the change (a backup is saved first) |
| `n` or Enter | Deny. You can give the agent a reason, which it reads |
| `d` | Show the full diff |
| `v` | Show the whole proposed file |
| `s` | Save the proposed file to `~/.agt/proposed/` so you can open it in your editor. The real file is untouched |

Commands (`run_command`) ask `[y]es [n]o` and print their full output.

## Chat commands

| Command | Does |
|---|---|
| `/plan`, `/edit`, `/lane <name>` | Switch lane |
| `/model [name]` | Show or pin one exact model (alias or `provider/model-id`); `/model auto` unpins |
| `/models [live]` | List lanes, aliases and models |
| `/new` | Start a new session (the old one stays saved) |
| `/compact` | Summarize the chat to save tokens; the full history is kept |
| `/status` | Session, context size, router health |
| `/health [deep]`, `/stats`, `/log [n]` | Router information |
| `/changes`, `/undo [id]` | Change history and undo |
| `/sessions`, `/debug`, `/exit` | Sessions, verbose debug lines, quit |

Pasted multi-line text is sent as one message. Ctrl+C cancels a running request.

## Lanes versus model pins

- A **lane** is an ordered list in `config.json`. The router tries each entry in turn and parks a model for a while when it is rate-limited or failing.
- A **pin** (`/model`, `--model`) names one exact model. Only that model is tried; if it fails you see the error instead of a silent switch.
- Lane and pin are independent: `/lane plan` keeps your pin, `/model auto` keeps your lane. The prompt shows `[edit]` or `[model: fast]`.
- Pins are saved in the chat and restored by `agt resume`.

## Free-tier tips

- Every step resends the conversation, so long chats burn tokens. Use `/compact`, or `/new` for a fresh task.
- A small per-minute token limit (Groq's free tier is about 8,000) can reject big requests. Pin a large-context model for big files: `/model big`.
- `agt stats` shows how many requests each model has served today.

## Where things live

`~/.agt/` (or the folder in `AGT_HOME`; an older `~/.ag` is still used if that is where your data is):

| Path | Contents |
|---|---|
| `config.json` | Providers, lanes, aliases, limits |
| `keys.env` | API keys (owner-only) |
| `sessions/` | Saved chats |
| `changes.jsonl`, `backups/` | Change log and the original of every changed file |
| `logs/` | `router.log`, `agent.log` |
