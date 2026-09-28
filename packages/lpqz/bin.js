#!/usr/bin/env node
// lpqz는 letsplayquiz CLI의 짧은 별칭이다(스펙 §7.3). 빌드하지 않고 저장소에
// 그대로 커밋하는 몇 줄짜리 JS로, 본 패키지의 실제 진입점을 그대로 불러
// 실행한다. `require.resolve`는 경로만 확인할 뿐 실행하지 않으니 쓰지
// 않는다 — 본 CLI는 ESM이고, 진입점 모듈이 로드되는 순간 `main()`을 부른다
// (packages/cli/src/bin.ts 참고). 그래서 `await import(...)` 한 줄이면 된다.
await import('letsplayquiz/dist/bin.js')
