import { DEFAULT_API, validateApi } from 'letsplayquiz/lib'

/**
 * `LETSPLAYQUIZ_API`를 CLI와 같은 규칙(`raw || DEFAULT_API`, https 또는 로컬 http,
 * user:pass@ 금지)으로 해석한다. 공백만 있는 값은 폴백하지 않고 잘못된 값으로 본다.
 * 오류 메시지에 원래 값을 싣지 않는다(자격 증명이 로그로 새지 않게).
 */
export function resolveApi(env: NodeJS.ProcessEnv): { ok: true; api: string } | { ok: false; message: string } {
  const api = env.LETSPLAYQUIZ_API || DEFAULT_API
  if (!validateApi(api).ok) {
    return {
      ok: false,
      message:
        'invalid LETSPLAYQUIZ_API: must be a valid https URL without user:pass@ (http is allowed only for localhost, 127.0.0.1, [::1]). Fix the setting and restart the MCP server.',
    }
  }
  return { ok: true, api }
}
