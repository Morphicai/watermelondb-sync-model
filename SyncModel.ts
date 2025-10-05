import { Model } from '@nozbe/watermelondb';
import { SupabaseAdapter } from './adapters/SupabaseAdapter';
import type { SyncAdapter } from './adapters/SyncAdapter';
import type { Database } from '@nozbe/watermelondb';
import { Q } from '@nozbe/watermelondb';

// 共享类型：用于在同步过程中传递必要上下文（如 userId）
export interface SyncContext {
    userId?: string;
}
// 本地原始数据约束：必须包含字符串 id（WatermelonDB 同步协议要求）
export type LocalRawBase = Record<string, unknown> & { id: string };
// 唯一键规范：local 为本地字段路径，remote 为远端字段/JSON 路径（支持 a.b）
export interface UniqueKeySpec {
    local: string;
    remote: string;
}
// 同步键集合：支持单一或联合唯一键（数组）
export interface SyncKeysSpec {
    remotePk: string;
    localRemoteId?: string;
    uniqueKey?: UniqueKeySpec | UniqueKeySpec[];
}
export interface SyncTimestampsSpec {
    local: string;
    remote: string;
}
export interface SyncScopeSpec {
    userField?: string;
}

export type SyncEventType =
    | 'pulled'
    | 'pushed'
    | 'conflict'
    | 'error'
    | 'state'
    | 'remoteChanged';
export interface SyncEvent {
    type: SyncEventType;
    label: string;
    detail?: any;
}
export interface ManagerState {
    running: boolean;
    inProgress: string[];
    lastSyncAt?: number;
    queueSize: number;
    errors: number;
}

/**
 * 同步模型抽象基类：用于参与远端/本地双向同步的 WatermelonDB 表。
 * 
 * @description
 * 该类提供了本地数据库与远端数据源（如 Supabase）之间的双向同步能力。
 * 继承此类的模型会自动参与同步流程，实现数据的拉取（下行）和推送（上行）。
 * 
 * @template LocalRaw - 本地数据库原始数据类型，必须包含 id 字段
 * @template RemoteRow - 远端数据源的行数据类型
 * 
 * @remarks
 * 子类必须实现的属性和方法：
 * - static remoteTable - 远端表名
 * - static syncKeys - 主键和唯一键映射
 * - static syncTimestamps - 时间戳字段映射
 * - static remoteToLocal() - 下行数据转换静态方法
 * - localToRemote() - 上行数据转换实例方法
 */
export abstract class SyncModel<
    LocalRaw extends LocalRawBase = LocalRawBase,
    RemoteRow = unknown
> extends Model {
    /**
     * 远端表名
     * 
     * @description
     * 指定与本地表对应的远端数据源表名（如 Supabase 表名）。
     * 同步时会使用此表名进行远端数据的查询和写入操作。
     * 
     * @example
     * ```typescript
     * static remoteTable = 'tasks';
     * ```
     */
    static remoteTable: string;

    /**
     * 同步键映射配置
     * 
     * @description
     * 定义本地和远端数据的主键映射关系，用于在同步过程中匹配和关联记录。
     * 
     * @property {string} remotePk - 远端主键字段名
     * @property {string} [localRemoteId] - 本地存储远端 ID 的字段名
     * @property {UniqueKeySpec | UniqueKeySpec[]} [uniqueKey] - 唯一键约束，用于首次同步时匹配已存在的记录
     * 
     * @example
     * ```typescript
     * static syncKeys = {
     *   remotePk: 'id',              // 远端主键字段
     *   localRemoteId: 'remote_id',  // 本地存储远端 id 的字段
     *   uniqueKey: {                 // 唯一键匹配
     *     local: 'title',
     *     remote: 'title'
     *   }
     * };
     * ```
     */
    static syncKeys: SyncKeysSpec;

    /**
     * 时间戳字段映射
     * 
     * @description
     * 指定本地和远端的更新时间戳字段名，用于冲突检测和增量同步。
     * 同步时会比较这些字段来判断数据的新旧程度。
     * 
     * @property {string} local - 本地时间戳字段名
     * @property {string} remote - 远端时间戳字段名
     * 
     * @example
     * ```typescript
     * static syncTimestamps = {
     *   local: 'updated_at',
     *   remote: 'updated_at'
     * };
     * ```
     */
    static syncTimestamps: SyncTimestampsSpec;

    /**
     * 作用域配置（可选）
     * 
     * @description
     * 用于多租户或用户隔离场景，指定哪个字段用于数据过滤。
     * 同步时会自动过滤出属于当前用户的数据（配合 RLS 或应用层过滤）。
     * 
     * @property {string} [userField] - 用户标识字段名
     * 
     * @example
     * ```typescript
     * static scope = {
     *   userField: 'user_id'
     * };
     * ```
     */
    static scope?: SyncScopeSpec;

    /**
     * 软删除字段名（可选）
     * 
     * @description
     * 指定远端数据的软删除标记字段。
     * 当远端记录被标记为已删除时，同步会将本地对应记录也标记为删除。
     * 如果不指定，默认使用 'is_deleted'。
     * 
     * @default 'is_deleted'
     * 
     * @example
     * ```typescript
     * static softDeleteField = 'deleted';
     * ```
     */
    static softDeleteField?: string;

    /**
     * 模型标签（可选）
     * 
     * @description
     * 用于在日志和同步事件中显示的友好名称。
     * 如果不指定，会使用类名或表名。
     * 
     * @example
     * ```typescript
     * static label = 'Task';
     * ```
     */
    static label?: string;

    /**
     * 下行数据转换：远端数据 -> 本地数据
     * 
     * @description
     * 静态方法，用于将远端数据行转换为本地数据库的原始数据格式。
     * 这是一个纯函数，不应依赖实例状态，只做字段映射和数据转换。
     * 
     * @param {RemoteRow} row - 远端数据行
     * @param {SyncContext} ctx - 同步上下文（包含 userId 等信息）
     * @returns {LocalRaw} 本地数据库原始数据
     * 
     * @example
     * ```typescript
     * static remoteToLocal(row: RemoteTask, ctx: SyncContext): LocalTaskRaw {
     *   return {
     *     id: row.id,
     *     title: row.title,
     *     remote_id: row.id,
     *     user_id: row.user_id,
     *     updated_at: row.updated_at,
     *   };
     * }
     * ```
     */
    static remoteToLocal(row: any, ctx: SyncContext): Record<string, any> {
        return row;
    }

    /**
     * 上行数据转换：本地数据 -> 远端数据
     * 
     * @description
     * 实例方法，用于将当前记录转换为远端数据格式。
     * 可以访问实例的所有属性，生成要推送到远端的数据负载。
     * 
     * @param {SyncContext} ctx - 同步上下文（包含 userId 等信息）
     * @returns {Partial<RemoteRow>} 远端数据负载（部分字段）
     * 
     * @example
     * ```typescript
     * localToRemote(ctx: SyncContext): Partial<RemoteTask> {
     *   return {
     *     id: this.remoteId,
     *     title: this.title,
     *     user_id: ctx.userId,
     *     updated_at: this.updatedAt,
     *   };
     * }
     * ```
     */
    abstract localToRemote(
        ctx: SyncContext
    ): Partial<RemoteRow> | Record<string, unknown>;

    /**
     * 记录级上行过滤（可选）
     * 
     * @description
     * 用于在上行同步前判断当前记录是否应该被推送到远端。
     * 返回 true 表示同步，返回 false 表示跳过。
     * 
     * @param {SyncContext} ctx - 同步上下文
     * @returns {boolean | Promise<boolean>} 是否同步该记录
     * 
     * @example
     * ```typescript
     * async shouldSyncLocal(ctx: SyncContext): Promise<boolean> {
     *   // 只同步当前用户的记录
     *   return this.userId === ctx.userId;
     * }
     * ```
     */
    shouldSyncLocal?(ctx: SyncContext): Promise<boolean> | boolean;

    /**
     * 同步适配器工厂方法（可选）
     * 
     * @description
     * 用于创建该表专用的同步适配器实例。
     * 默认返回 SupabaseAdapter，子类可以覆盖此方法以使用自定义适配器。
     * 
     * @param {Database} database - WatermelonDB 数据库实例
     * @param {SyncModelCtor<any>} ModelCtor - 模型构造函数（通常是 this）
     * @param {SyncContext} [defaultCtx] - 默认同步上下文
     * @returns {SyncAdapter} 同步适配器实例
     * 
     * @example
     * ```typescript
     * protected static createAdapter(
     *   database: Database,
     *   ModelCtor: SyncModelCtor<any>,
     *   defaultCtx?: SyncContext
     * ): SyncAdapter {
     *   return new MyCustomAdapter(database, ModelCtor, { defaultCtx });
     * }
     * ```
     */
    protected static createAdapter(
        database: Database,
        ModelCtor: SyncModelCtor<any>,
        defaultCtx?: SyncContext
    ): SyncAdapter {
        return new SupabaseAdapter(database, ModelCtor, { defaultCtx });
    }

    /**
     * 根据远端 ID 查找本地记录
     * 
     * @description
     * 在本地数据库中查找对应远端 ID 的记录。
     * 如果找不到匹配的记录，返回 null。
     * 
     * @param {Database} database - WatermelonDB 数据库实例
     * @param {string} remoteIdKey - 存储远端 ID 的本地字段名
     * @param {string} remoteIdValue - 要查找的远端 ID 值
     * @returns {Promise<Model | null>} 找到的本地记录，未找到返回 null
     * 
     * @example
     * ```typescript
     * const localRecord = await Task.findLocalByRemoteId(database, 'remote_id', 'abc123');
     * ```
     */
    protected static findLocalByRemoteId(database: Database, remoteIdKey: string, remoteIdValue: string): any {
        return database
            .get<any>(this.table)
            .query(Q.where(remoteIdKey, remoteIdValue))
            .fetch();
    }
}
// 静态侧类型约束：用于在管理器/适配器侧对类值进行编译期校验
export interface SyncModelStaticShape<
    LocalRaw extends LocalRawBase = LocalRawBase,
    RemoteRow = unknown
> {
    table: string;
    remoteTable: string;
    syncKeys: SyncKeysSpec;
    syncTimestamps: SyncTimestampsSpec;
    scope?: SyncScopeSpec;
    softDeleteField?: string;
    label?: string;
    remoteToLocal(row: RemoteRow, ctx: SyncContext): LocalRaw; // 返回 LocalRaw 受类型约束
    createAdapter?(database: Database, ModelCtor: SyncModelCtor<any>, defaultCtx?: SyncContext): SyncAdapter; // 返回同步适配器实例
    findLocalByRemoteId(database: Database, remoteIdKey: string, remoteIdValue: string): any; // 根据远端 id 在本地数据库中查找记录，未命中返回 null
}

export type SyncModelCtor<T extends SyncModel<any, any>> = {
    new (...args: any[]): T;
} & typeof SyncModel &
    SyncModelStaticShape<any, any>;
