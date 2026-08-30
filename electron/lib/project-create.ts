/**
 * 项目创建：空项目 / 从远端仓库克隆（支持多仓库并行克隆到同一父目录）。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { errorMessage } from './util'

/** 在 parentDir 下创建一个空的项目目录并返回其绝对路径 */
export async function createEmptyProject(parentDir: string, name: string): Promise<string> {
  if (!name.trim()) throw new Error('项目名不能为空')
  const target = path.join(parentDir, name.trim())
  try {
    await fsp.access(target)
    throw new Error(`目录已存在：${name}`)
  } catch (e: unknown) {
    // ENOENT = 不存在，可以创建；其他错误抛出
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  await fsp.mkdir(target, { recursive: true })
  return target
}

/** 在 parentDir 下克隆多个仓库，每个仓库克隆到子目录（以仓库名命名），返回所有克隆路径 */
export async function cloneRepos(parentDir: string, urls: string[]): Promise<string[]> {
  if (!urls.length) throw new Error('至少提供一个仓库地址')
  const results: string[] = []
  for (const url of urls) {
    const trimmed = url.trim()
    if (!trimmed) continue
    const repoName = guessRepoName(trimmed)
    const target = path.join(parentDir, repoName)
    await gitClone(trimmed, target)
    results.push(target)
  }
  return results
}

/** 从 git URL 猜测仓库名（去掉 .git 后缀，取最后一段） */
function guessRepoName(url: string): string {
  const last = url.split('/').pop() ?? url
  return last.replace(/\.git$/, '').replace(/[^a-zA-Z0-9._-]/g, '_') || 'repo'
}

/** 执行 git clone，超时 120s */
function gitClone(url: string, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['clone', url, target], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    })
    let stderr = ''
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`git clone 失败（exit ${code}）：${stderr.slice(0, 500)}`))
    })
    proc.on('error', (e) => reject(new Error(`git clone 启动失败：${errorMessage(e)}`)))
  })
}
