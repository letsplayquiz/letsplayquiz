// 라이브러리 진입점(`letsplayquiz/lib`). letsplayquiz-mcp 같은 다른 패키지가
// CLI와 똑같은 판정 로직을 재사용하게 하려고 필요한 것만 다시 내보낸다. 이
// 패키지는 런타임 의존성 0개를 유지한다.
export {
  fetchGuide,
  postJson,
  decideOutcome,
  derivePublishExitCode,
  classifyPublishNetworkFailure,
  isRecord,
  redactOwnerSecrets,
  userAgent,
  withRetryAfterField,
  PUBLISH_TIMEOUT_MS,
  type Outcome,
  type HttpResult,
  type HttpResponse,
  type HttpFailure,
} from './api.js'
export { saveRecord, loadRecords, resolveStoreFile, type TestRecord, type StoreIo, type LoadResult } from './store.js'
export { formatIssues } from './format.js'
export { DEFAULT_API, KINDS, LANGS, validateApi, type Kind, type Lang } from './args.js'
export { VERSION } from './cli.js'
