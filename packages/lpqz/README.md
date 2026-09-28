# lpqz

[`letsplayquiz`](../cli/README.md) CLI의 짧은 별칭이다(Let's Play Quiz의 이니셜 + quiz의
z). 설치 없이 바로 쓴다:

```sh
npx lpqz guide --kind balance
```

이 패키지는 로직을 담지 않는다 — `bin.js` 한 줄이 `letsplayquiz`의 실제 실행 파일을
그대로 불러 실행할 뿐이다. 명령·옵션·종료 코드는 [`packages/cli/README.md`](../cli/README.md)를
그대로 따른다.

## 전역 설치

두 패키지는 서로 다른 명령 이름을 등록한다 — 같은 이름을 두 패키지가 선언하면
전역 설치 시 `EEXIST`로 충돌하기 때문이다.

| 설치 | 실행 명령 |
|---|---|
| `npm i -g letsplayquiz` | `letsplayquiz` |
| `npm i -g lpqz` | `lpqz` |

## 이 패키지를 게시할 때

**`letsplayquiz`를 먼저 게시하고, `lpqz`는 그 다음에 게시한다.** `bin.js`가
`letsplayquiz/dist/bin.js`를 그 자리에서 불러오므로, 반대 순서로 게시하면 그 사이
`npx lpqz`가 아직 없는 버전의 `letsplayquiz`를 찾다가 `ETARGET`으로 실패한다.
