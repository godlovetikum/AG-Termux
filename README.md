# ag — a free-tier coding agent for your phone

`ag` turns the free API tiers of Gemini and Groq into one coding agent that runs in
[Termux](https://termux.dev) on Android. It has two parts, both plain Node.js with **zero dependencies**:

- **A local router** (`127.0.0.1:4000`) that speaks the OpenAI chat format and tries providers in order.
  When one hits a rate limit or errors, it moves to the next, remembers which are cooling down,
  and keeps usage stats.
- **An agent CLI** that reads your project, proposes edits, and **asks before every file change and command**.
  It starts and stops the router itself, saves every chat, backs up every file before it changes it,
  and can undo.

```
you ─▶ ag (chat, tools, review) ─▶ router :4000 ─▶ Groq  (fast edits)
                                              └──▶ Gemini (big-context planning)
```

## Install

You need Termux from [F-Droid](https://f-droid.org/packages/com.termux/) or GitHub (the Play Store build is outdated), and:

```sh
pkg update && pkg install nodejs git curl diffutils
```

Then pick **one** route.

**A. One command** (downloads the repo files, verifies them, installs):

```sh
curl -fsSL https://raw.githubusercontent.com/godlovetikum/ag-termux/main/scripts/bootstrap.js | node -
```

**B. From the zip** (works offline once the zip is on your phone):

```sh
pkg install unzip
unzip ag-termux.zip && cd ag-termux
node install.js
```

**C. From git:**

```sh
git clone https://github.com/godlovetikum/ag-termux && cd ag-termux
node install.js
```

The installer copies the program to `~/ag`, writes an `ag` launcher into Termux's `bin`, creates a
private `~/.keys` template, and makes new shells load it. It is safe to run again.
Preview it first with `node install.js --dry-run`.

## Set up your keys

Free keys, no card needed: [Gemini](https://aistudio.google.com) and [Groq](https://console.groq.com).

```sh
nano ~/.keys          # paste your keys between the quotes
source ~/.keys
cd ~/Projects/my-app
ag doctor             # checks tools, keys, live provider access, router
ag                    # start chatting
```

## Everyday use

```sh
ag                       # chat in the current folder (router starts and stops with it)
ag chat "fix the login bug" --plan   # start with the planning lane (Gemini first)
ag resume                # continue the last chat for this folder
```

Inside the chat: `/plan` (Gemini first, for reading and planning), `/edit` (Groq first, for fast changes),
`/new`, `/status`, `/changes`, `/undo`, `/log`, `/stats`, `/help`, `/exit`.

Every write shows a diff and asks `y / n / d / v / s` (apply, deny, full diff, view file, stage a copy).
Every command asks `y / n` and warns about `rm -r`, `sudo`, `git push`, env files and `curl | sh`.

Full command list: `ag help`. More detail in [docs/USAGE.md](docs/USAGE.md).

## Docs

| | |
|---|---|
| [docs/USAGE.md](docs/USAGE.md) | Every command, chat command, and workflow |
| [docs/CONFIG.md](docs/CONFIG.md) | Providers, lanes, limits; adding Cerebras or OpenRouter |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Termux quirks, rate limits, Gemini errors |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the router, agent and data folder fit together |
| [CHANGELOG.md](CHANGELOG.md) | What changed |

## Safety and privacy

- Keys live in `~/.keys` (mode 600), never in a project. The router rejects requests from web pages and other devices (`127.0.0.1` only, Host header checked).
- The agent refuses to read `.env*` files (except `.example`), `.git`, and paths outside the project folder.
- **Your code is sent to Google/Groq with each request**, and free tiers may train on prompts. Keep secrets and client code you can't share out of prompts.
- Saved chats (`~/.ag/sessions`) include file contents the agent read. `ag sessions rm <id>` deletes one.
- Router logs hold metadata only, never prompts.

## Known limits

- Free tiers are small. Groq's `gpt-oss-120b` allows about 8,000 tokens per minute, so large files push requests to Gemini. Use `/plan` for heavy reading and `/edit` for small changes; start `/new` often.
- Free models sometimes write bad tool calls. The review step is there for that reason.
- Model IDs and free limits change without notice. If a lane breaks, `ag doctor` and `ag logs` show why, and `ag config edit` fixes the model name.
- Tested on Linux with mock providers and a pseudo-terminal end-to-end test (`npm test`, `npm run test:e2e`). It has not been run against live provider quotas from this repo's CI.

## Development

```sh
npm test              # unit + integration (no network, no keys)
npm run test:e2e      # drives the real chat through a pty (needs python3)
```

MIT licensed.
