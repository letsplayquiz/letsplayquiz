# letsplaytest

AI 에이전트가 [PlayTest](https://letsplaytest.com) 테스트(점수형·유형형·밸런스·월드컵)를 만들고
발행하는 CLI입니다. 설치 없이 `npx`로 바로 씁니다.

## 시작하기

```sh
npx letsplaytest guide --kind balance
```

이 명령이 종류별 규칙과 완성된 예시 JSON을 출력합니다. AI 에이전트에게는 이렇게 시킵니다:

> `npx letsplaytest guide --kind balance`를 읽고 "짜장 vs 짬뽕" 테스트를 만들어서
> `npx letsplaytest validate test.json`을 통과시킨 뒤 `npx letsplaytest publish test.json`으로 올려 줘.

## 명령

| 명령 | 설명 |
|---|---|
| `guide [--kind score\|type\|balance\|worldcup]` | 설명서를 출력한다(생략하면 전부) |
| `validate <file \| ->` | 저장하지 않고 검사만 한다 |
| `publish <file \| ->` | 검사를 통과하면 발행한다 |
| `list` | 이 컴퓨터에서 발행한 테스트를 최근 순으로 보여 준다(서버를 부르지 않는다) |

`file` 자리에 `-`를 주면 표준 입력에서 JSON을 읽습니다(파일 없이 파이프로 넘길 때 씁니다).

## 옵션

| 옵션 | 설명 |
|---|---|
| `--json` | 서버 응답(또는 `list`의 기록)을 그대로 출력한다 |
| `--lang ko\|ja\|en` | 서버 메시지 언어(쿼리 `lang`). 지금은 항상 한국어 메시지가 온다 |
| `--api <url>` | 서버 주소. `https`만 허용한다(로컬 개발은 `http://localhost`, `http://127.0.0.1` 예외 — 그 밖의 `http`는 대시보드 링크가 평문으로 오갈 수 있어 거절한다). 환경변수 `LETSPLAYTEST_API`로도 설정한다(플래그가 우선). 기본값 `https://letsplaytest.com` |
| `--no-save` | `publish` 결과를 기록 파일에 남기지 않는다 |
| `--help` | 도움말 출력 |
| `--version` | 버전 출력 |

## 종료 코드

| 코드 | 의미 | 다음 행동 |
|---|---|---|
| 0 | 성공(경고만 있어도) | 다음 단계 |
| 1 | 검사 실패(`validation_failed`) | 고쳐서 다시 |
| 2 | 사용법 오류, 파일 없음, 로컬 JSON 파싱 실패 | 명령을 고침 |
| 3 | 요청 제한(`rate_limited`) | 표시된 시간만큼 기다림 |
| 4 | 네트워크·서버 오류(발행 안 됨이 확실함) | 나중에 다시 |
| 5 | `publish` 결과 불명 — 발행됐을 수도, 안 됐을 수도 있음 | 곧장 재시도하지 말고 사용자에게 확인 |

1과 0은 HTTP 상태가 아니라 응답 본문의 `ok`로 갈립니다 — `validate`는 실패해도 200을 냅니다.
`validate`·`publish`는 서버가 항상 `{ ok: boolean, ... }`을 낸다고 계약돼 있어서, 응답이
JSON이 아니거나 `ok` 필드가 없으면(프록시 오류 페이지 등) 성공으로 잘못 읽지 않고 4로
처리합니다. `guide --json`도 마찬가지로, 응답이 JSON이 아니면(서버가 `?format=json`을
무시한 경우 등) 4로 처리합니다.

`validate`·`guide`는 30초 안에 응답이 없으면 4입니다(연결은 됐지만 느린 경우 포함).
**`publish`만 다릅니다:** 타임아웃이 60초로 더 길고, "확실히 발행 안 됨"(4)과 "발행됐을
수 있음"(5, 결과 불명)을 실제 저수준 오류로 가릅니다.

| 상황 | 종료 코드 |
|---|---|
| DNS 실패, 접속 거부(`ECONNREFUSED`), TLS 인증서 오류(만료·자체 서명·발급자 확인 불가 등)·핸드셰이크 첫 바이트 오류(`ERR_SSL_WRONG_VERSION_NUMBER` 등)·금지 포트처럼 요청이 정말 나가지 못함 | 4 |
| 60초 타임아웃(연결 이후 어느 시점이든) | 5 |
| 연결은 됐는데 응답 중간에 끊김(`ECONNRESET` 등) | 5 |
| `ok: true`인데 `slug`/`url`/`ownerUrl`이 없음 | 5 |
| 서버가 JSON도, 계약된 모양도 아닌 응답을 주는데 상태가 2xx 또는 5xx | 5 |
| 서버가 4xx로 JSON 오류를 계약대로 알림(코드와 무관, `validation_failed`/`rate_limited` 제외) — 요청을 거절했다는 뜻이라 저장까지 갔을 여지가 없음 | 4 |
| 서버가 5xx로 아는 오류(`internal`·`unavailable`·`invalid_json`·`payload_too_large`·`unsupported_media_type`)를 계약대로 알림 | 4 |
| 서버가 5xx로 "결과 불명"이라고 스스로 알림(`error.code: "publish_unknown"`)이거나 모르는 새 오류 코드 | 5(안전한 쪽으로) |

5를 받으면 같은 내용으로 곧장 다시 `publish`하지 말고, 사용자에게 확인을 구하세요.
`--json`이면 `{"ok":false,"error":{"code":"publish_unknown","message":"..."}}`에
서버 원문 응답이 있으면 `raw` 필드로 같이 실어서, 사람이 그 안에서 직접 링크를
찾아볼 수 있게 합니다.

## 대시보드 링크는 어디에 저장되나

`publish`가 성공하면 `~/.config/letsplaytest/tests.jsonl`(`XDG_CONFIG_HOME`이 있으면 그
아래)에 한 줄짜리 JSON(JSONL)으로 이어 붙입니다: `slug`, `title`, `kind`, `url`,
`ownerUrl`, `api`, `publishedAt`. 이 파일과
디렉터리는 각각 권한 `600`/`700`으로 만들어 같은 컴퓨터의 다른 사용자가 읽지 못하게
합니다. 락 파일 없이 매번 파일 끝에 한 줄을 덧붙이기만 해서, 동시에 여러 번 발행해도
기록이 서로 덮어써지지 않습니다(일반 파일에 대한 `O_APPEND` 원자성은 로컬
파일시스템의 구현이 보장합니다 — Linux ext4의 inode 잠금, macOS APFS,
Windows `FILE_APPEND_DATA` 등. NFS 같은 네트워크 파일시스템은 이 보장이 없지만
이 CLI는 로컬 홈 디렉터리만 씁니다).

`ownerUrl`(대시보드 링크)은 로그인 없는 PlayTest에서 창작자임을 증명하는 **유일한 수단**이라
다시 발급받을 수 없습니다. `publish`는 성공 시 이 링크를 화면에도 출력합니다 — 만든 사람과
그 사람의 AI 에이전트가 바로 받아 써야 하기 때문입니다. **CI 로그나 공유 터미널 세션에
찍히면 남에게 보일 수 있으니, CI에서 자동 발행할 때는 로그 노출에 주의하세요.**

## 예시

```sh
npx letsplaytest guide --kind type --json > guide.json
# ... AI가 guide.json을 읽고 test.json을 작성 ...
npx letsplaytest validate test.json
npx letsplaytest publish test.json
npx letsplaytest list
```
