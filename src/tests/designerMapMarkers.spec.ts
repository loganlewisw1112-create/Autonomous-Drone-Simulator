// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createDesignerMarkerElement } from '@/components/designer/DesignerMap'

describe('designer map markers', () => {
  it('keeps marker pointer and click events from reaching the map container', () => {
    const container = document.createElement('div')
    const marker = createDesignerMarkerElement('designer-map-site', 'S')
    const pointerDown = vi.fn()
    const pointerUp = vi.fn()
    const click = vi.fn()
    container.addEventListener('pointerdown', pointerDown)
    container.addEventListener('pointerup', pointerUp)
    container.addEventListener('click', click)
    container.append(marker)

    marker.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    marker.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    marker.click()

    expect(pointerDown).not.toHaveBeenCalled()
    expect(pointerUp).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()
  })
})
