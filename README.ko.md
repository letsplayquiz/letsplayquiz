# LetsPlayQuiz

[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md)

[LetsPlayQuiz](https://letsplayquiz.net)는 링크 하나로 친구들이 휴대폰에서 풀 수 있는 퀴즈를 만들어 주는 서비스입니다. 이 저장소에는 공개 API를 둘러싼 도구가 들어 있어서, AI 에이전트(그리고 당신)가 터미널에서 퀴즈를 만들고 발행할 수 있습니다.

- **`letsplayquiz`** (`packages/cli`): 명령줄 클라이언트
- **`lpqz`** (`packages/lpqz`): 같은 CLI를 실행하는 짧은 별칭 패키지 (`npx lpqz ...`)
- **`skills/letsplayquiz`**: CLI를 써서 당신과 함께 퀴즈를 설계하는 Claude 스킬
- **[`docs/api.md`](docs/api.md)**: 공개 HTTP API v1 계약서 (영어)

만들 수 있는 종류:

| 종류 | `kind` | 참여자가 받는 것 |
|---|---|---|
| 점수형 | `score` | 4지선다 정답 문제, 점수가 나옴 |
| 유형형 | `type` | 정답 없음, 선택이 모여 "당신은 ___ 유형" 결과가 나옴 |
| 밸런스 | `balance` | 둘 중 하나 고르기, 다른 사람들의 선택도 볼 수 있음 |
| 월드컵 | `worldcup` | 후보 8개 또는 16개가 1:1로 맞붙어 우승자를 가림 |

퀴즈를 만들 때 로그인은 필요 없습니다. 발행하면 참여 링크와 비밀 대시보드(owner) 링크를 돌려줍니다.

> LetsPlayQuiz 웹앱 자체는 오픈소스가 **아닙니다**. 이 저장소의 CLI, 별칭 패키지, 스킬, API 문서만 MIT로 공개합니다.

## CLI

Node.js 20 이상이 필요합니다. 설치 없이 바로 씁니다.

```sh
npx letsplayquiz guide --kind balance   # 종류별 규칙과 완성 예시
npx letsplayquiz validate test.json     # 저장하지 않고 검사
npx letsplayquiz publish test.json      # 검사 후 발행
npx letsplayquiz list                   # 이 컴퓨터에서 발행한 테스트
```

짧게는 별칭 `npx lpqz guide`로 씁니다. 파일 이름 자리에 `-`를 주면 표준 입력에서 JSON을 읽습니다.

| 명령 | 설명 |
|---|---|
| `guide [--kind score\|type\|balance\|worldcup]` | 설명서 출력 (`--kind` 생략 시 전부) |
| `validate <file \| ->` | 저장하지 않고 검사만 |
| `publish <file \| ->` | 검사를 통과하면 발행 |
| `list` | 이 컴퓨터에서 발행한 테스트를 최근 순으로 표시 (서버를 부르지 않음) |

| 옵션 | 설명 |
|---|---|
| `--json` | 서버 응답(또는 `list`의 기록)을 그대로 출력 |
| `--lang ko\|ja\|en` | 서버 메시지 언어(쿼리 `lang`), 기본 `ko` |
| `--api <url>` | 서버 주소. `https`만 허용(로컬 개발은 `http://localhost`, `http://127.0.0.1` 예외). 환경변수 `LETSPLAYQUIZ_API`로도 설정(플래그가 우선). 기본값 `https://letsplayquiz.net` |
| `--no-save` | `publish` 결과를 로컬 기록에 남기지 않음 |
| `--help`, `--version` | 도움말 / 버전 |

종료 코드: `0` 성공, `1` 검사 실패, `2` 사용법 오류, `3` 요청 제한, `4` 네트워크·서버 오류(발행 안 됨), `5` 발행 결과 불명(곧장 재시도하지 말 것). 자세한 내용은 [`packages/cli/README.md`](packages/cli/README.md)를 보세요.

`publish`는 비밀 owner 링크를 포함한 결과를 `~/.config/letsplayquiz/tests.jsonl`(`XDG_CONFIG_HOME`이 있으면 그 아래)에 제한된 권한으로 남기고 화면에도 출력합니다. owner 링크는 다시 발급받을 수 없으니 비밀로 다루고, CI 로그 노출에 주의하세요.

## MCP 서버

`letsplayquiz-mcp`는 셸 대신 MCP를 쓰는 에이전트를 위한 로컬 [MCP](https://modelcontextprotocol.io)(stdio) 서버입니다. 도구는 `get_guide`, `validate_quiz`, `publish_quiz`, `list_my_quizzes`이고, CLI와 같은 로직과 기록 파일을 씁니다.

```sh
claude mcp add letsplayquiz -- npx -y letsplayquiz-mcp
```

Claude Desktop·Cursor 설정과 `LETSPLAYQUIZ_API` 변경 방법은 [`packages/mcp/README.md`](packages/mcp/README.md)(영어)에 있습니다. `publish_quiz`는 공개 테스트를 발행하므로 에이전트가 먼저 사용자에게 확인해야 합니다.

## Claude 스킬

`skills/letsplayquiz`는 짧게 물어본 뒤 퀴즈 JSON을 쓰고, 검사하고, 확인을 받아 발행하는 [Agent Skill](https://agentskills.io)입니다.

**Claude Code** (플러그인 마켓플레이스):

```sh
claude plugin marketplace add letsplayquiz/letsplayquiz
claude plugin install letsplayquiz@letsplayquiz
```

세션 안에서는 `/plugin marketplace add letsplayquiz/letsplayquiz`, `/plugin install letsplayquiz@letsplayquiz`로도 됩니다.

**다른 에이전트** (Codex, Cursor, GitHub Copilot, Gemini CLI 등, 공개 설치 도구 [`skills`](https://www.npmjs.com/package/skills)):

```sh
npx skills add letsplayquiz/letsplayquiz
```

**Claude.ai / Claude 데스크톱 앱**: `skills/letsplayquiz` 폴더를 ZIP으로 압축해 Claude 설정에서 스킬로 업로드합니다.

그 뒤 "라면 밸런스 게임 만들어 줘"처럼 말하면 됩니다.

## API

CLI는 공개 HTTP API 위의 얇은 클라이언트입니다. 직접 호출하려면 [`docs/api.md`](docs/api.md)를 보세요.

## 기여

이슈와 풀 리퀘스트를 환영합니다. 개발에는 pnpm을 씁니다(`package.json`의 `packageManager` 참고).

```sh
pnpm install
pnpm test     # vitest
pnpm build    # 패키지 빌드
pnpm smoke    # 빌드 후 로컬 모의 서버로 빌드된 CLI 실행
```

퀴즈 규칙은 모두 서버가 갖습니다. CLI에서 규칙을 중복하거나 우회하지 마세요. 변경은 작게, 동작이 바뀌면 테스트도 더해 주세요.

## 라이선스

[MIT](LICENSE) © 2026 swewpapa
