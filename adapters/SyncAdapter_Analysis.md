# SyncAdapter 方法分析报告

## 📊 SupabaseAdapter 使用统计

### 直接调用的方法（9个）

| 方法名 | 调用次数 | 调用位置 | 用途 |
|--------|---------|---------|------|
| `getLocalTs()` | 3次 | 102, 376, 559 | 获取本地时间戳用于比较 |
| `getRowField()` | 5次 | 107, 333, 364, 379, 781 | 读取远端字段值 |
| `normalizeUniqueSpecs()` | 2次 | 267, 431 | 标准化唯一键配置 |
| `findLocalByRemoteId()` | 1次 | 280 | 查找本地记录 |
| `getRemoteUniqueKey()` | 1次 | 295 | 生成远端唯一键 |
| `normalizeSoftDelete()` | 1次 | 334 | 判断远端软删除 |
| `getLocalUniqueValue()` | 1次 | 222 | 提取本地唯一键值 |
| `updateDataWithoutSync()` | 1次 | 164 | 避免循环同步 |
| `buildLocalUniqueIndex()` | 1次 | 285 | 构建唯一键索引（super 调用） |

### 间接使用的方法（4个）

| 方法名 | 被谁使用 | 用途 |
|--------|---------|------|
| `readModelField()` | getLocalTs, getLocalUniqueValue, isSoftDeletedLocal | 读取本地字段 |
| `isSoftDeletedLocal()` | buildLocalUniqueIndex | 过滤软删除记录 |
| `getLocalUniqueKey()` | buildLocalUniqueIndex | 生成本地唯一键 |
| `serializeUniqueValues()` | getLocalUniqueKey, getRemoteUniqueKey | 序列化唯一键值 |

---

## ✅ 必须保留的方法

### 1. 抽象接口（2个）
```typescript
abstract pull()  // 必须实现
abstract push()  // 必须实现
```

### 2. 核心属性（1个）
```typescript
protected readonly database: Database  // 数据库实例
```

### 3. 高频使用的工具方法（5个）
```typescript
getLocalTs()               // 使用 3 次，时间戳比较
getRowField()              // 使用 5 次，读取远端字段
normalizeUniqueSpecs()     // 使用 2 次，配置标准化
updateDataWithoutSync()    // 使用 1 次，避免循环同步（关键）
findLocalByRemoteId()      // 使用 1 次，查询本地记录（核心）
```

### 4. 唯一键匹配相关（4个）
```typescript
buildLocalUniqueIndex()    // 构建索引（super 调用）
getLocalUniqueKey()        // 生成本地唯一键（被 buildLocalUniqueIndex 使用）
getRemoteUniqueKey()       // 生成远端唯一键（直接使用）
getLocalUniqueValue()      // 提取唯一键值（直接使用）
```

### 5. 软删除处理（2个）
```typescript
normalizeSoftDelete()      // 判断远端软删除（直接使用）
isSoftDeletedLocal()       // 判断本地软删除（被 buildLocalUniqueIndex 使用）
```

### 6. 字段读取（2个）
```typescript
readModelField()           // 读取本地字段（多处间接使用）
serializeUniqueValues()    // 序列化值（被唯一键方法使用）
```

**小计：16 个方法必须保留**

---

## 🤔 可以考虑优化的方法

### 方案 A：全部保留（推荐）

**理由：**
- ✅ 所有方法都被实际使用（直接或间接）
- ✅ 这些方法形成完整的工具链
- ✅ 保持基类的完整性和易用性
- ✅ 未来其他适配器（如 Firebase、REST API）也会需要

**当前状态：16 个方法，全部有用**

---

### 方案 B：最小化基类（不推荐）

如果极度追求最小化，可以只保留：

```typescript
abstract class BaseSyncAdapter {
    protected readonly database: Database;
    
    // 必须实现
    abstract pull(): Promise<PullResult>;
    abstract push(): Promise<void>;
    
    // 核心工具
    protected updateDataWithoutSync(): Promise<void>;
}
```

其他方法移到：
- 工具函数库（utils）
- SupabaseAdapter 内部私有方法

**缺点：**
- ❌ 未来新适配器需要重复实现
- ❌ 破坏了代码复用
- ❌ 增加每个子类的复杂度
- ❌ 违反 DRY 原则

---

## 💡 推荐的设计

### 保持当前设计（所有 16 个方法）

**原因：**

1. **职责清晰**
   - 本地数据查询：`findLocalByRemoteId`, `buildLocalUniqueIndex`
   - 字段读取：`readModelField`, `getLocalTs`, `getRowField`
   - 唯一键处理：`normalizeUniqueSpecs`, `getLocalUniqueKey`, `getRemoteUniqueKey`
   - 软删除：`isSoftDeletedLocal`, `normalizeSoftDelete`
   - 同步控制：`updateDataWithoutSync`

2. **复用价值高**
   - 未来的适配器（Firebase, REST API, GraphQL）都需要这些功能
   - 避免每个子类重复实现相同逻辑

3. **使用率 100%**
   - 所有方法都在 SupabaseAdapter 中被使用（直接或间接）
   - 没有冗余代码

4. **扩展性好**
   - 子类可以选择性覆盖任何方法
   - 提供了合理的默认实现

---

## 📌 如果必须简化的建议

### 可以考虑重构（而非删除）：

#### 1. 将纯工具方法移到 utils

```typescript
// 移到 utils/fieldAccess.ts
export function readFieldValue(...)
export function extractValueFromPath(...)

// 移到 utils/uniqueKey.ts
export function serializeUniqueValues(...)
```

#### 2. 保留在基类中的核心方法

```typescript
class BaseSyncAdapter {
    // 数据库操作相关（必须保留，因为需要 this.database）
    protected findLocalByRemoteId()
    protected buildLocalUniqueIndex()
    protected updateDataWithoutSync()
    
    // 同步逻辑相关（必须保留，高度业务相关）
    protected normalizeUniqueSpecs()
    protected getLocalUniqueKey()
    protected getRemoteUniqueKey()
    protected getLocalUniqueValue()
    protected getLocalTs()
    protected getRowField()
    protected isSoftDeletedLocal()
    protected normalizeSoftDelete()
    
    // 工具方法（可以调用 utils）
    protected readModelField() { return readFieldValue(...) }
    protected serializeUniqueValues() { return JSON.stringify(...) }
}
```

**结论：即使重构，也只能移出 2 个纯工具方法**

---

## 🎯 最终建议

**保持现状！不需要删除任何方法。**

**理由总结：**
1. ✅ 16 个方法全部被使用
2. ✅ 职责明确，逻辑清晰
3. ✅ 提供完整的同步基础设施
4. ✅ 未来适配器都会需要
5. ✅ 符合"基类提供通用能力"的设计原则

**如果一定要优化，可以：**
- 将 `readModelField` 和 `serializeUniqueValues` 实现改为调用 utils 函数
- 但方法本身应该保留在基类中（因为子类需要用到）

