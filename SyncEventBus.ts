import type { Logger } from './types';
import { noopLogger } from './types';

export interface SyncEventMap {
    'sync:remote-change': { table: string; payload?: unknown };
    'sync:request': { reason?: string };
}

export type SyncEventType = keyof SyncEventMap;
export type SyncEventData<T extends SyncEventType> = SyncEventMap[T];
export type SyncEventListener<T extends SyncEventType> = (data: SyncEventData<T>) => void;

export class SyncEventBus {
    private listeners = new Map<SyncEventType, Set<SyncEventListener<any>>>();
    private logger: Logger;

    constructor(logger?: Logger) {
        this.logger = logger || noopLogger;
    }

    on<T extends SyncEventType>(eventType: T, listener: SyncEventListener<T>): () => void {
        const set = this.listeners.get(eventType) || new Set();
        set.add(listener as any);
        this.listeners.set(eventType, set);
        return () => this.off(eventType, listener);
    }

    off<T extends SyncEventType>(eventType: T, listener: SyncEventListener<T>): void {
        const set = this.listeners.get(eventType);
        if (!set) return;
        set.delete(listener as any);
        if (set.size === 0) this.listeners.delete(eventType);
    }

    emit<T extends SyncEventType>(eventType: T, data: SyncEventData<T>): void {
        try {
            const set = this.listeners.get(eventType);
            if (!set) return;
            for (const listener of Array.from(set)) {
                try {
                    (listener as any)(data);
                } catch (err) {
                    this.logger.error('[sync][bus] listener error', { eventType, err });
                }
            }
        } catch (err) {
            this.logger.error('[sync][bus] emit error', { eventType, err });
        }
    }
}


