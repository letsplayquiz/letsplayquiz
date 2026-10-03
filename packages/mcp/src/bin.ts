#!/usr/bin/env node
// stdio MCP 서버 진입점. stdout은 프로토콜 전용이라 로그는 전부 stderr로 보낸다.
import { createRequire } from 'node:module'
import os from 'node:os'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { userAgent, VERSION as CLI_VERSION } from 'letsplayquiz/lib'
import { createServer } from './server.js'
import { resolveApi } from './config.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }

async function main(): Promise<void> {
  const resolved = resolveApi(process.env)
  // 잘못된 API 설정이어도 서버는 뜬다 — 네트워크 도구만 오류를 돌려주고, 로컬 기록
  // 조회(list_my_quizzes)는 계속 쓸 수 있다(CLI `list`와 같다).
  const ctx = {
    api: resolved.ok ? resolved.api : '',
    apiError: resolved.ok ? undefined : resolved.message,
    ua: `${userAgent(CLI_VERSION)} letsplayquiz-mcp/${version}`,
    store: { env: process.env, homedir: () => os.homedir() },
  }
  const server = createServer(ctx, version)
  await server.connect(new StdioServerTransport())
  if (resolved.ok) {
    process.stderr.write(`letsplayquiz-mcp ${version} ready (api: ${new URL(resolved.api).origin})\n`)
  } else {
    process.stderr.write(`letsplayquiz-mcp ${version} started, but ${resolved.message}\n`)
  }
}

main().catch((e) => {
  process.stderr.write(`letsplayquiz-mcp: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exitCode = 1
})
