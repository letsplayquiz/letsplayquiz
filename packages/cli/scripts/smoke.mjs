#!/usr/bin/env node
// 빌드된 dist/bin.js를 실제 프로세스로 실행해 npm/npx가 만드는 심볼릭 링크
// 시나리오를 재현한다. 단위 테스트는 `run(argv, io)`를 직접 부르기 때문에
// "실행 파일 진입점이 실제로 동작하는가"는 여기서만 검증된다(SWE-19 리뷰
// 1번 항목 — 심볼릭 링크로 실행하면 아무 것도 안 하고 exit 0으로 끝나던
// 버그의 회귀 방지).
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const distBin = path.join(here, '..', 'dist', 'bin.js')

async function main() {
  const tmp = await mkdtemp(path.join(tmpdir(), 'letsplaytest-smoke-'))
  try {
    const linkPath = path.join(tmp, 'letsplaytest-link.js')
    await symlink(distBin, linkPath)

    // 1) 심볼릭 링크로 실행한 --version이 버전을 찍고 exit 0인지.
    const versionResult = await execFileAsync(process.execPath, [linkPath, '--version'])
    if (!/^\d+\.\d+\.\d+\s*$/.test(versionResult.stdout)) {
      throw new Error(`--version 출력이 이상해요: ${JSON.stringify(versionResult.stdout)}`)
    }
    console.log('OK  --version (심볼릭 링크로 실행):', versionResult.stdout.trim())

    // 2) 연결할 수 없는 서버 → exit 4 (아무 것도 안 하고 0으로 끝나던 버그의 회귀 방지).
    let failed = false
    try {
      await execFileAsync(process.execPath, [linkPath, 'guide', '--api', 'http://127.0.0.1:1'])
    } catch (e) {
      failed = true
      if (e.code !== 4) throw new Error(`연결 실패인데 종료 코드가 4가 아니에요: ${e.code}`)
    }
    if (!failed) throw new Error('연결할 수 없는 서버인데 성공(exit 0)했어요')
    console.log('OK  guide --api (연결 실패) → exit 4')

    // 3) 큰 응답을 파이프로 받아도 process.exit()에 잘리지 않는지.
    const bigBody = '#'.repeat(200_000)
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/markdown' })
      res.end(bigBody)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const port = server.address().port
      const big = await execFileAsync(
        process.execPath,
        [linkPath, 'guide', '--api', `http://127.0.0.1:${port}`],
        { maxBuffer: 10 * 1024 * 1024 },
      )
      if (big.stdout.length < bigBody.length) {
        throw new Error(`출력이 잘렸어요: ${big.stdout.length} < ${bigBody.length}`)
      }
      console.log('OK  200KB 응답이 잘리지 않고 그대로 나옴:', big.stdout.length, 'bytes')
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }

  console.log('스모크 테스트 통과')
}

main().catch((e) => {
  console.error('스모크 테스트 실패:', e.message)
  process.exitCode = 1
})
