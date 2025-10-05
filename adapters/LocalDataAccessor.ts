import { Q, Database } from '@nozbe/watermelondb';
import type {
    SyncContext,
    SyncModelCtor,
    SyncModel,
    LocalRawBase,
    UniqueKeySpec,
} from '../SyncModel';
import { runSuppressed } from '../SuppressionCounter';
import { DEFAULT_SOFT_DELETE_FIELD } from '../constants';
import { readFieldValue } from '../utils/format';

/**
 * 本地数据访问器
 *
 * @description
 * 负责本地 WatermelonDB 数据库的所有操作，包括：
 * - 根据远端 ID 查找本地记录
 * - 构建和管理唯一键索引
 * - 读取和解析本地字段值
 * - 判断软删除状态
 * - 执行数据更新操作
 * 
 * 该类与特定的 Model 绑定，封装了所有本地数据访问逻辑。
 *
 * @template L - 本地原始数据类型
 * @template R - 远端数据类型
 */
export class LocalDataAccessor<
    L extends LocalRawBase = LocalRawBase,
    R = unknown
> {
    /** WatermelonDB 数据库实例 */
    protected readonly database: Database;

    /** 绑定的模型构造函数 */
    protected readonly ModelCtor: SyncModelCtor<SyncModel<L, R>>;

    /**
     * 构造函数
     *
     * @param {Database} database - WatermelonDB 数据库实例
     * @param {SyncModelCtor<SyncModel<L, R>>} ModelCtor - 模型构造函数
     */
    constructor(database: Database, ModelCtor: SyncModelCtor<SyncModel<L, R>>) {
        this.database = database;
        this.ModelCtor = ModelCtor;
    }

    /**
     * 根据远端 ID 查找本地记录
     *
     * @description
     * 在本地数据库中根据远端 ID 查找对应的记录。
     *
     * @param {string} localRemoteIdKey - 本地存储远端 ID 的字段名
     * @param {string} remoteIdValue - 远端 ID 值
     * @returns {Promise<any | null>} 找到的记录，未找到返回 null
     */
    async findByRemoteId(
        localRemoteIdKey: string,
        remoteIdValue: string
    ): Promise<any | null> {
        if (!remoteIdValue) return null;
        return this.ModelCtor.findLocalByRemoteId(
            this.database,
            localRemoteIdKey,
            remoteIdValue
        );
    }

    /**
     * 构建本地唯一键索引
     *
     * @description
     * 扫描本地数据库，为所有记录构建唯一键索引（Map）。
     * 跳过已软删除的记录，如果发现唯一键缺失或冲突则抛出错误。
     *
     * @param {UniqueKeySpec[]} uniqueSpecs - 唯一键规范数组
     * @param {(record: any, uniqueSpecs: UniqueKeySpec[]) => string} getUniqueKeyFn - 生成唯一键的函数
     * @param {SyncContext} [ctx] - 同步上下文
     * @param {string} [userField] - 用户字段名，用于多租户过滤
     * @param {string} [softDeleteField] - 软删除字段名
     * @returns {Promise<Map<string, any>>} 唯一键到记录的映射
     */
    async buildUniqueIndex(
        uniqueSpecs: UniqueKeySpec[],
        getUniqueKeyFn: (record: any, uniqueSpecs: UniqueKeySpec[]) => string,
        ctx?: SyncContext,
        userField?: string,
        softDeleteField?: string
    ): Promise<Map<string, any>> {
        const collection = this.database.get<any>(this.ModelCtor.table);
        const conditions: any[] = [];
        if (userField && ctx?.userId) {
            conditions.push(Q.where(userField, ctx.userId));
        }
        const query =
            conditions.length > 0
                ? collection.query(...conditions)
                : collection.query();
        const records = await query.fetch();
        const index = new Map<string, any>();
        for (const record of records) {
            if (this.isSoftDeleted(record, softDeleteField)) continue;
            const key = getUniqueKeyFn(record, uniqueSpecs);
            if (index.has(key)) {
                throw new Error(
                    `Local unique key duplicated for ${this.ModelCtor.table}: ${key}`
                );
            }
            index.set(key, record);
        }
        return index;
    }

    /**
     * 生成本地记录的唯一键
     *
     * @description
     * 根据唯一键规范从本地记录中提取字段值，组合生成唯一键字符串。
     * 如果任何必需字段缺失，会抛出错误。
     *
     * @param {any} record - 本地记录
     * @param {UniqueKeySpec[]} uniqueSpecs - 唯一键规范数组
     * @param {(values: any[]) => string} serializeFn - 序列化函数
     * @returns {string} 序列化的唯一键
     * @throws {Error} 当唯一键字段缺失时
     */
    getUniqueKey(
        record: any,
        uniqueSpecs: UniqueKeySpec[],
        serializeFn: (values: any[]) => string
    ): string {
        const values = uniqueSpecs.map((spec) => {
            const value = this.getUniqueValue(record, spec.local);
            if (value == null) {
                throw new Error(
                    `Local record ${this.ModelCtor.table}:${
                        record?.id ?? 'unknown'
                    } missing unique key field ${spec.local}`
                );
            }
            return value;
        });
        return serializeFn(values);
    }

    /**
     * 读取本地记录字段值
     *
     * @description
     * 支持 snake_case 和 camelCase 字段名自动转换。
     *
     * @param {any} record - 本地记录
     * @param {string} fieldName - 字段名
     * @returns {any} 字段值
     */
    readField(record: any, fieldName: string): any {
        return readFieldValue(record, fieldName);
    }

    /**
     * 获取本地记录的更新时间戳
     *
     * @description
     * 将本地记录的更新时间统一转换为毫秒时间戳。
     * 支持 number、string、Date 类型的时间值。
     *
     * @param {any} localRecord - 本地记录
     * @param {string} localUpdatedAt - 更新时间字段名
     * @returns {number} 毫秒时间戳，无效值返回 0
     */
    getTimestamp(localRecord: any, localUpdatedAt: string): number {
        const v = this.readField(localRecord, localUpdatedAt);
        if (v == null) return 0;
        if (typeof v === 'number') return v;
        if (typeof v === 'string') return Number(v) || 0;
        if (v instanceof Date) return v.getTime();
        return 0;
    }

    /**
     * 解析本地唯一键字段值
     *
     * @description
     * 支持嵌套 JSON 路径（如 data.id）。
     * 如果字段值是 JSON 字符串，会自动解析。
     *
     * @param {any} record - 本地记录
     * @param {string} localPath - 字段路径
     * @returns {any} 字段值，路径无效返回 undefined
     */
    getUniqueValue(record: any, localPath: string): any {
        if (!localPath.includes('.')) {
            return this.readField(record, localPath);
        }
        const [first, ...rest] = localPath.split('.');
        let container: any = this.readField(record, first);
        if (container == null) return undefined;
        if (typeof container === 'string') {
            try {
                container = JSON.parse(container);
            } catch {
                return undefined;
            }
        }
        for (const seg of rest) {
            if (container == null) return undefined;
            container = container[seg];
        }
        return container;
    }

    /**
     * 判断本地记录是否已软删除
     *
     * @description
     * 检查本地记录的软删除标记字段。
     *
     * @param {any} record - 本地记录
     * @param {string} [softDeleteField] - 软删除字段名，未指定则使用默认值
     * @returns {boolean} 是否已软删除
     */
    isSoftDeleted(record: any, softDeleteField?: string): boolean {
        const field = softDeleteField || DEFAULT_SOFT_DELETE_FIELD;
        const value = this.readField(record, field);
        return value === true;
    }

    /**
     * 执行数据更新操作且不触发同步
     *
     * @description
     * 在抑制同步的上下文中执行数据更新操作，避免触发循环同步。
     *
     * @param {() => any} fn - 要执行的函数
     * @returns {Promise<any>} 函数执行结果
     */
    updateWithoutSync(fn: () => any): Promise<any> {
        return runSuppressed(fn);
    }
}

