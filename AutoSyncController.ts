import { Database } from '@nozbe/watermelondb';
import type { Logger } from './types';

/**
 * Controller for auto-sync functionality
 * Observes local database changes and triggers sync with debouncing
 */
export class AutoSyncController {
    private subscription?: { unsubscribe: () => void } | null;
    private debounceTimer: any;

    constructor(
        private readonly debounceMs: number,
        private readonly logger: Logger
    ) {}

    /**
     * Subscribe to local database changes
     */
    subscribe(opts: {
        database: Database;
        tables: string[];
        onTrigger: (changes?: any) => void;
        onError?: (err: unknown) => void;
    }): void {
        this.unsubscribe();
        if (opts.tables.length === 0) return;
        try {
            this.logger.debug('[sync][auto] subscribe', { tables: opts.tables });
            const observable = (opts.database as any).withChangesForTables(
                opts.tables
            );
            if (!observable || typeof observable.subscribe !== 'function')
                return;
            this.subscription = observable.subscribe({
                next: (changes: any) => this.trigger(opts.onTrigger, changes),
                error: (err: unknown) => opts.onError?.(err),
                complete: () => {},
            });
        } catch (err) {
            opts.onError?.(err);
        }
    }

    /**
     * Unsubscribe from local database changes
     */
    unsubscribe(): void {
        if (
            this.subscription &&
            typeof this.subscription.unsubscribe === 'function'
        ) {
            try {
                this.subscription.unsubscribe();
            } catch {}
        }
        this.subscription = null;
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
    }

    /**
     * Trigger callback with debouncing
     */
    trigger(onTrigger: (changes?: any) => void, changes?: any): void {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            try {
                onTrigger(changes);
            } catch {}
        }, this.debounceMs);
    }
}
