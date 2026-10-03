# LetsPlayQuiz

[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md)

[LetsPlayQuiz](https://letsplayquiz.net) turns one link into a quiz your friends can play on their phones. This repository holds the tools around its public API, so AI agents (and you) can create and publish quizzes from the terminal:

- **`letsplayquiz`** (`packages/cli`): the command-line client.
- **`lpqz`** (`packages/lpqz`): a short alias package that runs the same CLI (`npx lpqz ...`).
- **`skills/letsplayquiz`**: a Claude skill that drives the CLI to design a quiz with you.
- **[`docs/api.md`](docs/api.md)**: the public HTTP API v1 contract.

Quiz kinds you can make:

| Kind | `kind` | What players get |
|---|---|---|
| Score | `score` | Questions with one right answer out of four; players get a score |
| Personality | `type` | No right answers; picks add up to a "you are the ___ type" result |
| Balance | `balance` | This-or-that questions; players see what everyone else picked |
| Bracket (world cup) | `worldcup` | 8 or 16 candidates face off one-on-one until a winner remains |

No login is needed to create a quiz. Publishing returns a public play link and a secret owner (dashboard) link.

> The LetsPlayQuiz web app itself is **not** open source. Only the CLI, the alias package, the skill and the API documentation in this repository are (MIT).

## CLI

Requires Node.js 20 or newer. Nothing to install:

```sh
npx letsplayquiz guide --kind balance   # rules + a complete example for one kind
npx letsplayquiz validate test.json     # check without saving
npx letsplayquiz publish test.json      # validate, then publish
npx letsplayquiz list                   # tests published from this computer
```

`lpqz` is a shorter alias: `npx lpqz guide`. Use `-` instead of a file name to read JSON from standard input.

| Command | Description |
|---|---|
| `guide [--kind score\|type\|balance\|worldcup]` | Print the guide (all kinds if `--kind` is omitted) |
| `validate <file \| ->` | Check a quiz JSON without saving it |
| `publish <file \| ->` | Validate, then publish |
| `list` | Show tests published from this computer, newest first (no network call) |

| Option | Description |
|---|---|
| `--json` | Print the server response (or the `list` records) as-is |
| `--lang ko\|ja\|en` | Language of server messages (`lang` query); default `ko` |
| `--api <url>` | Server URL. `https` only (`http://localhost` and `http://127.0.0.1` are allowed for local development). Also settable with the `LETSPLAYQUIZ_API` environment variable (the flag wins). Default `https://letsplayquiz.net` |
| `--no-save` | Do not record the `publish` result locally |
| `--help`, `--version` | Help / version |

Exit codes: `0` success, `1` validation failed, `2` usage error, `3` rate limited, `4` network or server error (nothing was published), `5` publish outcome unknown (do not blindly retry). Details are in [`packages/cli/README.md`](packages/cli/README.md) (Korean).

`publish` appends the result, including the secret owner link, to `~/.config/letsplayquiz/tests.jsonl` (under `XDG_CONFIG_HOME` if set) with restrictive permissions, and prints it. The owner link cannot be reissued, so treat it as a secret and be careful with CI logs.

## MCP server

`letsplayquiz-mcp` is a local [MCP](https://modelcontextprotocol.io) (stdio) server for agents that speak MCP instead of shelling out. Tools: `get_guide`, `validate_quiz`, `publish_quiz`, `list_my_quizzes`. It reuses the CLI logic and shares its history file.

```sh
claude mcp add letsplayquiz -- npx -y letsplayquiz-mcp
```

Configs for Claude Desktop and Cursor, and the `LETSPLAYQUIZ_API` override, are in [`packages/mcp/README.md`](packages/mcp/README.md). `publish_quiz` publishes a public quiz, so the agent should confirm with you first.

## Claude skill

`skills/letsplayquiz` is an [Agent Skill](https://agentskills.io) that interviews you briefly, writes the quiz JSON, validates it and publishes it after you confirm.

**Claude Code** (plugin marketplace):

```sh
claude plugin marketplace add letsplayquiz/letsplayquiz
claude plugin install letsplayquiz@letsplayquiz
```

Inside a session you can run `/plugin marketplace add letsplayquiz/letsplayquiz` and `/plugin install letsplayquiz@letsplayquiz` instead.

**Other agents** (Codex, Cursor, GitHub Copilot, Gemini CLI, … via the open [`skills`](https://www.npmjs.com/package/skills) installer):

```sh
npx skills add letsplayquiz/letsplayquiz
```

**Claude.ai / Claude desktop app**: zip the `skills/letsplayquiz` folder and upload it as a skill in Claude's settings.

Then ask something like "make a this-or-that quiz about ramen".

## API

The CLI is a thin client over a public HTTP API. See [`docs/api.md`](docs/api.md) if you want to call it directly.

## Contributing

Issues and pull requests are welcome. Development uses pnpm (see `packageManager` in `package.json`):

```sh
pnpm install
pnpm test     # vitest
pnpm build    # compile packages
pnpm smoke    # build + run the built CLI and MCP server against a local mock server
```

Publishing to npm: `letsplayquiz` first, then `lpqz` and `letsplayquiz-mcp` (both depend on the exact `letsplayquiz` version).

The server owns all quiz rules; the CLI must not duplicate or bypass them. Please keep changes small and add tests for behavior changes.

## License

[MIT](LICENSE) © 2026 swewpapa
