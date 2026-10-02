// 사람이 읽는 출력을 만드는 순수 함수들. 서버 계약(§4)의 blocker/warning 모양을
// 알고 있지만 fetch나 파일시스템은 건드리지 않는다 — 테스트가 문자열만 검사하면
// 되게 하기 위해서다. 서버 응답은 신뢰 경계 밖이라, 모양이 계약과 달라도(경로가
// 없거나 코드가 숫자거나) 크래시하지 않고 최대한 그려낸다.

export interface Issue {
  code: string
  message: string
  path: (string | number)[]
}

function isRecordLike(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/**
 * blocker/warning의 path를 JavaScript 식으로 그린다: `['questions', 2, 'choices', 1]`
 * → `questions[2].choices[1]`. 사람도 AI도 이 문자열을 그대로 코드 경로로 읽을 수
 * 있게 하려는 것이다(스펙 §7.2). `path`가 배열이 아니면(서버 응답이 계약과 다르면)
 * 문자열로 뭉뚱그려 보여 줄 뿐 던지지 않는다.
 */
export function formatPath(path: unknown): string {
  if (!Array.isArray(path)) return path === undefined ? '(경로 없음)' : String(path)
  return path.reduce<string>((acc, segment, index) => {
    if (typeof segment === 'number') return `${acc}[${segment}]`
    return index === 0 ? String(segment) : `${acc}.${segment}`
  }, '')
}

/** 한 줄: `경로  코드  메시지`. `issue`가 온전한 모양이 아니어도 최선을 다해 그린다. */
export function formatIssueLine(issue: unknown): string {
  const obj = isRecordLike(issue) ? issue : {}
  const path = formatPath(obj.path)
  const code = typeof obj.code === 'string' ? obj.code : '?'
  const message = typeof obj.message === 'string' ? obj.message : ''
  // tie_unresolved만 typeKeys(동점 유형의 key)를 갖는다 — 사람도 바로 옮겨 적게 보여 준다.
  const keys = Array.isArray(obj.typeKeys) && obj.typeKeys.length > 0 && obj.typeKeys.every((k) => typeof k === 'string')
    ? `  [typeKeys: ${obj.typeKeys.join(', ')}]`
    : ''
  return `${path}  ${code}  ${message}${keys}`
}

export function formatIssues(issues: unknown[]): string {
  return issues.map(formatIssueLine).join('\n')
}
