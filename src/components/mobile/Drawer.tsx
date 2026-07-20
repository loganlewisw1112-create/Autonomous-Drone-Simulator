import { useRef, useState, type CSSProperties, type PointerEvent, type ReactNode, type TouchEvent } from 'react'

interface DrawerProps {
  side: 'left' | 'right' | 'bottom'
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  testId?: string
  /** Active surface key, surfaced as data-surface so CSS can style a specific
   *  sheet (e.g. the translucent map-visible Mission sheet) without new elements. */
  dataSurface?: string | null
}

// Slide-over panel. Transform-only animation (GPU compositing, no map reflow —
// the map never resizes when a drawer opens). Touch events are stopped at the
// drawer boundary so scrolling a list never pans the MapLibre canvas underneath.
export function Drawer({ side, open, title, onClose, children, testId, dataSurface }: DrawerProps) {
  const stopTouch = (e: TouchEvent) => e.stopPropagation()
  const drawerRef = useRef<HTMLDivElement>(null)
  const gestureRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    lastAxis: number
    lastTime: number
    locked: boolean
  } | null>(null)
  const [dragOffset, setDragOffset] = useState<number | null>(null)

  const axisValue = (event: PointerEvent) => side === 'bottom' ? event.clientY : event.clientX
  const closeDistance = (dx: number, dy: number) => {
    if (side === 'left') return Math.max(0, -dx)
    if (side === 'right') return Math.max(0, dx)
    return Math.max(0, dy)
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!open || event.pointerType === 'mouse' && event.button !== 0) return
    if ((event.target as HTMLElement).closest('button')) return
    gestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastAxis: axisValue(event),
      lastTime: event.timeStamp,
      locked: false,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const dx = event.clientX - gesture.startX
    const dy = event.clientY - gesture.startY
    const primary = side === 'bottom' ? Math.abs(dy) : Math.abs(dx)
    const cross = side === 'bottom' ? Math.abs(dx) : Math.abs(dy)
    if (!gesture.locked) {
      if (Math.max(primary, cross) < 8) return
      if (cross > primary) {
        gestureRef.current = null
        return
      }
      gesture.locked = true
    }
    event.preventDefault()
    const distance = closeDistance(dx, dy)
    setDragOffset(distance)
    gesture.lastAxis = axisValue(event)
    gesture.lastTime = event.timeStamp
  }

  function finishGesture(event: PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const dx = event.clientX - gesture.startX
    const dy = event.clientY - gesture.startY
    const distance = closeDistance(dx, dy)
    const size = side === 'bottom'
      ? drawerRef.current?.getBoundingClientRect().height ?? 1
      : drawerRef.current?.getBoundingClientRect().width ?? 1
    const elapsed = Math.max(1, event.timeStamp - gesture.lastTime)
    const finalAxisDelta = axisValue(event) - gesture.lastAxis
    const velocityTowardClose = side === 'left'
      ? -finalAxisDelta / elapsed
      : finalAxisDelta / elapsed
    gestureRef.current = null
    setDragOffset(null)
    if (gesture.locked && (distance >= size * 0.33 || (distance >= 16 && velocityTowardClose >= 0.5))) onClose()
  }

  function cancelGesture() {
    gestureRef.current = null
    setDragOffset(null)
  }

  const dragStyle: CSSProperties | undefined = dragOffset === null ? undefined : {
    transform: side === 'left'
      ? `translateX(${-dragOffset}px)`
      : side === 'right'
        ? `translateX(${dragOffset}px)`
        : `translateY(${dragOffset}px)`,
  }

  return (
    <>
      <div
        className={`mobile-drawer-scrim${open ? ' open' : ''}`}
        onClick={onClose}
        onTouchMove={stopTouch}
        data-testid={`drawer-scrim-${side}`}
      />
      <div
        ref={drawerRef}
        className={`mobile-drawer ${side}${open ? ' open' : ''}${dragOffset !== null ? ' dragging' : ''}`}
        style={{ pointerEvents: open ? 'auto' : 'none', ...dragStyle }}
        onTouchMove={stopTouch}
        role="dialog"
        aria-hidden={!open}
        {...(!open ? { inert: '' } : {})}
        data-surface={dataSurface ?? undefined}
        data-testid={testId ?? `drawer-${side}`}
      >
        <div
          className="mobile-drawer-header"
          data-testid={`drawer-handle-${side}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishGesture}
          onPointerCancel={cancelGesture}
        >
          <span className="mobile-drawer-grip" aria-hidden="true" />
          <span>{title}</span>
          <button
            className="mobile-drawer-close"
            onClick={onClose}
            aria-label={`Close ${title}`}
            disabled={!open}
            tabIndex={open ? 0 : -1}
          >
            ✕
          </button>
        </div>
        <div className="mobile-drawer-body">{children}</div>
      </div>
    </>
  )
}
