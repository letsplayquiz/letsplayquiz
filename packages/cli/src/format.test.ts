import { describe, it, expect } from 'vitest'
import { formatPath, formatIssueLine, formatIssues } from './format.js'

describe('formatPath', () => {
  it('문자열과 숫자 인덱스를 JS 식으로 그린다', () => {
    expect(formatPath(['questions', 2, 'choices', 1])).toBe('questions[2].choices[1]')
  })

  it('빈 배열은 빈 문자열', () => {
    expect(formatPath([])).toBe('')
  })

  it('한 글자짜리 경로', () => {
    expect(formatPath(['title'])).toBe('title')
  })

  it('숫자로 시작해도 던지지 않는다', () => {
    expect(formatPath([0, 'a'])).toBe('[0].a')
  })

  it('배열이 아니면(계약과 다른 응답) 문자열로 뭉뚱그린다', () => {
    expect(formatPath('questions')).toBe('questions')
    expect(formatPath(42)).toBe('42')
    expect(formatPath(null)).toBe('null')
  })

  it('undefined면 안내 문자열', () => {
    expect(formatPath(undefined)).toBe('(경로 없음)')
  })
})

describe('formatIssueLine typeKeys', () => {
  it('typeKeys가 문자열 배열이면 줄 끝에 붙인다', () => {
    expect(formatIssueLine({ code: 'tie_unresolved', message: 'm', path: ['tieResults'], typeKeys: ['a', 'b'] })).toBe('tieResults  tie_unresolved  m  [typeKeys: a, b]')
  })
  it('없거나 모양이 틀리면 붙이지 않는다', () => {
    expect(formatIssueLine({ code: 'x', message: 'm', path: ['a'], typeKeys: 'a' })).toBe('a  x  m')
    expect(formatIssueLine({ code: 'x', message: 'm', path: ['a'], typeKeys: [] })).toBe('a  x  m')
  })
})

describe('formatIssueLine', () => {
  it('정상 모양은 경로  코드  메시지', () => {
    const line = formatIssueLine({ code: 'choice_no_weight', message: '가중치를 넣어 주세요', path: ['questions', 2] })
    expect(line).toBe('questions[2]  choice_no_weight  가중치를 넣어 주세요')
  })

  it('issue가 객체가 아니어도 던지지 않는다', () => {
    expect(() => formatIssueLine('not an object')).not.toThrow()
    expect(() => formatIssueLine(null)).not.toThrow()
    expect(() => formatIssueLine(42)).not.toThrow()
    expect(() => formatIssueLine(undefined)).not.toThrow()
  })

  it('code가 없으면 ?로, message가 없으면 빈 문자열로 그린다', () => {
    expect(formatIssueLine({})).toBe('(경로 없음)  ?  ')
  })

  it('code가 문자열이 아니어도 크래시하지 않는다', () => {
    expect(() => formatIssueLine({ code: 123, message: 'm', path: ['a'] })).not.toThrow()
    expect(formatIssueLine({ code: 123, message: 'm', path: ['a'] })).toBe('a  ?  m')
  })

  it('path가 문자열이 아닌 세그먼트를 담고 있어도 그려낸다', () => {
    expect(formatIssueLine({ code: 'x', message: 'm', path: [null, undefined, {}] })).toContain('x  m')
  })
})

describe('formatIssues', () => {
  it('여러 줄을 개행으로 잇는다', () => {
    const issues = [
      { code: 'a', message: 'A', path: ['x'] },
      { code: 'b', message: 'B', path: ['y'] },
    ]
    expect(formatIssues(issues)).toBe('x  a  A\ny  b  B')
  })

  it('빈 배열은 빈 문자열', () => {
    expect(formatIssues([])).toBe('')
  })

  it('배열 요소가 죄다 이상해도 던지지 않는다', () => {
    expect(() => formatIssues([null, 1, 'x', undefined, []])).not.toThrow()
  })
})
