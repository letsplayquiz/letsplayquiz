# lpqz

[`letsplayquiz`](../cli/README.md) CLI의 짧은 별칭이다(Let's Play Quiz의 이니셜 + quiz의
z). 설치 없이 바로 쓴다:

```sh
npx lpqz guide --kind balance
```

이 패키지는 로직을 담지 않는다 — `bin.js` 한 줄이 `letsplayquiz`의 실제 실행 파일을
그대로 불러 실행할 뿐이다. 명령·옵션·종료 코드는 [`packages/cli/README.md`](../cli/README.md)를
그대로 따른다.
