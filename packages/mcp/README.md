# letsplayquiz-mcp

A local [MCP](https://modelcontextprotocol.io) (stdio) server for [LetsPlayQuiz](https://letsplayquiz.net). It lets AI agents read the authoring guide, validate a quiz, publish it and list what you published. It uses the same logic as the [`letsplayquiz`](../cli) CLI and writes to the same local history file.

## Install

Nothing to install globally; MCP clients start it with `npx`. Node.js 20 or newer.

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

## Tools

| Tool | What it does |
| --- | --- |
| `get_guide` `{kind?, lang?}` | Authoring guide as JSON. `kind` is `score`, `type`, `balance` or `worldcup`; `lang` is `ko`, `ja` or `en`. Read-only. |
| `validate_quiz` `{quiz, lang?}` | Returns `ok`, `blockers` (must fix) and `warnings`. A failed validation is a normal result, not an error. Read-only. |
| `publish_quiz` `{quiz, lang?, save?}` | Publishes a **public** quiz on letsplayquiz.net and returns `url` and `ownerUrl`. `save` (default `true`) records the result in the local history. The agent should confirm with you first. |
| `list_my_quizzes` `{}` | Quizzes published from this computer, newest first. No server call. Includes each `ownerUrl`. |

`ownerUrl` is the only proof that you own a quiz and it cannot be reissued. Keep it private.

`publish_quiz` follows the CLI's exit semantics: validation failures list the blockers, rate limiting reports the retry delay, and a definite failure says the quiz was **not published**. If the outcome is unknown (timeout, dropped connection, ambiguous response) the result is an error saying the quiz **may** have been published; the agent must not retry automatically and should ask you. Owner links in the raw response are redacted.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `LETSPLAYQUIZ_API` | `https://letsplayquiz.net` | Server base URL. Must be `https` (plain `http` only for `localhost`, `127.0.0.1`, `[::1]`). An invalid value makes the server exit at startup with a message on stderr. |
| `XDG_CONFIG_HOME` | `~/.config` | The history file is `$XDG_CONFIG_HOME/letsplayquiz/tests.jsonl`, shared with the CLI. |

Example for a local development server (Claude Code):

```sh
claude mcp add letsplayquiz -e LETSPLAYQUIZ_API=http://localhost:3100 -- npx -y letsplayquiz-mcp
```

The server never writes logs to stdout (that channel carries the protocol); diagnostics go to stderr.

## License

MIT
