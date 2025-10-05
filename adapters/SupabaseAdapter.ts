import { Database } from '@nozbe/watermelondb';
import type { SyncModel, UniqueKeySpec } from '../SyncModel';
import type { Logger, SupabaseClient } from '../types';
import type { PullResult, TableChanges, RemoteSubscription } from './SyncAdapter';
import { BaseSyncAdapter } from './SyncAdapter';
import type { SyncContext, SyncModelCtor } from '../SyncModel';
import { parseTimestamp } from '../utils/timestamp';
import { logLocalToRemotePayload } from '../utils/logging';
import { SyncEventBus } from '../SyncEventBus';
import { DEFAULT_SOFT_DELETE_FIELD } from '../constants';
import { noopLogger } from '../types';

const DEFAULT_LOCAL_REMOTE_ID = 'remote_id';

export class SupabaseAdapter<
    L extends Record<string, unknown> & { id: string } = Record<
        string,
        unknown
    > & { id: string },
    R = unknown
> extends BaseSyncAdapter<L, R> {
    private readonly pageSize = 1000;
    private readonly defaultCtx?: SyncContext;
    private readonly supabase: SupabaseClient;
    private readonly logger: Logger;
    private readonly syncEventBus: SyncEventBus;
    
    constructor(
        database: Database,
        ModelCtor: SyncModelCtor<SyncModel<L, R>>,
        opts?: { 
            defaultCtx?: SyncContext;
            supabase: SupabaseClient;
            logger?: Logger;
            syncEventBus?: SyncEventBus;
        }
    ) {
        super(database, ModelCtor);
        if (!opts?.supabase) {
            throw new Error('SupabaseAdapter requires a supabase client instance');
        }
        this.supabase = opts.supabase;
        this.logger = opts.logger || noopLogger;
        this.syncEventBus = opts.syncEventBus || new SyncEventBus(this.logger);
        this.defaultCtx = opts?.defaultCtx;
    }

    async getLocalModel(localId: string): Promise<any> {
        return await this.database.get<any>(this.ModelCtor.table).find(localId);
    }
    // inherit constructor

    private getContext(ctx?: SyncContext): SyncContext {
        return { ...this.defaultCtx, ...ctx };
    }

    private applyScope(sel: any, userField?: string, ctx?: SyncContext): any {
        if (userField && ctx?.userId) {
            return sel.eq(userField, ctx.userId);
        }
        return sel;
    }

    private buildUpdatedAfterQuery(params: {
        remoteTable: string;
        remoteUpdatedAt: string;
        lastPulledAt: number | null;
        userField?: string;
        ctx?: SyncContext;
    }): any {
        const { remoteTable, remoteUpdatedAt, lastPulledAt, userField, ctx } =
            params;
        let query = this.supabase.from(remoteTable).select('*');
        if (userField && ctx?.userId) {
            query = query.eq(userField, ctx.userId);
        }
        if (lastPulledAt) {
            const iso = new Date(lastPulledAt).toISOString();
            this.logger.debug('[sync][pull][remote] filter', {
                table: remoteTable,
                remoteUpdatedAt,
                gte: iso,
            });
            query = query.gte(remoteUpdatedAt, iso);
        } else {
            this.logger.debug('[sync][pull][remote] filter', {
                table: remoteTable,
                remoteUpdatedAt,
                gte: null,
            });
        }
        return query;
    }

    private async writeBackRemoteId(
        model: any,
        params: {
            localRemoteId: string;
            remoteId: string;
            remoteUpdatedAtKey: string;
            remoteRow?: Record<string, unknown> | null;
            remoteUpdatedAtValue?: unknown;
        }
    ): Promise<void> {
        const {
            localRemoteId,
            remoteId,
            remoteUpdatedAtKey,
            remoteRow,
            remoteUpdatedAtValue,
        } = params;

        const currentRemoteId = model[localRemoteId];
        const localUpdatedAtKey = model.constructor?.syncTimestamps?.local;
        const currentUpdatedAt = localUpdatedAtKey
            ? this.localData.getTimestamp(model, localUpdatedAtKey)
            : undefined;
        const effectiveRemoteUpdatedValue =
            remoteUpdatedAtValue ??
            (remoteRow
                ? this.getRowField(remoteRow, remoteUpdatedAtKey)
                : undefined);
        const remoteUpdatedMs = parseTimestamp(effectiveRemoteUpdatedValue);
        const localUpdatedMs = Number.isFinite(currentUpdatedAt)
            ? Number(currentUpdatedAt)
            : undefined;

        if (remoteUpdatedMs != null) {
            this.logger.debug('SupabaseAdapter: updatedAt diff', {
                localId: model.id,
                remoteId,
                remoteUpdatedAtMs: remoteUpdatedMs,
                localUpdatedAtMs: localUpdatedMs ?? null,
                diffMs:
                    localUpdatedMs != null && Number.isFinite(remoteUpdatedMs)
                        ? remoteUpdatedMs - localUpdatedMs
                        : null,
            });
        }

        const needsRemoteIdUpdate = currentRemoteId !== String(remoteId);
        const shouldUpdateTimestamp =
            remoteUpdatedMs != null &&
            Number.isFinite(remoteUpdatedMs) &&
            localUpdatedAtKey &&
            (!Number.isFinite(currentUpdatedAt) ||
                remoteUpdatedMs > Number(currentUpdatedAt));

        if (!needsRemoteIdUpdate && !shouldUpdateTimestamp) {
            this.logger.debug('SupabaseAdapter: writeBackRemoteId skip', {
                localId: model.id,
                remoteId,
                remoteUpdatedAt: effectiveRemoteUpdatedValue,
            });
            return;
        }
        const now = new Date().getTime();
        this.logger.debug('SupabaseAdapter: writing back remote info', {
            localId: model.id,
            currentRemoteId,
            remoteId,
            needsRemoteIdUpdate,
            shouldUpdateTimestamp,
            remoteUpdatedAt: effectiveRemoteUpdatedValue,
            currentTimestamp: now,
            offsetTime: new Date(effectiveRemoteUpdatedValue).getTime() - now,
        });
        const updateData = async () => {
            await this.database.write(async () => {
                await model.update((m: Record<string, unknown>) => {
                    if (needsRemoteIdUpdate) {
                        (m as any)[localRemoteId] = String(remoteId);
                    }
                    (m as any)[localUpdatedAtKey] = remoteUpdatedMs;
                });
            });
        };
        this.localData.updateWithoutSync(updateData);
    }

    private async fetchRemoteRow(
        remoteTable: string,
        remotePk: string,
        remoteId: string
    ): Promise<Record<string, unknown> | null> {
        this.logger.debug('SupabaseAdapter: select one (by pk)', {
            table: remoteTable,
            pk: remotePk,
            id: remoteId,
        });
        const { data, error } = await this.supabase
            .from(remoteTable)
            .select('*')
            .eq(remotePk, remoteId)
            .limit(1);
        if (error) {
            this.logger.error('SupabaseAdapter: select one failed', {
                table: remoteTable,
                pk: remotePk,
                id: remoteId,
                error,
            });
            throw error;
        }
        const row = (data as any[] | null)?.[0] ?? null;
        this.logger.debug('SupabaseAdapter: select one result', {
            table: remoteTable,
            found: !!row,
        });
        return row;
    }

    /**
     * 通过唯一键在远端查询主键，缺失字段立即报错
     */
    private async findRemoteIdByUniqueKey(
        remoteTable: string,
        remotePk: string,
        uniqueSpecs: UniqueKeySpec[],
        model: unknown,
        userField: string | undefined,
        ctx: SyncContext,
        softDeleteField?: string
    ): Promise<string | undefined> {
        if (uniqueSpecs.length === 0) return undefined;
        this.logger.debug('SupabaseAdapter: findRemoteIdByUniqueKey start', {
            table: remoteTable,
            remotePk,
            uniqueSpecs,
        });
        let sel: any = this.supabase
            .from(remoteTable)
            .select(`${remotePk}`)
            .limit(1);
        for (const spec of uniqueSpecs) {
            const value = this.localData.getUniqueValue(model, spec.local);
            if (value == null) {
                throw new Error(
                    `唯一键字段 ${spec.local} 在本地记录中缺失，无法执行同步`
                );
            }
            if (spec.remote.includes('.')) {
                const jsonPath = toPostgrestJsonPath(spec.remote);
                sel = sel.filter(jsonPath, 'eq', String(value));
            } else {
                sel = sel.eq(spec.remote, value);
            }
        }
        sel = this.applyScope(sel, userField, ctx);
        const softField = softDeleteField || DEFAULT_SOFT_DELETE_FIELD;
        sel = sel.eq(softField, false);
        const { data, error } = await sel;
        if (error) {
            this.logger.error('SupabaseAdapter: findRemoteIdByUniqueKey failed', {
                table: remoteTable,
                error,
            });
            throw error;
        }
        const row = (data as any[] | null)?.[0];
        this.logger.debug('SupabaseAdapter: findRemoteIdByUniqueKey result', {
            table: remoteTable,
            found: !!row,
        });
        if (!row) return undefined;
        return String(this.getRowField(row, remotePk));
    }
    async pull(
        lastPulledAt: number | null,
        ctx?: SyncContext
    ): Promise<PullResult<L>> {
        const effCtx: SyncContext = this.getContext(ctx);
        const remoteTable = this.ModelCtor.remoteTable;
        const remotePk = this.ModelCtor.syncKeys.remotePk;
        const localRemoteId =
            this.ModelCtor.syncKeys.localRemoteId || DEFAULT_LOCAL_REMOTE_ID;
        const remoteUpdatedAt = this.ModelCtor.syncTimestamps.remote;
        const localUpdatedAt = this.ModelCtor.syncTimestamps.local;
        const userField = this.ModelCtor.scope?.userField;
        const uniqueSpecs = this.normalizeUniqueSpecs(
            this.ModelCtor.syncKeys.uniqueKey
        );

        const softDeleteField = (this.ModelCtor as any).softDeleteField as
            | string
            | undefined;
        let uniqueIndex: Map<string, any> | null = null;
        let uniqueIndexLoaded = false;
        const seenRemoteKeys =
            uniqueSpecs.length > 0 ? new Set<string>() : null;

        const findLocalByRemoteId = (remoteIdVal: string) =>
            this.localData.findByRemoteId(localRemoteId, remoteIdVal);

        const findLocalByUniqueKey = async (row: any): Promise<any | null> => {
            if (uniqueSpecs.length === 0) return null;
            if (!uniqueIndexLoaded) {
                uniqueIndex = await this.localData.buildUniqueIndex(
                    uniqueSpecs,
                    (record, specs) => this.localData.getUniqueKey(record, specs, this.serializeUniqueValues),
                    effCtx,
                    userField,
                    softDeleteField
                );
                uniqueIndexLoaded = true;
            }
            if (!uniqueIndex) return null;
            const key = this.getRemoteUniqueKey(row, uniqueSpecs, remoteTable);
            if (seenRemoteKeys) {
                if (seenRemoteKeys.has(key)) {
                    throw new Error(
                        `远端记录 ${remoteTable} 唯一键重复: ${key}`
                    );
                }
                seenRemoteKeys.add(key);
            }
            return uniqueIndex.get(key) || null;
        };

        let query = this.buildUpdatedAfterQuery({
            remoteTable,
            remoteUpdatedAt,
            lastPulledAt,
            userField,
            ctx: effCtx,
        });

        let from = 0;
        const created: L[] = [] as any;
        const updated: L[] = [] as any;
        const deleted: string[] = [];
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const { data, error } = await query.range(
                from,
                from + this.pageSize - 1
            );
            if (error) throw error;
            const rows = data || [];
            this.logger.debug('[sync][pull][remote] page', {
                table: remoteTable,
                from,
                count: rows.length,
            });
            for (const row of rows) {
                const remoteIdVal = String(this.getRowField(row, remotePk));
                const isDeletedRemote = this.normalizeSoftDelete(
                    row,
                    softDeleteField
                );

                let localRecord = await findLocalByRemoteId(remoteIdVal);
                this.logger.debug(
                    'SupabaseAdapter:  rfindLocalByRemoteIdesult',
                    localRecord
                );
                if (isDeletedRemote) {
                    if (!localRecord) {
                        localRecord = await findLocalByUniqueKey(row);
                    }
                    if (localRecord) deleted.push(localRecord.id);
                    continue;
                }

                if (!localRecord) {
                    localRecord = await findLocalByUniqueKey(row);
                }
                const raw = this.ModelCtor.remoteToLocal(
                    row as any,
                    effCtx
                ) as unknown as L;
                const anyRaw = raw as unknown as Record<string, unknown> & {
                    id?: string;
                };
                if (!anyRaw[localRemoteId]) anyRaw[localRemoteId] = remoteIdVal;
                const remoteUpdatedValue = this.getRowField(
                    row,
                    remoteUpdatedAt
                );
                if (!anyRaw[localUpdatedAt] && remoteUpdatedValue) {
                    anyRaw[localUpdatedAt] = Date.parse(
                        String(remoteUpdatedValue)
                    );
                }
                // track max remote updated_at
                if (localRecord) {
                    const localUpdated = Number(
                        this.localData.getTimestamp(localRecord, localUpdatedAt)
                    );
                    const remoteUpdated = Date.parse(
                        String(this.getRowField(row, remoteUpdatedAt))
                    );
                    this.logger.debug('[sync][pull] timestamp comparison', {
                        id: localRecord.id,
                        remoteId: remoteIdVal,
                        localUpdated,
                        remoteUpdated,
                        timeDiff: remoteUpdated - localUpdated,
                        willUpdate:
                            isFinite(remoteUpdated) &&
                            remoteUpdated > localUpdated,
                    });
                    if (
                        isFinite(remoteUpdated) &&
                        remoteUpdated > localUpdated
                    ) {
                        updated.push({ ...raw, id: localRecord.id });
                    }
                } else {
                    // anyRaw.localId = `${this.ModelCtor.table}:${remoteIdVal}`;
                    const generatedId = `${this.ModelCtor.table}:${remoteIdVal}`;
                    created.push({ ...raw, id: generatedId });
                }
            }
            if (rows.length < this.pageSize) break;
            from += this.pageSize;
        }
        return { created, updated, deleted };
    }

    async push(
        tableChanges: TableChanges<L>,
        ctx?: SyncContext
    ): Promise<void> {
        const effCtx: SyncContext = this.getContext(ctx);
        const remoteTable = this.ModelCtor.remoteTable;
        const remotePk = this.ModelCtor.syncKeys.remotePk;
        const localRemoteId =
            this.ModelCtor.syncKeys.localRemoteId || DEFAULT_LOCAL_REMOTE_ID;
        const userField = this.ModelCtor.scope?.userField;
        const uniqueSpecs = this.normalizeUniqueSpecs(
            this.ModelCtor.syncKeys.uniqueKey
        );

        const softDeleteField = (this.ModelCtor as any).softDeleteField as
            | string
            | undefined;
        await this.pushDeletes(
            tableChanges.deleted || [],
            remoteTable,
            remotePk,
            localRemoteId,
            softDeleteField
        );
        await this.pushUpserts(
            tableChanges,
            remoteTable,
            remotePk,
            localRemoteId,
            userField,
            effCtx,
            uniqueSpecs
        );
    }

    private async pushDeletes(
        deletedIds: string[],
        remoteTable: string,
        remotePk: string,
        localRemoteId: string,
        softDeleteField?: string
    ): Promise<void> {
        const remoteSoftField = softDeleteField || DEFAULT_SOFT_DELETE_FIELD;
        for (const localId of deletedIds) {
            try {
                const instance = await this.database
                    .get<any>(this.ModelCtor.table)
                    .find(localId);
                const remoteIdVal = (instance as any)[localRemoteId];
                if (!remoteIdVal) continue;
                const updatePayload: Record<string, unknown> = {
                    updated_at: new Date().toISOString(),
                };
                updatePayload[remoteSoftField] = true;
                this.logger.debug('SupabaseAdapter: soft-delete update', {
                    table: remoteTable,
                    pk: remotePk,
                    id: remoteIdVal,
                    payload: updatePayload,
                });
                const { data, error } = await this.supabase
                    .from(remoteTable)
                    .update(updatePayload)
                    .eq(remotePk, remoteIdVal)
                    .select();
                if (error) {
                    this.logger.error(
                        'SupabaseAdapter: delete failed',
                        this.ModelCtor.table,
                        localId,
                        error
                    );
                    throw error;
                }
                this.logger.debug('SupabaseAdapter: soft-delete success', {
                    table: remoteTable,
                    affected: Array.isArray(data) ? data.length : 0,
                });
            } catch (err) {
                this.logger.error(
                    'SupabaseAdapter: delete failed (caught)',
                    this.ModelCtor.table,
                    localId,
                    err
                );
                throw err;
            }
        }
    }

    private async pushUpserts(
        tableChanges: TableChanges<L>,
        remoteTable: string,
        remotePk: string,
        localRemoteId: string,
        userField: string | undefined,
        effCtx: SyncContext,
        uniqueSpecs: UniqueKeySpec[]
    ): Promise<void> {
        const upsertIds = [
            ...(tableChanges.created || []).map((r: { id: string }) => r.id),
            ...(tableChanges.updated || []).map((r: { id: string }) => r.id),
        ];

        for (const localId of upsertIds) {
            try {
                const model = await this.getLocalModel(localId);
                this.logger.debug('SupabaseAdapter: evaluating shouldSyncLocal', {
                    table: this.ModelCtor.table,
                    localId,
                });
                if (typeof (model as any).shouldSyncLocal === 'function') {
                    const allow = await (model as any).shouldSyncLocal(effCtx);
                    if (!allow) continue;
                }
                const payload = (model as any).localToRemote(effCtx);
                this.logger.debug('SupabaseAdapter: upsert start', {
                    table: remoteTable,
                    localId,
                    hasRemoteId: !!(model as any)[localRemoteId],
                    remoteIdValue: (model as any)[localRemoteId],
                });
                if (
                    userField &&
                    effCtx?.userId &&
                    (payload as any)[userField] == null
                ) {
                    (payload as any)[userField] = effCtx.userId;
                }

                const remoteUpdatedAtKey = this.ModelCtor.syncTimestamps.remote;
                const localUpdatedAtKey = this.ModelCtor.syncTimestamps.local;
                const localUpdated = Number(
                    this.localData.getTimestamp(model, localUpdatedAtKey)
                );
                this.logger.debug('SupabaseAdapter: local updated timestamp', {
                    table: this.ModelCtor.table,
                    localId,
                    localUpdated,
                });

                let targetRemoteId: string | undefined;

                const remoteIdVal = (model as any)[localRemoteId];
                if (remoteIdVal) {
                    targetRemoteId = String(remoteIdVal);
                }

                if (!targetRemoteId && uniqueSpecs.length > 0) {
                    targetRemoteId = await this.findRemoteIdByUniqueKey(
                        remoteTable,
                        remotePk,
                        uniqueSpecs,
                        model,
                        userField,
                        effCtx,
                        (this.ModelCtor as any).softDeleteField
                    );
                }

                if (targetRemoteId) {
                    const skip = await this.skipIfRemoteNewer({
                        model,
                        remoteTable,
                        remotePk,
                        remoteId: targetRemoteId,
                        remoteUpdatedAtKey,
                        localUpdated,
                    });
                    if (skip) continue;

                    await this.upsertExisting(
                        remoteTable,
                        remotePk,
                        targetRemoteId,
                        payload
                    );
                    logLocalToRemotePayload(
                        this.logger,
                        this.ModelCtor.label || this.ModelCtor.table,
                        payload,
                        {
                            direction: 'update',
                            remoteId: targetRemoteId,
                        }
                    );
                    await this.writeBackRemoteId(model, {
                        localRemoteId,
                        remoteId: String(targetRemoteId),
                        remoteUpdatedAtKey,
                        remoteRow: payload,
                    });
                    continue;
                }

                const insertedId = await this.insertRemote(
                    remoteTable,
                    remotePk,
                    payload
                );
                if (insertedId != null) {
                    logLocalToRemotePayload(
                        this.logger,
                        this.ModelCtor.label || this.ModelCtor.table,
                        payload,
                        {
                            direction: 'create',
                            remoteId: insertedId,
                        }
                    );
                    await this.writeBackRemoteId(model, {
                        localRemoteId,
                        remoteId: insertedId,
                        remoteUpdatedAtKey,
                        remoteRow: payload,
                    });
                }
            } catch (err) {
                this.logger.error(
                    'SupabaseAdapter: upsert failed',
                    this.ModelCtor.table,
                    localId,
                    err
                );
                throw err;
            }
        }
    }

    private async skipIfRemoteNewer({
        model,
        remoteTable,
        remotePk,
        remoteId,
        remoteUpdatedAtKey,
        localUpdated,
    }: {
        model: any;
        remoteTable: string;
        remotePk: string;
        remoteId: string;
        remoteUpdatedAtKey: string;
        localUpdated: number;
    }): Promise<boolean> {
        try {
            const remoteRow = await this.fetchRemoteRow(
                remoteTable,
                remotePk,
                remoteId
            );
            if (!remoteRow) return false;
            const remoteUpdatedAtValue = this.getRowField(
                remoteRow,
                remoteUpdatedAtKey
            );
            this.logger.debug('SupabaseAdapter: remote updated timestamp', {
                table: remoteTable,
                remoteId,
                remoteUpdatedAtValue,
            });
            const remoteUpdated = Date.parse(String(remoteUpdatedAtValue));
            this.logger.debug('SupabaseAdapter: updated timestamp diff', {
                remoteUpdated,
                localUpdated,
                diffMs: remoteUpdated - localUpdated,
            });

            // 添加时间差阈值，避免微小时间差导致的循环更新
            const TIME_DIFF_THRESHOLD = 1000; // 1秒阈值
            const timeDiff = remoteUpdated - localUpdated;

            if (isFinite(remoteUpdated) && timeDiff >= 0) {
                this.logger.debug('SupabaseAdapter: skip upsert (remote newer)', {
                    table: model.constructor?.table ?? remoteTable,
                    localId: model.id,
                    remoteId,
                    localUpdated,
                    remoteUpdated,
                    timeDiff,
                });
                // await this.writeBackRemoteId(model, {
                //     localRemoteId,
                //     remoteId,
                //     remoteUpdatedAtKey,
                //     remoteRow,
                //     remoteUpdatedAtValue,
                // });
                return true;
            }

            this.logger.debug('SupabaseAdapter: upsert decision', {
                table: remoteTable,
                remoteId,
                localUpdated,
                remoteUpdated,
                timeDiff,
                threshold: TIME_DIFF_THRESHOLD,
            });
        } catch (err) {
            this.logger.debug('SupabaseAdapter: skipIfRemoteNewer error', err);
            // ignore compare failure; let caller continue with update
        }
        return false;
    }

    private async upsertExisting(
        remoteTable: string,
        remotePk: string,
        remoteId: string,
        payload: Record<string, unknown>
    ): Promise<void> {
        this.logger.debug('SupabaseAdapter: update existing', {
            table: remoteTable,
            pk: remotePk,
            id: remoteId,
            payload,
        });
        const { data, error } = await this.supabase
            .from(remoteTable)
            .update(payload)
            .eq(remotePk, remoteId)
            .select();
        if (error) {
            this.logger.error('SupabaseAdapter: update existing failed', {
                table: remoteTable,
                pk: remotePk,
                id: remoteId,
                error,
            });
            throw error;
        }
        this.logger.debug('SupabaseAdapter: update existing success', {
            table: remoteTable,
            affected: Array.isArray(data) ? data.length : 0,
        });
    }

    private async insertRemote(
        remoteTable: string,
        remotePk: string,
        payload: Record<string, unknown>
    ): Promise<string | null> {
        this.logger.debug('SupabaseAdapter: insert', { table: remoteTable, payload });
        const { data, error } = await this.supabase
            .from(remoteTable)
            .insert([payload])
            .select();
        if (error) {
            this.logger.error('SupabaseAdapter: insert failed', {
                table: remoteTable,
                error,
            });
            throw error;
        }
        const idVal = this.getRowField(data?.[0], remotePk);
        this.logger.debug('SupabaseAdapter: insert success', {
            table: remoteTable,
            id: idVal,
        });
        return idVal != null ? String(idVal) : null;
    }

    /**
     * 订阅远程数据变化
     *
     * @description
     * 监听绑定的 Model 对应的 Supabase 表的实时变化。
     * 当远程数据发生变化时，会触发回调函数并发送事件到 syncEventBus。
     *
     * @param {SyncContext} [ctx] - 同步上下文，用于用户过滤
     * @param {(payload?: unknown) => void} [onChange] - 变化回调函数
     * @returns {RemoteSubscription} 订阅对象（可取消订阅）
     */
    subscribeToRemoteChanges(
        ctx?: SyncContext,
        onChange?: (payload?: unknown) => void
    ): RemoteSubscription {
        try {
            const table = this.ModelCtor.remoteTable;
            if (!table) {
                this.logger.warn('[sync][remote] No remoteTable defined for model', {
                    modelTable: this.ModelCtor.table,
                });
                return { unsubscribe: () => {} };
            }

            const userField: string | undefined = this.ModelCtor.scope?.userField;
            const effCtx = this.getContext(ctx);
            const filter =
                userField && effCtx?.userId
                    ? `${userField}=eq.${effCtx.userId}`
                    : undefined;

            const channel = this.supabase.channel(
                `sync-${this.ModelCtor.table}-${Date.now()}`
            );

            channel.on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table,
                    ...(filter ? { filter } : {}),
                } as any,
                (payload: unknown) => {
                    try {
                        this.logger.debug('[sync][remote] change detected', {
                            model: this.ModelCtor.table,
                            table,
                        });
                        // Emit via event bus to decouple sources and consumers
                        this.syncEventBus.emit('sync:remote-change', {
                            table,
                            payload,
                        });
                        // Invoke callback
                        onChange?.(payload);
                    } catch (err) {
                        this.logger.error('[sync][remote] callback error', err);
                    }
                }
            );

            channel.subscribe((status: string) => {
                try {
                    this.logger.debug('[sync][remote] channel status', {
                        model: this.ModelCtor.table,
                        status,
                    });
                } catch {}
            });

            return {
                unsubscribe: () => {
                    try {
                        this.logger.debug('[sync][remote] unsubscribe', {
                            model: this.ModelCtor.table,
                        });
                        this.supabase.removeChannel(channel);
                    } catch (err) {
                        this.logger.error('[sync][remote] unsubscribe error', err);
                    }
                },
            };
        } catch (err) {
            this.logger.error('[sync][remote] subscribe failed', err);
            return { unsubscribe: () => {} };
        }
    }
}

function toPostgrestJsonPath(remotePath: string): string {
    const parts = remotePath.split('.');
    if (parts.length === 1) return remotePath;
    if (parts.length === 2) return `${parts[0]}->>${parts[1]}`;
    const head = parts.slice(0, -1).join('->');
    const tail = parts[parts.length - 1];
    return `${head}->>${tail}`;
}

/**
 * 订阅多个 Model 的远程数据变化（已废弃）
 *
 * @deprecated This function is deprecated. Use adapter instance's subscribeToRemoteChanges method instead.
 * 
 * @description
 * Subscribe to Supabase realtime changes for multiple models.
 * This function is kept for backward compatibility but it's recommended to use
 * the adapter instance method for each model instead.
 * 
 * Note: This function requires a SupabaseClient to be passed as the first parameter now.
 * 
 * @param {SupabaseClient} supabaseClient - Supabase client instance
 * @param {SyncModelCtor<any>[]} models - Model constructor array
 * @param {SyncContext} [ctx] - Sync context
 * @param {(payload?: unknown) => void} [onChange] - Change callback function
 * @returns {{ unsubscribe: () => void } | null} Subscription object or null
 * 
 * @example
 * ```typescript
 * // Old way (deprecated)
 * const subscription = subscribeToRemoteChanges(supabase, [Task, Note], ctx, callback);
 * 
 * // Recommended way
 * const database = getDatabase();
 * const taskAdapter = Task.createAdapter(database, Task, ctx);
 * const subscription = taskAdapter.subscribeToRemoteChanges(ctx, callback);
 * ```
 */
export function subscribeToRemoteChanges(
    supabaseClient: SupabaseClient,
    models: SyncModelCtor<any>[],
    ctx?: SyncContext,
    onChange?: (payload?: unknown) => void
): { unsubscribe: () => void } | null {
    try {
        if (!supabaseClient || !models || models.length === 0) return null;
        const channel = supabaseClient.channel(`sync-remote-${Date.now()}`);
        for (const ModelCtor of models) {
            const table = ModelCtor.remoteTable;
            if (!table) continue;
            const userField: string | undefined = ModelCtor.scope?.userField;
            const filter =
                userField && ctx?.userId
                    ? `${userField}=eq.${ctx.userId}`
                    : undefined;
            channel.on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table,
                    ...(filter ? { filter } : {}),
                } as any,
                (payload: unknown) => {
                    try {
                        // Note: In the deprecated function, we don't have access to logger
                        // So we skip logging here
                        // Backward-compatible direct callback (optional)
                        onChange?.(payload);
                    } catch {
                        // Silently ignore errors
                    }
                }
            );
        }
        channel.subscribe(() => {
            // Silently handle subscription status
        });
        return {
            unsubscribe: () => {
                try {
                    supabaseClient.removeChannel(channel);
                } catch {
                    // Silently ignore errors
                }
            },
        };
    } catch {
        return null;
    }
}

