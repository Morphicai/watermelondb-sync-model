export function parseTimestamp(value: unknown): number | undefined {
    if (value == null) return undefined;
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : undefined;
    }
    if (value instanceof Date) {
        const ms = value.getTime();
        return Number.isFinite(ms) ? ms : undefined;
    }
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : undefined;
}


