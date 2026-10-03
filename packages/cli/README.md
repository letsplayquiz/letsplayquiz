# letsplayquiz

A CLI for AI agents to create and publish [LetsPlayQuiz](https://letsplayquiz.net) quizzes (score, personality type, balance game, and bracket "world cup"). Run it with `npx`, no install needed. For a shorter name use the alias `lpqz` (the [`lpqz` package](https://www.npmjs.com/package/lpqz) runs this same CLI).

Source, issues, the Claude skill and the full API reference live at [github.com/letsplayquiz/letsplayquiz](https://github.com/letsplayquiz/letsplayquiz).

## Getting started

```sh
npx letsplayquiz guide --kind balance
# shorter: npx lpqz guide --kind balance
```

This prints the rules for that quiz kind plus a complete example JSON that passes validation. Then ask your AI agent something like:

> Read `npx letsplayquiz guide --kind balance`, write a "pizza vs burgers" quiz, make it pass
> `npx letsplayquiz validate test.json`, then publish it with `npx letsplayquiz publish test.json`.

## Global install

This package registers only the `letsplayquiz` command. The short `lpqz` command is registered by the separate [`lpqz`](https://www.npmjs.com/package/lpqz) package (two packages declaring the same bin name would collide with `EEXIST` on global install).

| Install | Command |
|---|---|
| `npm i -g letsplayquiz` | `letsplayquiz` |
| `npm i -g lpqz` | `lpqz` |

## Commands

| Command | Description |
|---|---|
| `guide [--kind score\|type\|balance\|worldcup]` | Print the guide (all kinds if omitted) |
| `validate <file \| ->` | Check a quiz without saving it |
| `publish <file \| ->` | Publish a quiz once it passes validation |
| `list` | Show quizzes published from this computer, newest first (does not call the server) |

Pass `-` instead of a file to read JSON from standard input.

## Common fields (all kinds)

Kind-specific fields (`kind`, `questions`, `resultTypes`, …) are described with exact rules and examples by `guide --kind <kind>`. These optional top-level fields apply to every kind:

| Field | Description |
|---|---|
| `locale` | `ko`\|`ja`\|`en`. Defaults to `ko`. The language players see |
| `theme` | `classic`\|`mono`\|`candy`\|`ocean`\|`lemon`\|`mint`\|`grape`. Defaults to `classic`. Look of the play and result pages |
| `requestListing` | `boolean`, default `false`. If `true`, the quiz may appear on the public home page once an operator approves it or enough people have played. Leave it off for private content such as friends' names |

## Options

| Option | Description |
|---|---|
| `--json` | Print the raw server response (or the `list` records) |
| `--lang ko\|ja\|en` | Language of server text (query `lang`, default `ko`): validation messages, errors, and the `guide` text and examples. The CLI's own messages (connection failures, exit hints) are currently in Korean |
| `--api <url>` | Server URL. `https` only (`http://localhost` and `http://127.0.0.1` are allowed for local development; other `http` URLs are refused because the dashboard link would travel in plain text). Also settable with the `LETSPLAYQUIZ_API` environment variable (the flag wins). Default `https://letsplayquiz.net` |
| `--no-save` | Do not record the `publish` result in the local history file |
| `--help` | Show help |
| `--version` | Show version |

## Exit codes

| Code | Meaning | What to do next |
|---|---|---|
| 0 | Success (warnings allowed) | Next step |
| 1 | Validation failed (`validation_failed`) | Fix and retry |
| 2 | Usage error, missing file, or local JSON parse error | Fix the command |
| 3 | Rate limited (`rate_limited`) | Wait the indicated time |
| 4 | Network or server error (definitely not published) | Try again later |
| 5 | `publish` outcome unknown (it may or may not have been published) | Do not retry right away; check with the user |

Codes 0 and 1 are decided by the `ok` field in the response body, not the HTTP status (`validate` returns 200 even when it fails). `validate` and `publish` are contracted to always return `{ ok: boolean, ... }`, so a response that is not JSON or lacks `ok` (for example a proxy error page) is never read as success and becomes 4. `guide --json` likewise exits 4 when the response is not JSON.

`validate` and `guide` exit 4 when there is no response within 30 seconds (including a slow but connected server). **`publish` is different:** its timeout is 60 seconds, and it separates "definitely not published" (4) from "may have been published" (5) using the low-level error:

| Situation | Exit code |
|---|---|
| The request never left: DNS failure, connection refused (`ECONNREFUSED`), TLS certificate errors (expired, self-signed, unknown issuer, …), first-byte handshake errors (`ERR_SSL_WRONG_VERSION_NUMBER`, …), forbidden port | 4 |
| 60-second timeout (at any point after connecting) | 5 |
| Connected, then cut off mid-response (`ECONNRESET`, …) | 5 |
| `ok: true` but `slug`/`url`/`ownerUrl` missing | 5 |
| Response that is neither JSON nor the contracted shape, with a 2xx or 5xx status | 5 |
| 4xx with a contracted JSON error (any code except `validation_failed`/`rate_limited`): the server refused the request, so nothing was saved | 4 |
| 5xx with a known contracted error (`internal`, `unavailable`, `invalid_json`, `payload_too_large`, `unsupported_media_type`) | 4 |
| 5xx where the server itself reports an unknown outcome (`error.code: "publish_unknown"`) or an unknown new error code | 5 (the safe side) |

On 5, do not immediately `publish` the same content again; ask the user first. With `--json` the output is `{"ok":false,"error":{"code":"publish_unknown","message":"..."}}`, plus a `raw` field with the server's original response when there is one (human output shows it on a `원본 응답:` line), so a person can look for the play link in it. Because this may end up in CI logs, the dashboard token (the `/owner/…` path and the `ownerUrl` value) is printed as `[redacted]`.

## Where dashboard links are stored

On success, `publish` appends one JSON line (JSONL) to `~/.config/letsplayquiz/tests.jsonl` (under `XDG_CONFIG_HOME` if set) with `slug`, `title`, `kind`, `url`, `ownerUrl`, `api`, `publishedAt`. The file and directory are created with permissions `600`/`700` so other users on the same computer cannot read them. The CLI only appends one line per publish without a lock file, so concurrent publishes never overwrite each other (append atomicity on regular files is guaranteed by local filesystems such as Linux ext4, macOS APFS and Windows `FILE_APPEND_DATA`; network filesystems like NFS do not guarantee it, but the CLI only writes to the local home directory).

The `ownerUrl` (dashboard link) is **the only proof** that you created the quiz, because LetsPlayQuiz has no login, and it cannot be issued again. `publish` also prints it on screen, since the creator and their AI agent need it right away. **It can be seen by others if it lands in CI logs or a shared terminal session, so be careful when publishing automatically from CI.**

## Example

```sh
npx letsplayquiz guide --kind type --json > guide.json
# ... the AI reads guide.json and writes test.json ...
npx letsplayquiz validate test.json
npx letsplayquiz publish test.json
npx letsplayquiz list
```

## License

MIT
