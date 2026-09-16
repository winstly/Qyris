/**
 * 最小统一 diff：行级 LCS 对比，输出 unified diff 文本（复用 .files-diff__line 渲染着色）。
 * 无第三方依赖；超出行数上限时返回占位说明（快照预览场景宁可降级不卡主进程）。
 */

const MAX_DIFF_LINES = 2000

interface Op {
  type: 'same' | 'del' | 'add'
  text: string
}

/** LCS 回溯生成编辑脚本（O(m·n) 内存，行数受 MAX_DIFF_LINES 约束） */
function editScript(a: string[], b: string[]): Op[] {
  const m = a.length
  const n = b.length
  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度
  const dp = new Int32Array((m + 1) * (n + 1))
  const at = (i: number, j: number): number => i * (n + 1) + j
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[at(i, j)] = a[i] === b[j] ? dp[at(i + 1, j + 1)] + 1 : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)])
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ type: 'same', text: a[i] })
      i++; j++
    } else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) {
      ops.push({ type: 'del', text: a[i] })
      i++
    } else {
      ops.push({ type: 'add', text: b[j] })
      j++
    }
  }
  while (i < m) ops.push({ type: 'del', text: a[i++] })
  while (j < n) ops.push({ type: 'add', text: b[j++] })
  return ops
}

/** 生成 unified diff 文本（带 @@ hunk 头与上下文行）；无差异返回空串 */
export function unifiedDiff(oldText: string, newText: string, context = 3): string {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  if (oldText === newText) return ''
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return `（文件超过 ${MAX_DIFF_LINES} 行，跳过逐行对比）\n旧 ${a.length} 行 → 新 ${b.length} 行`
  }
  const ops = editScript(a, b)

  // 变更簇 ±context 合并成 hunk
  const changed = ops.map((o) => o.type !== 'same')
  const hunks: Array<{ start: number; end: number }> = []
  let i = 0
  while (i < ops.length) {
    if (!changed[i]) { i++; continue }
    const start = Math.max(0, i - context)
    let end = i
    // 找到下一个变更（间隔 > 2*context 则切断）
    let j = i
    let gap = 0
    while (j < ops.length && gap <= context * 2) {
      if (changed[j]) { end = j; gap = 0 } else { gap++ }
      j++
    }
    hunks.push({ start, end: Math.min(ops.length, end + context + 1) })
    i = j
  }

  const out: string[] = []
  for (const h of hunks) {
    const slice = ops.slice(h.start, h.end)
    const oldCount = slice.filter((o) => o.type !== 'add').length
    const newCount = slice.filter((o) => o.type !== 'del').length
    // hunk 起始行号：切片前各侧已有的行数
    let oStart = 1
    let nStart = 1
    for (let k = 0; k < h.start; k++) {
      if (ops[k].type !== 'add') oStart++
      if (ops[k].type !== 'del') nStart++
    }
    out.push(`@@ -${oStart},${oldCount} +${nStart},${newCount} @@`)
    for (const o of slice) {
      out.push((o.type === 'same' ? ' ' : o.type === 'del' ? '-' : '+') + o.text)
    }
  }
  return out.join('\n')
}
