/** 空状态占位：图标 + 标题 + 说明 + 可选操作按钮 */
export function EmptyState({ icon, title, text, action }: {
  icon: React.ReactNode
  title: string
  text: string
  action?: React.ReactNode
}) {
  return (
    <div className="emptystate">
      <div className="emptystate__icon">{icon}</div>
      <div className="emptystate__title">{title}</div>
      <div className="emptystate__text">{text}</div>
      {action}
    </div>
  )
}
