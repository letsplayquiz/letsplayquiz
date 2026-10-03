import { DEFAULT_API, validateApi } from 'letsplayquiz/lib'

/** `LETSPLAYQUIZ_API`(없으면 기본 주소)를 CLI와 같은 https/localhost 규칙으로 검증한다. */
export function resolveApi(env: NodeJS.ProcessEnv): { ok: true; api: string } | { ok: false; message: string } {
  const raw = env.LETSPLAYQUIZ_API
  const api = raw && raw.trim() !== '' ? raw : DEFAULT_API
  if (!validateApi(api).ok) {
    return {
      ok: false,
      message: `invalid LETSPLAYQUIZ_API (${api}): must be a valid https URL (http is allowed only for localhost, 127.0.0.1, [::1])`,
    }
  }
  return { ok: true, api }
}
