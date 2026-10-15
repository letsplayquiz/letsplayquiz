# LetsPlayQuiz

[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md)

[LetsPlayQuiz](https://letsplayquiz.net) turns one link into a quiz your friends can play on their phones. This repository holds the tools around its public API, so AI agents (and you) can create and publish quizzes from the terminal:

- **`letsplayquiz`** (`packages/cli`): the command-line client.
- **`lpq`** (`packages/lpq`): a short alias package that runs the same CLI (`npx lpq ...`).
- **`skills/letsplayquiz`**: a Claude skill that drives the CLI to design a quiz with you.
- **[`docs/api.md`](docs/api.md)**: the public HTTP API v1 contract.

Quiz kinds you can make:

| Kind | `kind` | What players get |
|---|---|---|
| Score | `score` | Questions with one right answer out of four; players get a score |
| Personality | `type` | No right answers; picks add up to a "you are the ___ type" result |
| Balance | `balance` | This-or-that questions; players see what everyone else picked |
| Bracket (world cup) | `worldcup` | 8 or 16 candidates face off one-on-one until a winner remains |
| Level | `level` | Each choice is worth points; the total decides a level ("Rookie", "Pro", ...) |

Personality quizzes (`type`) also support an axis form (`axes`: each result is a combination of trait poles, and the server writes the weights for you) and an optional best / worst match on each result (`goodMatch`, `badMatch`). `guide --kind type` and [`docs/api.md`](docs/api.md) have the details.

No login is needed to create a quiz. Publishing returns a public play link and a secret owner (dashboard) link.

> The LetsPlayQuiz web app itself is **not** open source. Only the CLI, the alias package, the skill and the API documentation in this repository are (MIT).

## CLI

Requires Node.js 20 or newer. Nothing to install:

```sh
npx letsplayquiz guide --kind balance   # rules + a complete example for one kind
npx letsplayquiz validate quiz.json     # check without saving
npx letsplayquiz publish quiz.json      # validate, then publish
npx letsplayquiz list                   # quizzes published from this computer
```

`lpq` is a shorter alias: `npx lpq guide`. Use `-` instead of a file name to read JSON from standard input.

| Command | Description |
|---|---|
| `guide [--kind score\|type\|balance\|worldcup\|level]` | Print the guide (all kinds if `--kind` is omitted) |
| `validate <file \| ->` | Check a quiz JSON without saving it |
| `publish <file \| ->` | Validate, then publish |
| `list` | Show quizzes published from this computer, newest first (no network call) |

| Option | Description |
|---|---|
| `--json` | Print the server response (or the `list` records) as-is. `list` leaves out each `ownerUrl` unless you add `--show-owner` |
| `--show-owner` | Include the secret owner (dashboard) link in `list` output (with or without `--json`) |
| `--lang ko\|ja\|en` | Language of server messages (`lang` query); default `ko` |
| `--api <url>` | Server URL. `https` only (`http://localhost` and `http://127.0.0.1` are allowed for local development). Also settable with the `LETSPLAYQUIZ_API` environment variable (the flag wins). Default `https://letsplayquiz.net` |
| `--no-save` | Do not record the `publish` result locally |
| `--help`, `--version` | Help / version |

Exit codes: `0` success, `1` validation failed, `2` usage error, `3` rate limited, `4` network or server error (nothing was published), `5` publish outcome unknown (do not blindly retry). Details are in [`packages/cli/README.md`](packages/cli/README.md).

`publish` appends the result, including the secret owner link, to `~/.config/letsplayquiz/tests.jsonl` (under `XDG_CONFIG_HOME` if set to an absolute path) with restrictive permissions, and prints it. The owner link cannot be reissued, so treat it as a secret and be careful with CI logs.

## MCP server

`letsplayquiz-mcp` is a local [MCP](https://modelcontextprotocol.io) (stdio) server for agents that speak MCP instead of shelling out. It reuses the CLI logic and shares its history file. Requires Node.js 20 or newer; MCP clients start it with `npx`, so there is nothing to install.

**Claude Code**

```sh
claude mcp add letsplayquiz -- npx -y letsplayquiz-mcp
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "letsplayquiz": {
      "command": "npx",
      "args": ["-y", "letsplayquiz-mcp"]
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`, or `~/.cursor/mcp.json` for all projects)

```json
{
  "mcpServers": {
    "letsplayquiz": {
      "command": "npx",
      "args": ["-y", "letsplayquiz-mcp"]
    }
  }
}
```

Tools:

| Tool | What it does |
|---|---|
| `get_guide` | Returns the authoring guide as JSON (read-only) |
| `validate_quiz` | Checks a quiz without saving it. A failed validation comes back as a normal result, not an error (read-only) |
| `publish_quiz` | Publishes a **public** quiz and returns `url` and `ownerUrl` |
| `list_my_quizzes` | Quizzes published from this computer, newest first (no server call). `ownerUrl` is hidden by default and shown only with `includeOwnerUrls: true`; use that only when the user explicitly asks for their dashboard links |

`publish_quiz` publishes a public quiz, so the agent should confirm with you first. `ownerUrl` is the only proof that you own a quiz and it cannot be reissued, so keep it private.

**If publishing fails with a timeout or a transport error and there is no result, treat it as "the quiz MAY have been published": do not retry, and ask the user.** Publishing again automatically when the outcome is unknown can create a duplicate.

The server address can be changed with the `LETSPLAYQUIZ_API` environment variable (default `https://letsplayquiz.net`; `https` only, with `http` allowed just for `localhost`, `127.0.0.1` and `[::1]`). Example for a local development server (Claude Code):

```sh
claude mcp add letsplayquiz -e LETSPLAYQUIZ_API=http://localhost:3100 -- npx -y letsplayquiz-mcp
```

Details are in [`packages/mcp/README.md`](packages/mcp/README.md).

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

Publishing to npm: `letsplayquiz` first, then `lpq` and `letsplayquiz-mcp` (both depend on the exact `letsplayquiz` version).

The server owns all quiz rules; the CLI must not duplicate or bypass them. Please keep changes small and add tests for behavior changes.

## License

[MIT](LICENSE) © 2026 swewpapa
