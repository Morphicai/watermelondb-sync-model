let suppressionDepth = 0;

/**
 * Run a function with suppression enabled
 * Only increments the counter, does not decrement
 */
export function runSuppressed<T>(fn: () => Promise<T>): Promise<T> {
    suppressionDepth += 1;
    return fn();
}

/**
 * Check and decrement the suppression counter
 * Returns true if the counter was 0 before decrementing, false otherwise
 */
export function checkAndDecrement(): boolean {
    const wasZero = suppressionDepth <= 0;
    suppressionDepth = Math.max(0, suppressionDepth - 1);
    return wasZero;
}
