/**
 * 持久化根目录：用户根目录 ~/.qyris/。
 * 所有持久化（配置 / 会话历史 / 文件快照 / 凭据）统一落在这里，透明可控、不随应用重装丢失。
 */
import { homedir } from 'node:os'
import path from 'node:path'

export function storageDir(): string {
  return path.join(homedir(), '.qyris')
}

