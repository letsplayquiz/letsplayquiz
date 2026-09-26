// 사람이 읽는 출력을 만드는 순수 함수들. 서버 계약(§4)의 blocker/warning 모양을
// 알고 있지만 fetch나 파일시스템은 건드리지 않는다 — 테스트가 문자열만 검사하면
// 되게 하기 위해서다.

export interface Issue {
  code: string
  message: string
  path: (string | number)[]
}

/**
 * blocker/warning의 path를 JavaScript 식으로 그린다: `['questions', 2, 'choices', 1]`
 * → `questions[2].choices[1]`. 사람도 AI도 이 문자열을 그대로 코드 경로로 읽을 수
 * 있게 하려는 것이다(스펙 §7.2).
 */
export function formatPath(path: (string | number)[]): string {
  return path.reduce<string>((acc, segment, index) => {
    if (typeof segment === 'number') return `${acc}[${segment}]`
    return index === 0 ? String(segment) : `${acc}.${segment}`
  }, '')
}

/** 한 줄: `경로  코드  메시지`. */
export function formatIssueLine(issue: Issue): string {
  return `${formatPath(issue.path)}  ${issue.code}  ${issue.message}`
}

export function formatIssues(issues: Issue[]): string {
  return issues.map(formatIssueLine).join('\n')
}
