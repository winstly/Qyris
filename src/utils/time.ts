const rtf = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })

/** 相对时间：将时间戳转为「刚刚」「N 分钟前」等中文描述 */
export function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return '刚刚'
  const min = Math.floor(sec / 60)
  if (min < 60) return rtf.format(-min, 'minute')
  const hr = Math.floor(min / 60)
  if (hr < 24) return rtf.format(-hr, 'hour')
  const day = Math.floor(hr / 24)
  if (day < 30) return rtf.format(-day, 'day')
  return new Date(ts).toLocaleDateString('zh-CN')
}
