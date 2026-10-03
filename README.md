# LetsPlayQuiz

[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md)

[LetsPlayQuiz](https://letsplayquiz-net.vercel.app) turns one link into a quiz your friends can play on their phones. This repository holds the tools around its public API, so AI agents (and you) can create and publish quizzes from the terminal:

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
| `--api <url>` | Server URL. `https` only (`http://localhost` and `http://127.0.0.1` are allowed for local development). Also settable with the `LETSPLAYQUIZ_API` environment variable (the flag wins). Default `https://letsplayquiz-net.vercel.app` |
| `--no-save` | Do not record the `publish` result locally |
| `--help`, `--version` | Help / version |

Exit codes: `0` success, `1` validation failed, `2` usage error, `3` rate limited, `4` network or server error (nothing was published), `5` publish outcome unknown (do not blindly retry). Details are in [`packages/cli/README.md`](packages/cli/README.md) (Korean).

`publish` appends the result, including the secret owner link, to `~/.config/letsplayquiz/tests.jsonl` (under `XDG_CONFIG_HOME` if set) with restrictive permissions, and prints it. The owner link cannot be reissued, so treat it as a secret and be careful with CI logs.

## Claude skill

`skills/letsplayquiz` is a [Claude Code skill](https://docs.claude.com/en/docs/claude-code/skills) that interviews you briefly, writes the quiz JSON, validates it and publishes it after you confirm. Install it by symlinking (or copying) the folder into your skills directory:

```sh
git clone https://github.com/swewpapa/letsplayquiz.git
mkdir -p ~/.claude/skills
ln -s "$PWD/letsplayquiz/skills/letsplayquiz" ~/.claude/skills/letsplayquiz
# or: cp -R letsplayquiz/skills/letsplayquiz ~/.claude/skills/
```

Then ask Claude Code something like "make a this-or-that quiz about ramen".

## API

The CLI is a thin client over a public HTTP API. See [`docs/api.md`](docs/api.md) if you want to call it directly.

## Contributing

Issues and pull requests are welcome. Development uses pnpm (see `packageManager` in `package.json`):

```sh
pnpm install
pnpm test     # vitest
pnpm build    # compile packages
pnpm smoke    # build + run the built CLI against a local mock server
```

The server owns all quiz rules; the CLI must not duplicate or bypass them. Please keep changes small and add tests for behavior changes.

## License

[MIT](LICENSE) © 2026 swewpapa
