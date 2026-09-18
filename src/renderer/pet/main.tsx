/**
 * 桌宠窗口渲染入口：MP4 视频动画角色 + 左键开面板 + 右键菜单 + 拖拽移动。
 * 状态由主进程通过 pet:state 事件推送，四种动画：idle(slackoff) / working / waiting / error。
 * 声音可通过设置中的 petSound 开关控制（默认静音）。
 */
import { StrictMode, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AppConfig } from '@/types'
import './pet.css'

type PetState = 'idle' | 'working' | 'waiting' | 'error'

/** 状态 → MP4 文件名 */
const STATE_VIDEO: Record<PetState, string> = {
  idle: 'slackoff.mp4',
  working: 'working.mp4',
  waiting: 'slackoff.mp4',
  error: 'error.mp4',
}

function Pet() {
  const [state, setState] = useState<PetState>('idle')
  const [muted, setMuted] = useState(true)
  const [videoUrls, setVideoUrls] = useState<Record<string, string>>({})
  const videoRef = useRef<HTMLVideoElement>(null)
  const dragRef = useRef({ dragging: false, startX: 0, startY: 0 })

  // 监听主进程推送的状态
  useEffect(() => {
    const off = window.desktopAPI?.onPetState?.((s) => setState(s as PetState))
    window.desktopAPI?.requestPetState?.()
    return () => { off?.() }
  }, [])

  // 预解析视频 URL（dev 走 Vite dev server，打包后走 file:// + asarUnpack）
  useEffect(() => {
    const resolve = async () => {
      const urls: Record<string, string> = {}
      for (const f of new Set(Object.values(STATE_VIDEO))) {
        try { urls[f] = await window.desktopAPI?.resolveVideoUrl?.(f) ?? f } catch { urls[f] = f }
      }
      setVideoUrls(urls)
    }
    void resolve()
  }, [])

  // 读取 petSound 配置 + 监听变更
  useEffect(() => {
    window.desktopAPI?.getConfig?.().then((cfg: AppConfig) => {
      setMuted(!cfg.petSound)
    }).catch(() => {})
    const off = window.desktopAPI?.onConfigChanged?.((keys) => {
      if (keys.includes('petSound')) {
        window.desktopAPI?.getConfig?.().then((cfg: AppConfig) => {
          setMuted(!cfg.petSound)
        }).catch(() => {})
      }
    })
    return () => { off?.() }
  }, [])

  /** imperative play：比 autoPlay 声明式属性更可靠，key 变更重挂载后仍保证播放 */
  const startPlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    v.play().catch(() => {
      // 某些极端时序下 loadeddata 前 play() 被拒，loadeddata handler 会兜底
    })
  }, [])

  // 状态切换时强制播放新视频（key 变更 → 重挂载 → ref 更新 → 触发 play）
  useEffect(() => {
    startPlay()
  }, [state, startPlay])

  // muted 变更时也要确保视频继续播放（仅改属性不会自动恢复）
  useEffect(() => {
    startPlay()
  }, [muted, startPlay])

  // 左键：开/关面板
  const handleClick = (e: React.MouseEvent) => {
    if (dragRef.current.dragging) return
    e.preventDefault()
    window.desktopAPI?.togglePetPanel?.()
  }

  // 右键：原生菜单（打开工作台 / 退出应用），由主进程 popup
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    window.desktopAPI?.petContextMenu?.()
  }

  // 拖拽：通过 IPC 通知主进程移动窗口（渲染层无法直接移动 BrowserWindow）
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    dragRef.current = { dragging: false, startX: e.screenX, startY: e.screenY }
    const onMove = (ev: MouseEvent) => {
      const dx = ev.screenX - dragRef.current.startX
      const dy = ev.screenY - dragRef.current.startY
      if (Math.abs(dx) + Math.abs(dy) > 4) {
        dragRef.current.dragging = true
        window.desktopAPI?.petMoveBy?.(dx, dy)
        dragRef.current.startX = ev.screenX
        dragRef.current.startY = ev.screenY
      }
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      // 延迟重置，避免 click 事件误判
      setTimeout(() => { dragRef.current.dragging = false }, 50)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const videoName = STATE_VIDEO[state]
  const videoSrc = videoUrls[videoName] ?? videoName

  return (
    <div
      className={`pet pet--${state}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onMouseDown={handleMouseDown}
      title={state === 'idle' ? '待命' : state === 'working' ? '执行中…' : state === 'error' ? '异常' : '等待确认'}
    >
      <video
        ref={videoRef}
        className="pet__video"
        src={videoSrc}
        loop
        muted={muted}
        playsInline
        disablePictureInPicture
        key={videoName}
        onLoadedData={startPlay}
      />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><Pet /></StrictMode>,
)