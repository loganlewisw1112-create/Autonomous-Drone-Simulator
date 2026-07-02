import type { EventType } from '@/types'

type Handler<T> = (payload: T) => void

// Lightweight typed pub/sub — no external library needed
class EventBus {
  private listeners = new Map<string, Handler<unknown>[]>()

  on<T>(event: EventType | string, handler: Handler<T>): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, [])
    this.listeners.get(event)!.push(handler as Handler<unknown>)
    return () => this.off(event, handler)
  }

  off<T>(event: string, handler: Handler<T>): void {
    const handlers = this.listeners.get(event)
    if (!handlers) return
    const idx = handlers.indexOf(handler as Handler<unknown>)
    if (idx !== -1) handlers.splice(idx, 1)
  }

  emit<T>(event: EventType | string, payload: T): void {
    this.listeners.get(event)?.forEach((h) => h(payload))
  }

  clear(): void {
    this.listeners.clear()
  }
}

export const eventBus = new EventBus()
