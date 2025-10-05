import { Database } from '@nozbe/watermelondb';
import type {
    SyncContext,
    SyncModelCtor,
    SyncModel,
    LocalRawBase,
    UniqueKeySpec,
} from '../SyncModel';
import { DEFAULT_SOFT_DELETE_FIELD } from '../constants';
import { extractValueFromPath } from '../utils/format';
import { LocalDataAccessor } from './LocalDataAccessor';

/**
 * 下行同步结果
 *
 * @description
 * WatermelonDB synchronize 所需的三元组，包含创建、更新、删除的记录。
 *
 * @template L - 本地原始数据类型
 */
export interface PullResult<L extends LocalRawBase = LocalRawBase> {
    /** 新创建的记录 */
    created: L[];
    /** 已更新的记录 */
    updated: L[];
    /** 已删除的记录 ID 列表 */
    deleted: string[];
    /** 本次拉取观察到的最大远端更新时间戳（毫秒），用于设置 lastPulledAt */
    maxRemoteUpdatedAt?: number | null;
}

/**
 * 上行同步变更
 *
 * @description
 * WatermelonDB synchronize 提供的本地变更三元组。
 *
 * @template L - 本地原始数据类型
 */
export interface TableChanges<L extends LocalRawBase = LocalRawBase> {
    /** 新创建的记录 */
    created: L[];
    /** 已更新的记录 */
    updated: L[];
    /** 已删除的记录 ID 列表 */
    deleted: string[];
}

/**
 * 同步适配器接口
 *
 * @description
 * 定义每个表的 pull/push 同步实现，协调本地数据库和远端数据源之间的双向同步。
 * 负责本地数据查询、远端数据获取、以及两者之间的匹配和转换。
 * 
 * Adapter 实例与特定的 Model 构造函数绑定，在初始化时确定服务的表和配置。
 *
 * @template L - 本地原始数据类型
 * @template R - 远端数据类型
 */
/**
 * 远程变化订阅返回值
 *
 * @description
 * 订阅远程数据变化后返回的控制对象，用于取消订阅。
 */
export interface RemoteSubscription {
    /** 取消订阅函数 */
    unsubscribe: () => void;
}

export interface SyncAdapter<
    L extends LocalRawBase = LocalRawBase,
    R = unknown
> {
    /**
     * 下行同步：从远端拉取数据
     *
     * @param {number | null} lastPulledAt - 上次拉取时间戳（毫秒），null 表示首次同步
     * @param {SyncContext} [ctx] - 同步上下文
     * @returns {Promise<PullResult<L>>} 拉取结果
     */
    pull(
        lastPulledAt: number | null,
        ctx?: SyncContext
    ): Promise<PullResult<L>>;

    /**
     * 上行同步：推送本地变更到远端
     *
     * @param {TableChanges<L>} changes - 本地变更
     * @param {SyncContext} [ctx] - 同步上下文
     * @returns {Promise<void>}
     */
    push(
        changes: TableChanges<L>,
        ctx?: SyncContext
    ): Promise<void>;

    /**
     * 订阅远程数据变化
     *
     * @description
     * 监听远端数据源的实时变化（如数据库更新、插入、删除等）。
     * 当远程数据发生变化时，会触发回调函数。
     * 
     * @param {SyncContext} [ctx] - 同步上下文，用于用户过滤等
     * @param {(payload?: unknown) => void} [onChange] - 变化回调函数
     * @returns {RemoteSubscription} 订阅对象（可取消订阅）
     * 
     * @example
     * ```typescript
     * const subscription = adapter.subscribeToRemoteChanges(ctx, (payload) => {
     *   console.log('Remote data changed:', payload);
     * });
     * 
     * // 稍后取消订阅
     * subscription.unsubscribe();
     * ```
     */
    subscribeToRemoteChanges(
        ctx?: SyncContext,
        onChange?: (payload?: unknown) => void
    ): RemoteSubscription;
}

/**
 * 同步适配器基类
 *
 * @description
 * 提供同步适配器的核心实现，负责协调本地和远端数据的同步。
 * 
 * 职责：
 * - 定义 pull/push 抽象方法供子类实现
 * - 提供远端数据处理工具方法（字段读取、唯一键生成、软删除判断等）
 * - 组合使用 LocalDataAccessor 处理本地数据操作
 * 
 * Adapter 实例在构造时绑定特定的 Model，避免在每次方法调用时重复传递 ModelCtor。
 * 子类需要实现 pull 和 push 方法来连接具体的远端数据源（如 Supabase）。
 *
 * @template L - 本地原始数据类型
 * @template R - 远端数据类型
 */
export abstract class BaseSyncAdapter<
    L extends LocalRawBase = LocalRawBase,
    R = unknown
> implements SyncAdapter<L, R>
{
    /** WatermelonDB 数据库实例 */
    protected readonly database: Database;
    
    /** 绑定的模型构造函数 */
    protected readonly ModelCtor: SyncModelCtor<SyncModel<L, R>>;

    /** 本地数据访问器 */
    protected readonly localData: LocalDataAccessor<L, R>;

    /**
     * 构造函数
     *
     * @param {Database} database - WatermelonDB 数据库实例
     * @param {SyncModelCtor<SyncModel<L, R>>} ModelCtor - 模型构造函数，确定该 Adapter 服务的表
     */
    constructor(database: Database, ModelCtor: SyncModelCtor<SyncModel<L, R>>) {
        this.database = database;
        this.ModelCtor = ModelCtor;
        this.localData = new LocalDataAccessor(database, ModelCtor);
    }

    /**
     * 下行同步：从远端拉取数据（子类必须实现）
     * 
     * @param {number | null} lastPulledAt - 上次拉取时间戳（毫秒），null 表示首次同步
     * @param {SyncContext} [ctx] - 同步上下文
     * @returns {Promise<PullResult<L>>} 拉取结果
     */
    abstract pull(
        lastPulledAt: number | null,
        ctx?: SyncContext
    ): Promise<PullResult<L>>;

    /**
     * 上行同步：推送本地变更到远端（子类必须实现）
     * 
     * @param {TableChanges<L>} changes - 本地变更
     * @param {SyncContext} [ctx] - 同步上下文
     * @returns {Promise<void>}
     */
    abstract push(
        changes: TableChanges<L>,
        ctx?: SyncContext
    ): Promise<void>;

    /**
     * 订阅远程数据变化
     * 
     * @description
     * 监听远端数据源的实时变化。
     * 默认实现不监听任何变化，返回一个空操作的取消订阅对象。
     * 子类可以覆盖此方法以实现具体的订阅逻辑。
     * 
     * @param {SyncContext} [_ctx] - 同步上下文
     * @param {(payload?: unknown) => void} [_onChange] - 变化回调函数
     * @returns {RemoteSubscription} 订阅对象
     * 
     * @example
     * ```typescript
     * // 子类实现示例
     * subscribeToRemoteChanges(ctx, onChange) {
     *   const channel = createRealtimeChannel();
     *   channel.on('change', onChange);
     *   return { unsubscribe: () => channel.close() };
     * }
     * ```
     */
    subscribeToRemoteChanges(
        _ctx?: SyncContext,
        _onChange?: (payload?: unknown) => void
    ): RemoteSubscription {
        // 默认实现：不监听任何变化，返回空操作的取消订阅对象
        return {
            unsubscribe: () => {
                // 空操作：不执行任何内容
            },
        };
    }

    /**
     * 标准化唯一键规范
     *
     * @description
     * 将模型声明的唯一键统一转换成数组形式，便于后续处理。
     *
     * @param {UniqueKeySpec | UniqueKeySpec[] | undefined} uniqueKey - 唯一键规范
     * @returns {UniqueKeySpec[]} 标准化后的唯一键数组
     */
    protected normalizeUniqueSpecs(
        uniqueKey: UniqueKeySpec | UniqueKeySpec[] | undefined
    ): UniqueKeySpec[] {
        if (!uniqueKey) return [];
        return Array.isArray(uniqueKey) ? uniqueKey : [uniqueKey];
    }

    /**
     * 生成远端记录的唯一键
     *
     * @description
     * 根据唯一键规范从远端记录中提取字段值，组合生成唯一键字符串。
     * 如果任何必需字段缺失，会抛出错误。
     *
     * @param {any} row - 远端记录
     * @param {UniqueKeySpec[]} uniqueSpecs - 唯一键规范数组
     * @param {string} remoteTable - 远端表名（用于错误提示）
     * @returns {string} 序列化的唯一键
     * @throws {Error} 当唯一键字段缺失时
     */
    protected getRemoteUniqueKey(
        row: any,
        uniqueSpecs: UniqueKeySpec[],
        remoteTable: string
    ): string {
        const values = uniqueSpecs.map((spec) => {
            const value = extractValueFromPath(row, spec.remote);
            if (value == null) {
                throw new Error(
                    `Remote record ${remoteTable} missing unique key field ${spec.remote}`
                );
            }
            return value;
        });
        return this.serializeUniqueValues(values);
    }

    /**
     * 读取远端记录字段值
     *
     * @description
     * 支持 JSON 路径访问（如 data.id）。
     *
     * @param {any} row - 远端记录
     * @param {string} path - 字段路径
     * @returns {any} 字段值
     */
    protected getRowField(row: any, path: string): any {
        return extractValueFromPath(row, path);
    }

    /**
     * 标准化远端记录的软删除状态
     *
     * @description
     * 检查远端记录是否已软删除，兼容多种常见的软删除字段名。
     * 会依次检查：自定义字段、is_delete、is_deleted、deleted。
     *
     * @param {any} row - 远端记录
     * @param {string} [softDeleteField] - 自定义软删除字段名
     * @returns {boolean} 是否已软删除
     */
    protected normalizeSoftDelete(row: any, softDeleteField?: string): boolean {
        if (row == null) return false;
        const customField = softDeleteField || DEFAULT_SOFT_DELETE_FIELD;
        const candidates = [customField, 'is_delete', 'is_deleted', 'deleted'];
        for (const key of candidates) {
            const val = extractValueFromPath(row, key);
            if (typeof val === 'boolean') return val;
        }
        return false;
    }

    /**
     * 序列化唯一键值数组
     *
     * @description
     * 将唯一键的多个字段值序列化为字符串，用于 Map 索引。
     *
     * @param {any[]} values - 唯一键字段值数组
     * @returns {string} 序列化的唯一键字符串
     */
    protected serializeUniqueValues(values: any[]): string {
        return JSON.stringify(values);
    }
}

// 向后兼容的类型别名
/**
 * @deprecated 使用 SyncAdapter 代替
 */
export type RemoteAdapter<
    L extends LocalRawBase = LocalRawBase,
    R = unknown
> = SyncAdapter<L, R>;

/**
 * @deprecated 使用 BaseSyncAdapter 代替
 */
export const BaseRemoteAdapter = BaseSyncAdapter;
