import appIcon from '../../../build/icon.png'

/** 应用 logo（build/icon.png，与打包/窗口图标同一份）。装饰性：外层容器已 aria-hidden。 */
export function AppIcon({ className }: { className?: string }) {
  return <img className={className} src={appIcon} alt="" draggable={false} />
}
