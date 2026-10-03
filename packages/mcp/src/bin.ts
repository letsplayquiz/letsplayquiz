#!/usr/bin/env node
// stdio MCP 서버 진입점. stdout은 프로토콜 전용이라 로그는 전부 stderr로 보낸다.
import { createRequire } from 'node:module'
import os from 'node:os'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { userAgent } from 'letsplayquiz/lib'
import { createServer } from './server.js'
import { resolveApi } from './config.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }

async function main(): Promise<void> {
  const resolved = resolveApi(process.env)
  if (!resolved.ok) {
    process.stderr.write(`letsplayquiz-mcp: ${resolved.message}\n`)
    process.exitCode = 2
    return
  }
  const api = resolved.api
  const server = createServer(
    { api, ua: `${userAgent(version)} letsplayquiz-mcp/${version}`, store: { env: process.env, homedir: () => os.homedir() } },
    version,
  )
  await server.connect(new StdioServerTransport())
  process.stderr.write(`letsplayquiz-mcp ${version} ready (api: ${api})\n`)
}

main().catch((e) => {
  process.stderr.write(`letsplayquiz-mcp: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exitCode = 1
})
