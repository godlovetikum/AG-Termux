# agt

A free-tier coding agent for your terminal. It talks to free LLM APIs (Gemini, Groq, ...) through a small local router that fails over when one is rate-limited, edits your files **only after you approve each change**, remembers your chats, and explains what is wrong when something breaks.

- **Free by design:** use the free tiers you already have. Zero dependencies.
- **You stay in control:** every file write and command asks first (`y` / `n` / `d` diff / `v` view / `s` stage a copy). Every change is backed up and can be undone.
- **Works everywhere:** Windows, macOS, Linux and Android ([Termux](https://termux.dev)).
- **Built to be debugged:** `agt doctor`, a router `/health` endpoint, readable logs, saved sessions.

## Install

Needs [Node.js](https://nodejs.org) 18.17 or newer.

```
npm install -g agt-cli
```

| Platform | Before you start |
|---|---|
| **Windows** | Install Node.js from nodejs.org, then run the command in PowerShell or Terminal. |
| **macOS** | `brew install node` (or nodejs.org), then the command above. |
| **Linux** | Install Node.js with your package manager or nvm, then the command above. |
| **Android (Termux)** | `pkg install nodejs`, then the command above. |

Install straight from GitHub (before a release, or to test a branch):

```
npm install -g github:godlovetikum/agt-cli
```

Offline or from a zip: unzip it, `cd` into the folder, run `npm install -g .`

Update later with `agt update`. Remove with `npm uninstall -g agt-cli`.

## Quick start

```
agt setup          # paste your free API keys (input is hidden)
agt doctor         # checks everything and says how to fix what is wrong
cd my-project
agt                # start chatting
```

Get free keys: [Gemini](https://aistudio.google.com/apikey), [Groq](https://console.groq.com/keys). One is enough; two give you failover.

## Lanes and models

A **lane** is an ordered failover list: if the first model is rate-limited, the next one answers. Two ship by default: `edit` (fast edits) and `plan` (reading and planning).

A **model pin** is separate from lanes: it forces one exact model with no failover.

```
/lane plan                          switch lane
/model fast                         pin an alias from your config
/model groq/openai/gpt-oss-120b     pin any provider/model-id
/model auto                         unpin, go back to the lane
/models live                        list every model your providers offer
```

Or at start: `agt --model fast`, `agt --lane plan`.

## Commands

`agt help` lists everything. The main ones:

| Command | What it does |
|---|---|
| `agt` / `agt chat` | Chat in the current folder (`agt resume` continues the last chat) |
| `agt setup`, `agt keys` | Add, list or remove API keys |
| `agt models [--live]` | Lanes, aliases and available models |
| `agt doctor` | Diagnose setup, keys, router, updates |
| `agt router start\|stop\|restart\|status\|reset` | Control the local router |
| `agt health [--deep]` | Router health (`--deep` tests each key live) |
| `agt stats`, `agt logs [-f]` | Usage per provider, readable logs |
| `agt sessions`, `agt show <id>` | Saved chats |
| `agt changes`, `agt undo` | What the agent changed, and undo it |
| `agt config [edit]` | View or edit lanes, aliases, providers, limits |
| `agt update` | Update to the latest version |

In chat, `/help` shows the slash commands (`/compact` shrinks a long chat to save tokens).

## Safety

- File changes and commands need your approval; commands show risk warnings (deleting files, `sudo`, `git push`, piping downloads into a shell).
- The agent cannot leave the project folder (symlinks included), cannot touch `.git`, and cannot read `.env` files.
- Your keys are stored in a private file (`keys.env`, owner-only) or your environment. They are never printed or logged.
- The router listens on `127.0.0.1` only, rejects requests from web pages, and logs metadata, never your prompts.
- Saved chats include the file contents the agent read, so treat `~/.agt/sessions` as private. `agt sessions rm <id>` deletes one.

## More

[Usage](docs/USAGE.md) · [Configuration](docs/CONFIG.md) · [Providers](docs/PROVIDERS.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [Architecture](docs/ARCHITECTURE.md) · [Releasing](docs/RELEASING.md) · [Changelog](CHANGELOG.md)

MIT licensed.
