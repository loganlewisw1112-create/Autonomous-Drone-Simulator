import type { ReactNode, TouchEvent } from 'react'

interface DrawerProps {
  side: 'left' | 'right' | 'bottom'
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
}

// Slide-over panel. Transform-only animation (GPU compositing, no map reflow —
// the map never resizes when a drawer opens). Touch events are stopped at the
// drawer boundary so scrolling a list never pans the MapLibre canvas underneath.
export function Drawer({ side, open, title, onClose, children }: DrawerProps) {
  const stopTouch = (e: TouchEvent) => e.stopPropagation()
  return (
    <>
      <div
        className={`mobile-drawer-scrim${open ? ' open' : ''}`}
        onClick={onClose}
        onTouchMove={stopTouch}
        data-testid={`drawer-scrim-${side}`}
      />
      <div
        className={`mobile-drawer ${side}${open ? ' open' : ''}`}
        onTouchMove={stopTouch}
        role="dialog"
        aria-hidden={!open}
        data-testid={`drawer-${side}`}
      >
        <div className="mobile-drawer-header">
          <span>{title}</span>
          <button className="mobile-drawer-close" onClick={onClose} aria-label={`Close ${title}`}>✕</button>
        </div>
        <div className="mobile-drawer-body">{open && children}</div>
      </div>
    </>
  )
}
