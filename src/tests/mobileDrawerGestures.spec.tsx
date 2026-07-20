// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Drawer } from '@/components/mobile/Drawer'

function setDrawerSize(width: number, height: number) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON: () => ({}),
  })
}

describe('mobile drawer gestures', () => {
  it('closes a left drawer after a one-third horizontal swipe', () => {
    setDrawerSize(300, 400)
    const onClose = vi.fn()
    render(<Drawer side="left" open title="FLEET" onClose={onClose}><div>body</div></Drawer>)
    const handle = screen.getByTestId('drawer-handle-left')
    fireEvent.pointerDown(handle, { pointerId: 1, pointerType: 'touch', clientX: 180, clientY: 40 })
    fireEvent.pointerMove(handle, { pointerId: 1, pointerType: 'touch', clientX: 60, clientY: 42 })
    fireEvent.pointerUp(handle, { pointerId: 1, pointerType: 'touch', clientX: 60, clientY: 42 })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes a bottom drawer after a downward swipe', () => {
    setDrawerSize(360, 300)
    const onClose = vi.fn()
    render(<Drawer side="bottom" open title="MISSION" onClose={onClose}><div>body</div></Drawer>)
    const handle = screen.getByTestId('drawer-handle-bottom')
    fireEvent.pointerDown(handle, { pointerId: 2, pointerType: 'touch', clientX: 180, clientY: 20 })
    fireEvent.pointerMove(handle, { pointerId: 2, pointerType: 'touch', clientX: 182, clientY: 145 })
    fireEvent.pointerUp(handle, { pointerId: 2, pointerType: 'touch', clientX: 182, clientY: 145 })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('snaps back for a short drag and ignores a cross-axis scroll', () => {
    setDrawerSize(300, 400)
    const onClose = vi.fn()
    render(<Drawer side="left" open title="FLEET" onClose={onClose}><div>body</div></Drawer>)
    const handle = screen.getByTestId('drawer-handle-left')
    fireEvent.pointerDown(handle, { pointerId: 3, pointerType: 'touch', clientX: 180, clientY: 40 })
    fireEvent.pointerMove(handle, { pointerId: 3, pointerType: 'touch', clientX: 176, clientY: 70 })
    fireEvent.pointerUp(handle, { pointerId: 3, pointerType: 'touch', clientX: 176, clientY: 70 })
    expect(onClose).not.toHaveBeenCalled()
  })
})

