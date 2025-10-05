/**
 * External dependencies interfaces
 * 
 * @description
 * Define interfaces for external dependencies that users need to provide.
 * This makes the library independent and testable.
 */

/**
 * Logger interface
 * 
 * @description
 * Logging utility that the library uses for debugging and error reporting.
 * Users should provide an implementation compatible with this interface.
 * 
 * @example
 * ```typescript
 * const logger: Logger = {
 *   debug: (...args) => console.debug('[DEBUG]', ...args),
 *   error: (...args) => console.error('[ERROR]', ...args),
 *   warn: (...args) => console.warn('[WARN]', ...args),
 * };
 * ```
 */
export interface Logger {
    debug(...args: any[]): void;
    error(...args: any[]): void;
    warn(...args: any[]): void;
}

/**
 * Supabase client interface
 * 
 * @description
 * Minimal interface required from a Supabase client.
 * Users should provide a Supabase client instance.
 * 
 * @example
 * ```typescript
 * import { createClient } from '@supabase/supabase-js';
 * 
 * const supabase = createClient(
 *   'your-project-url',
 *   'your-anon-key'
 * );
 * ```
 */
export interface SupabaseClient {
    from(table: string): any;
    channel(name: string): any;
    removeChannel(channel: any): void;
}

/**
 * Server time provider interface
 * 
 * @description
 * Provides server timestamp for synchronization.
 * This is used to avoid client-side clock skew issues.
 * 
 * @example
 * ```typescript
 * const timeProvider: TimeProvider = {
 *   getServerTime: async () => {
 *     const response = await fetch('/api/time');
 *     const data = await response.json();
 *     return { timestamp: data.timestamp };
 *   }
 * };
 * ```
 */
export interface TimeProvider {
    getServerTime(): Promise<{ timestamp: number }>;
}

/**
 * Default no-op logger implementation
 * 
 * @description
 * A silent logger that does nothing. Useful for production or testing.
 */
export const noopLogger: Logger = {
    debug: () => {},
    error: () => {},
    warn: () => {},
};

/**
 * Console logger implementation
 * 
 * @description
 * A simple logger that outputs to console. Useful for development.
 */
export const consoleLogger: Logger = {
    debug: (...args: any[]) => console.debug('[watermelondb-sync]', ...args),
    error: (...args: any[]) => console.error('[watermelondb-sync]', ...args),
    warn: (...args: any[]) => console.warn('[watermelondb-sync]', ...args),
};

/**
 * Default time provider using Date.now()
 * 
 * @description
 * A simple time provider that uses local client time.
 * Note: This may cause issues if client clocks are not synchronized.
 * For production, consider using a server-time endpoint.
 */
export const localTimeProvider: TimeProvider = {
    getServerTime: async () => ({ timestamp: Date.now() }),
};
