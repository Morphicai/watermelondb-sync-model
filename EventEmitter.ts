/**
 * Generic event emitter base class with type-safe event handling.
 * @template TEvent - The event type (should be a union or interface)
 */
export abstract class EventEmitter<TEvent> {
    private readonly listeners = new Set<(event: TEvent) => void>();

    /**
     * Register an event listener.
     * @param handler - Event handler function that receives events
     * @returns Unsubscribe function to remove the listener
     */
    public on(handler: (event: TEvent) => void): () => void {
        this.listeners.add(handler);
        return () => this.listeners.delete(handler);
    }

    /**
     * Remove an event listener.
     * @param handler - The handler function to remove
     */
    public off(handler: (event: TEvent) => void): void {
        this.listeners.delete(handler);
    }

    /**
     * Emit an event to all registered listeners.
     * Listener errors are caught and ignored to prevent cascading failures.
     * @param event - The event to emit
     */
    protected emit(event: TEvent): void {
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch {
                // Silently catch errors to prevent one failing listener from affecting others
                // Subclasses can override this method to add custom error handling
            }
        }
    }

    /**
     * Get the current number of registered listeners.
     * @returns Number of active listeners
     */
    protected getListenerCount(): number {
        return this.listeners.size;
    }

    /**
     * Remove all event listeners.
     */
    protected clearListeners(): void {
        this.listeners.clear();
    }
}

