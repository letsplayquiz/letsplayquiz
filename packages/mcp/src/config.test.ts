import { describe, it, expect } from 'vitest'
import { resolveApi } from './config.js'

describe('resolveApi', () => {
  it('기본값은 https://letsplayquiz.net', () => {
    expect(resolveApi({})).toEqual({ ok: true, api: 'https://letsplayquiz.net' })
    expect(resolveApi({ LETSPLAYQUIZ_API: '' })).toEqual({ ok: true, api: 'https://letsplayquiz.net' })
  })
  it('https와 로컬 http를 허용한다', () => {
    expect(resolveApi({ LETSPLAYQUIZ_API: 'https://example.com' }).ok).toBe(true)
    expect(resolveApi({ LETSPLAYQUIZ_API: 'http://localhost:3100' }).ok).toBe(true)
    expect(resolveApi({ LETSPLAYQUIZ_API: 'http://127.0.0.1:1234' }).ok).toBe(true)
  })
  it('평문 http 원격 주소와 URL이 아닌 값은 거부한다', () => {
    const a = resolveApi({ LETSPLAYQUIZ_API: 'http://example.com' })
    expect(a.ok).toBe(false)
    if (!a.ok) {
      expect(a.message).toContain('LETSPLAYQUIZ_API')
      expect(a.message).not.toContain('example.com')
    }
    expect(resolveApi({ LETSPLAYQUIZ_API: 'not a url' }).ok).toBe(false)
  })
  it('공백만 있는 값은 운영 서버로 폴백하지 않고 잘못된 값이다(CLI와 같다)', () => {
    expect(resolveApi({ LETSPLAYQUIZ_API: '  ' }).ok).toBe(false)
  })
  it('user:pass@가 있으면 거부하고 메시지에 원래 값을 싣지 않는다', () => {
    const r = resolveApi({ LETSPLAYQUIZ_API: 'https://user:secretpw@example.com' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).not.toContain('secretpw')
  })
})
