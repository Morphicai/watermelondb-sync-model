import { Database } from '@nozbe/watermelondb';
import { synchronize } from '@nozbe/watermelondb/sync';
import type {
    ManagerState,
    SyncContext,
    SyncEvent,
    SyncModelCtor,
} from './SyncModel';
import type { TableChanges, SyncAdapter, RemoteSubscription } from './adapters/SyncAdapter';
import type { Logger, TimeProvider } from './types';
import { noopLogger, localTimeProvider } from './types';
import { logRemoteToLocalResult } from './utils/logging';
import { AutoSyncController } from './AutoSyncController';
import { checkAndDecrement } from './SuppressionCounter';
import { EventEmitter } from './EventEmitter';

type ChangesPayload = {
    [table: string]: {
        created: any[];
        updated: any[];
        deleted: string[];
    };
};

interface InternalModelEntry {
    ctor: SyncModelCtor<any>;
    label: string;
}

interface SyncCycleMeta {
    lastPulledAt?: number | null;
    pullStartedAt?: number;
}

/**
 * Deferred promise with exposed resolve and reject functions.
 */
type Deferred<T = void> = {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
};

/**
 * Data synchronization manager that coordinates bidirectional sync between local WatermelonDB and remote data sources.
 * Supports auto-sync with debouncing and compensation cycles to ensure data consistency.
 */
export class DataSyncManager extends EventEmitter<SyncEvent> {
    // ==================== Constants ====================
    private static readonly DEFAULT_DEBOUNCE_MS = 3000;
    private static readonly GLOBAL_LABEL = 'all';

    // ==================== Instance Properties ====================
    private readonly database: Database;
    private readonly models: InternalModelEntry[] = [];
    private readonly debounceMs: number;
    private readonly autoSync: AutoSyncController;
    private readonly logger: Logger;
    private readonly timeProvider: TimeProvider;
    
    private running = false;
    private inProgress: string[] = [];
    private lastSyncAt?: number;
    private errors = 0;
    private isSyncing = false;
    private hasPendingChange = false;
    private defaultCtx?: SyncContext;
    private waiters: Deferred[] = [];
    
    // Remote subscription management
    private remoteSubscriptions: Map<string, RemoteSubscription> = new Map();
    private remoteSubscriptionEnabled = false;

    /**
     * Create a DataSyncManager instance.
     * @param database - WatermelonDB database instance
     * @param models - Array of sync model constructors to register (cannot be changed after initialization)
     * @param options - Optional configuration
     * @param options.debounceMs - Debounce time in milliseconds for auto-sync (default: 3000)
     * @param options.logger - Logger instance for debugging (default: noopLogger)
     * @param options.timeProvider - Server time provider for sync timestamp (default: localTimeProvider)
     */
    constructor(
        database: Database,
        models: SyncModelCtor<any>[],
        options?: { 
            debounceMs?: number;
            logger?: Logger;
            timeProvider?: TimeProvider;
        }
    ) {
        super();
        this.database = database;
        this.debounceMs = options?.debounceMs ?? DataSyncManager.DEFAULT_DEBOUNCE_MS;
        this.logger = options?.logger || noopLogger;
        this.timeProvider = options?.timeProvider || localTimeProvider;
        this.autoSync = new AutoSyncController(this.debounceMs, this.logger);
        
        // Register all models during initialization
        for (const ModelCtor of models) {
            const label = ModelCtor.label || ModelCtor.table;
            this.models.push({ ctor: ModelCtor, label });
        }
    }

    /**
     * @deprecated Models should be registered in the constructor.
     * Dynamic registration is not supported.
     * @param ModelCtor - The model constructor implementing SyncModelCtor interface
     */
    registerModel(ModelCtor: SyncModelCtor<any>): void {
        throw new Error(
            'Dynamic model registration is not supported. ' +
            'Please pass all models to the DataSyncManager constructor.'
        );
    }

    /**
     * Get the current state of the sync manager.
     * @returns Current manager state including running status, progress, and error count
     */
    getState(): ManagerState {
        return {
            running: this.running,
            inProgress: [...this.inProgress],
            lastSyncAt: this.lastSyncAt,
            queueSize: this.models.length,
            errors: this.errors,
        };
    }

    /**
     * Start the sync manager and optionally enable auto-sync.
     * Performs an initial sync before enabling observers to avoid immediate loop.
     * Note: This does not automatically start remote subscriptions.
     * Call startRemoteSubscriptions() manually if needed.
     * @param ctx - Sync context containing user ID and other metadata
     * @param options - Configuration options
     * @param options.auto - Enable auto-sync based on local database changes
     * @returns Promise that resolves when initial sync completes
     */
    async start(
        ctx?: SyncContext,
        options?: { auto?: boolean }
    ): Promise<void> {
        const enableAuto = options?.auto === true;
        this.defaultCtx = ctx;
        
        // First do an initial sync before enabling observers to avoid immediate loop
        await this.syncNow(ctx);
        
        if (enableAuto) {
            this.startAutoSyncListener();
        } else {
            this.running = false;
        }
    }

    /**
     * Stop the sync manager and disable all listeners.
     * This will stop both auto-sync and remote subscriptions.
     */
    stop(): void {
        this.stopAutoSyncListener();
        this.stopRemoteSubscriptions();
    }

    /**
     * Trigger a synchronization cycle immediately.
     * Prevents concurrent syncs and queues follow-up if requested during an active sync.
     * @param ctx - Sync context containing user ID and other metadata
     * @returns Promise that resolves when sync and all compensation cycles complete
     */
    async syncNow(ctx?: SyncContext): Promise<void> {
        // Always enqueue a waiter for completion after sync + compensation

        const waiter = createDeferred();
        this.waiters.push(waiter);
        // prevent concurrent syncs; queue a follow-up if one is asked meanwhile
        if (this.isSyncing) {
            this.hasPendingChange = true;
            return waiter.promise;
        }
        const models = this.models;

        if (models.length === 0) {
            this.flushWaiters();
            return waiter.promise;
        }

        // Kick off sync loop
        this.runSyncLoop(models, ctx).catch(() => {
            // Error already recorded in runSyncLoop
        });
        return waiter.promise;
    }

    /**
     * Execute the main sync loop with compensation cycles.
     * Runs initial and compensation cycles until stable (no pending changes).
     * @param models - List of registered sync models
     * @param ctx - Sync context containing user ID and other metadata
     */
    private async runSyncLoop(
        models: InternalModelEntry[],
        ctx?: SyncContext
    ): Promise<void> {
        if (this.isSyncing) return;
        this.isSyncing = true;
        let lastError: unknown = null;
        
        try {
            // Run initial and compensation cycles until stable
            // eslint-disable-next-line no-constant-condition
            while (true) {
                await this.runSingleSyncCycle(models, ctx);
                this.finishCycle();
                
                if (!this.hasPendingChange) {
                    break; // No more compensation needed
                }
            }
        } catch (err) {
            lastError = err;
            this.recordError(DataSyncManager.GLOBAL_LABEL, err, 'DataSyncManager.sync error');
        } finally {
            this.isSyncing = false;
            this.flushWaiters(lastError);
        }
    }

    /**
     * Execute a single synchronization cycle (pull + push).
     * @param models - List of registered sync models
     * @param ctx - Sync context containing user ID and other metadata
     */
    private async runSingleSyncCycle(
        models: InternalModelEntry[],
        ctx?: SyncContext
    ): Promise<void> {
        const cycleMeta: SyncCycleMeta = {};
        this.hasPendingChange = false;
        
        await synchronize({
            database: this.database,
            pullChanges: async ({ lastPulledAt }) => {
                return await this.runPullPhase({
                    models,
                    ctx,
                    lastPulledAt: lastPulledAt ?? null,
                    meta: cycleMeta,
                });
            },
            pushChanges: async ({ changes }) => {
                return await this.runPushPhase({
                    models,
                    ctx,
                    changes: changes as ChangesPayload,
                });
            },
        });
    }

    /**
     * Resolve or reject all pending sync waiters.
     * @param error - Optional error to reject waiters with; if undefined, waiters are resolved
     */
    private flushWaiters(error?: unknown): void {
        const waiters = this.waiters;
        this.waiters = [];
        for (const waiter of waiters) {
            try {
                if (error) {
                    waiter.reject(error);
                } else {
                    waiter.resolve();
                }
            } catch {
                // ignore errors in waiter resolution
            }
        }
    }

    /**
     * Execute the pull phase of synchronization.
     * Fetches remote changes for all registered models since the last pull.
     * @param params - Pull phase parameters
     * @param params.models - List of registered sync models
     * @param params.ctx - Sync context containing user ID and other metadata
     * @param params.lastPulledAt - Timestamp of last successful pull
     * @param params.meta - Metadata for the current sync cycle
     * @returns Changes payload and server timestamp
     */
    private async runPullPhase({
        models,
        ctx,
        lastPulledAt,
        meta,
    }: {
        models: InternalModelEntry[];
        ctx?: SyncContext;
        lastPulledAt: number | null;
        meta: SyncCycleMeta;
    }): Promise<{ changes: ChangesPayload; timestamp: number }> {
        const pullStartedAt = await this.fetchServerTime();
        meta.pullStartedAt = pullStartedAt;
        meta.lastPulledAt = lastPulledAt;

        const changes: ChangesPayload = {};
        for (const { ctor, label } of models) {
            await this.executeModelSync(
                label,
                async () => {
                    const adapter = this.getAdapterForModel(ctor, ctx);
                    const modelChanges = await adapter.pull(lastPulledAt, ctx);
                    logRemoteToLocalResult(this.logger, label, modelChanges, lastPulledAt);
                    changes[ctor.table] = modelChanges;
                    this.emit({ type: 'pulled', label, detail: modelChanges });
                },
                'pullForModel error'
            );
        }

        return { changes, timestamp: pullStartedAt };
    }

    /**
     * Execute the push phase of synchronization.
     * Pushes local changes for all registered models to the remote.
     * Temporarily pauses remote subscription for each model during its push to avoid self-triggered sync.
     * @param params - Push phase parameters
     * @param params.models - List of registered sync models
     * @param params.ctx - Sync context containing user ID and other metadata
     * @param params.changes - Local changes to push to remote
     */
    private async runPushPhase({
        models,
        ctx,
        changes,
    }: {
        models: InternalModelEntry[];
        ctx?: SyncContext;
        changes: ChangesPayload;
    }): Promise<void> {
        for (const { ctor, label } of models) {
            const tableChanges = changes[ctor.table] as TableChanges<any>;
            if (!tableChanges) continue;
            
            // Check if there are actual changes to push
            const hasChanges = 
                tableChanges.created.length > 0 ||
                tableChanges.updated.length > 0 ||
                tableChanges.deleted.length > 0;
            
            if (!hasChanges) continue;
            
            // Pause only this model's subscription before pushing
            const wasSubscribed = this.remoteSubscriptions.has(label);
            if (wasSubscribed && this.remoteSubscriptionEnabled) {
                this.unsubscribeFromModel(label);
            }
            
            try {
                await this.executeModelSync(
                    label,
                    async () => {
                        const adapter = this.getAdapterForModel(ctor, ctx);
                        await adapter.push(tableChanges, ctx);
                        this.emit({ type: 'pushed', label, detail: tableChanges });
                    },
                    'pushForModel error'
                );
            } finally {
                // Resume this model's subscription immediately after push completes
                if (wasSubscribed && this.remoteSubscriptionEnabled) {
                    this.subscribeToModel(ctor, label);
                }
            }
        }
    }

    /**
     * Fetch the current server timestamp.
     * @returns Server timestamp in milliseconds
     */
    private async fetchServerTime(): Promise<number> {
        const { timestamp } = await this.timeProvider.getServerTime();
        return timestamp;
    }

    /**
     * Mark a model as in-progress or completed during sync.
     * @param label - The model label
     * @param isStart - True to mark as in-progress, false to mark as completed
     */
    private markInProgress(label: string, isStart: boolean): void {
        if (isStart) {
            if (!this.inProgress.includes(label)) this.inProgress.push(label);
        } else {
            this.inProgress = this.inProgress.filter((l) => l !== label);
        }
        this.emitState(label);
    }

    /**
     * Emit a state change event.
     * @param label - The model label associated with the state change
     */
    private emitState(label: string): void {
        this.emit({ type: 'state', label, detail: this.getState() });
    }

    /**
     * Record a sync error.
     * @param label - The model label or 'all' for global errors
     * @param error - The error that occurred
     * @param _logMessage - Error message (kept for API compatibility but not used)
     */
    private recordError(
        label: string,
        error: unknown,
        _logMessage?: string
    ): void {
        this.errors += 1;
        this.emit({ type: 'error', label, detail: error });
    }

    /**
     * Finalize a sync cycle by updating the last sync timestamp.
     */
    private finishCycle(): void {
        this.lastSyncAt = Date.now();
        this.emitState(DataSyncManager.GLOBAL_LABEL);
    }

    /**
     * Execute a sync operation for a model with proper error handling and progress tracking.
     * @param label - The model label
     * @param operation - The async operation to execute
     * @param errorMessage - Error message to log if operation fails
     * @returns Result of the operation
     */
    private async executeModelSync<T>(
        label: string,
        operation: () => Promise<T>,
        errorMessage: string
    ): Promise<T> {
        this.markInProgress(label, true);
        try {
            return await operation();
        } catch (err) {
            this.recordError(label, err, errorMessage);
            throw err;
        } finally {
            this.markInProgress(label, false);
        }
    }

    /**
     * Get the sync adapter for a specific model.
     * @param ModelCtor - The model constructor
     * @param ctx - Sync context containing user ID and other metadata
     * @returns The sync adapter instance for the model
     * @throws Error if the model doesn't implement createAdapter method
     */
    private getAdapterForModel(
        ModelCtor: SyncModelCtor<any>,
        ctx?: SyncContext
    ): SyncAdapter {
        if (typeof (ModelCtor as any).createAdapter !== 'function') {
            throw new Error(
                `Model ${ModelCtor.table} must implement createAdapter method`
            );
        }
        return (ModelCtor as any).createAdapter(this.database, ModelCtor, ctx);
    }

    /**
     * Start auto-sync listener by subscribing to database changes.
     * Sets running state to true and begins observing registered model tables.
     */
    private startAutoSyncListener(): void {
        this.running = true;
        const tables = this.models.map((m) => m.ctor.table);
        this.autoSync.subscribe({
            database: this.database,
            tables,
            onTrigger: (changes) => this.onLocalChanged(changes),
            onError: () => {
                // Error handled silently
            },
        });
    }

    /**
     * Stop auto-sync listener by unsubscribing from database changes.
     * Sets running state to false and stops observing database changes.
     */
    private stopAutoSyncListener(): void {
        this.running = false;
        this.autoSync.unsubscribe();
    }

    /**
     * Handle local database changes for auto-sync.
     * Observes local DB changes and triggers sync (debounced).
     * @param changes - The local database changes that triggered this callback
     */
    private onLocalChanged(changes?: any): void {
        // Early return if changes should be ignored
        if (!checkAndDecrement() || !changes || !this.running) {
            return;
        }
        
        if (this.isSyncing) {
            this.hasPendingChange = true;
            return;
        }
        
        this.scheduleAutoSync();
    }

    /**
     * Schedule an auto-sync with debouncing.
     * Uses the AutoSyncController to debounce sync requests.
     */
    private scheduleAutoSync(): void {
        if (!this.running) return;
        this.autoSync.trigger(() => {
            if (!this.running) return;
            this.syncNow(this.defaultCtx).catch(() => {
                // Error already recorded in syncNow
            });
        });
    }

    /**
     * Manually start remote subscriptions for all registered models.
     * Subscribes to remote data changes and triggers sync when changes are detected.
     * This must be called manually after start() if you want to enable remote sync.
     */
    startRemoteSubscriptions(): void {
        if (this.remoteSubscriptionEnabled) return;
        
        this.remoteSubscriptionEnabled = true;
        
        for (const { ctor, label } of this.models) {
            this.subscribeToModel(ctor, label);
        }
    }

    /**
     * Subscribe to remote changes for a specific model.
     * @param ModelCtor - The model constructor
     * @param label - The model label
     */
    private subscribeToModel(ModelCtor: SyncModelCtor<any>, label: string): void {
        try {
            const adapter = this.getAdapterForModel(ModelCtor, this.defaultCtx);
            const subscription = adapter.subscribeToRemoteChanges(
                this.defaultCtx,
                (payload) => this.onRemoteChanged(label, payload)
            );
            
            this.remoteSubscriptions.set(label, subscription);
            this.emit({ 
                type: 'state', 
                label, 
                detail: { ...this.getState(), remoteSubscribed: true } 
            });
        } catch (err) {
            this.recordError(label, err, 'Failed to subscribe to remote changes');
        }
    }

    /**
     * Unsubscribe from remote changes for a specific model.
     * @param label - The model label
     */
    private unsubscribeFromModel(label: string): void {
        const subscription = this.remoteSubscriptions.get(label);
        if (!subscription) return;
        
        try {
            subscription.unsubscribe();
            this.remoteSubscriptions.delete(label);
            this.emit({ 
                type: 'state', 
                label, 
                detail: { ...this.getState(), remoteSubscribed: false } 
            });
        } catch (err) {
            this.recordError(label, err, 'Failed to unsubscribe from remote changes');
        }
    }

    /**
     * Manually stop all remote subscriptions.
     * Unsubscribes from all remote data change notifications.
     * This must be called manually if you want to stop remote sync.
     */
    stopRemoteSubscriptions(): void {
        if (!this.remoteSubscriptionEnabled) return;
        
        this.remoteSubscriptionEnabled = false;
        
        for (const [, subscription] of this.remoteSubscriptions.entries()) {
            try {
                subscription.unsubscribe();
            } catch {
                // Silently handle unsubscribe errors
            }
        }
        
        this.remoteSubscriptions.clear();
    }

    /**
     * Handle remote data changes.
     * Triggered when subscribed remote data sources emit change events.
     * Schedules a sync using the same debouncing mechanism as local changes.
     * @param label - The model label that detected the change
     * @param payload - Optional change payload from the remote source
     */
    private onRemoteChanged(label: string, payload?: unknown): void {
        if (!this.remoteSubscriptionEnabled) return;
        
        // Emit remote change event
        this.emit({ 
            type: 'remoteChanged', 
            label, 
            detail: payload 
        });
        
        // If already syncing, mark as pending
        if (this.isSyncing) {
            this.hasPendingChange = true;
            return;
        }
        
        // Trigger sync with debouncing (same as local changes)
        this.autoSync.trigger(() => {
            if (!this.remoteSubscriptionEnabled) return;
            this.syncNow(this.defaultCtx).catch(() => {
                // Error already recorded in syncNow
            });
        });
    }
}

/**
 * Create a deferred promise with exposed resolve and reject functions.
 * @returns Object containing the promise and its control functions
 */
function createDeferred<T = void>(): Deferred<T> {
    let resolve!: Deferred<T>['resolve'];
    let reject!: Deferred<T>['reject'];
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}
