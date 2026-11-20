import type { DrawerEvent } from "@drawer/shared/api";

type Listener = (event: DrawerEvent) => void;

export class EventBus {
  private readonly listeners = new Set<Listener>();

  emit(event: DrawerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("event listener failed:", err);
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
