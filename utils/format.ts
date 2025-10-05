/**
 * 安全的 JSON 序列化
 *
 * @description
 * 将任意值安全地转换为 JSON 字符串。
 * 如果序列化失败，返回字符串形式。支持长度截断。
 *
 * @param {unknown} value - 要序列化的值
 * @param {Object} [options] - 选项
 * @param {number} [options.maxLength] - 最大长度，超出部分用省略号截断
 * @returns {string} JSON 字符串
 */
export function safeJson(value: unknown, options?: { maxLength?: number }): string {
    try {
        const json = JSON.stringify(value);
        if (!options?.maxLength) return json;
        return json && json.length > options.maxLength
            ? `${json.slice(0, options.maxLength)}…`
            : json;
    } catch {
        return String(value);
    }
}

/**
 * 转换为驼峰命名
 *
 * @description
 * 将 snake_case 字符串转换为 camelCase。
 * 如果字符串不包含下划线，直接返回原字符串。
 *
 * @param {string} name - 输入字符串
 * @returns {string} 驼峰命名字符串
 *
 * @example
 * toCamelCase('user_id') // 'userId'
 * toCamelCase('updated_at') // 'updatedAt'
 */
export function toCamelCase(name: string): string {
    if (!name.includes('_')) return name;
    return name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * 转换为蛇形命名
 *
 * @description
 * 将 camelCase 字符串转换为 snake_case。
 * 如果字符串不包含大写字母，直接返回原字符串。
 *
 * @param {string} name - 输入字符串
 * @returns {string} 蛇形命名字符串
 *
 * @example
 * toSnakeCase('userId') // 'user_id'
 * toSnakeCase('updatedAt') // 'updated_at'
 */
export function toSnakeCase(name: string): string {
    if (!/[A-Z]/.test(name)) return name;
    return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/**
 * 读取记录字段值
 *
 * @description
 * 从记录中读取字段值，支持 snake_case 和 camelCase 自动转换。
 * 查找优先级：原始字段名 -> camelCase -> snake_case。
 *
 * @param {any} record - 记录对象
 * @param {string} fieldName - 字段名
 * @returns {any} 字段值，未找到返回 undefined
 *
 * @example
 * readFieldValue({ user_id: 1 }, 'userId') // 1
 * readFieldValue({ userId: 1 }, 'user_id') // 1
 */
export function readFieldValue(record: any, fieldName: string): any {
    if (!record) return undefined;
    if (fieldName in record) return record[fieldName];
    const camel = toCamelCase(fieldName);
    if (camel in record) return record[camel];
    const snake = toSnakeCase(fieldName);
    if (snake in record) return record[snake];
    return undefined;
}

/**
 * 从路径提取值
 *
 * @description
 * 支持简单字段名和点分隔的 JSON 路径（如 data.id）。
 * 对于简单字段名，支持 snake_case 和 camelCase 互转。
 * 对于 JSON 路径，会自动解析字符串类型的 JSON 容器。
 *
 * @param {any} row - 数据对象
 * @param {string} path - 字段路径
 * @returns {any} 提取的值，路径无效返回 undefined
 *
 * @example
 * extractValueFromPath({ user_id: 1 }, 'userId') // 1
 * extractValueFromPath({ data: { id: 1 } }, 'data.id') // 1
 * extractValueFromPath({ data: '{"id": 1}' }, 'data.id') // 1 (自动解析 JSON)
 */
export function extractValueFromPath(row: any, path: string): any {
    if (!row) return undefined;
    if (!path.includes('.')) {
        if (path in row) return row[path];
        const alt = path.includes('_') ? toCamelCase(path) : toSnakeCase(path);
        return row[alt];
    }
    const [first, ...rest] = path.split('.');
    let container: any = row[first];
    for (const seg of rest) {
        if (container == null) return undefined;
        if (typeof container === 'string') {
            try {
                container = JSON.parse(container);
            } catch {
                return undefined;
            }
        }
        container = container?.[seg];
    }
    return container;
}


