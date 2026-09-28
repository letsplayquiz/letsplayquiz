#!/usr/bin/env node
// npm/npx가 만드는 실행 파일(`node_modules/.bin/letsplayquiz`)은 심볼릭 링크다.
// "이 모듈이 메인 모듈인가"를 `import.meta.url === pathToFileURL(process.argv[1]).href`로
// 판정하던 예전 방식은 심볼릭 링크를 통해 실행되면 두 URL이 달라져(링크 경로 vs
// 실제 파일 경로) 거짓으로 판정되고, CLI가 아무 것도 하지 않고 조용히 exit 0으로
// 끝나 버렸다 — `npx letsplayquiz`가 실질적으로 전부 깨지는 셈이다. `package.json`의
// `bin`이 가리키는 파일은 이 파일 하나뿐이므로, 조건 없이 `main()`을 부른다.
import { main } from './cli.js'

main().catch((e) => {
  console.error(e)
  process.exitCode = 4
})
