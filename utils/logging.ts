import type { Logger } from '../types';
import { safeJson } from './format';

const MAX_LOG_LENGTH = 500;

export function logRemoteToLocalResult(
    logger: Logger,
    label: string,
    changes: { created?: unknown[]; updated?: unknown[]; deleted?: unknown[] } | undefined,
    lastPulledAt: number | null | undefined
): void {
    if (!changes) return;
    try {
        const previewCreated = safeJson(changes.created?.slice(0, 1), { maxLength: MAX_LOG_LENGTH });
        const previewUpdated = safeJson(changes.updated?.slice(0, 1), { maxLength: MAX_LOG_LENGTH });
        logger.debug('[sync][pull] remoteToLocal', {
            label,
            lastPulledAt,
            created: changes.created?.length ?? 0,
            updated: changes.updated?.length ?? 0,
            deleted: changes.deleted?.length ?? 0,
            sampleCreated: previewCreated,
            sampleUpdated: previewUpdated,
        });
    } catch (err) {
        logger.error('[sync][pull] remoteToLocal log error', err);
    }
}

export function logLocalToRemotePayload(
    logger: Logger,
    label: string,
    payload: unknown,
    opts: {
        direction: 'create' | 'update';
        remoteId?: string | number | null;
    }
): void {
    try {
        logger.debug('[sync][push] localToRemote', {
            label,
            direction: opts.direction,
            remoteId: opts.remoteId,
            payload: safeJson(payload, { maxLength: MAX_LOG_LENGTH }),
        });
    } catch (err) {
        logger.error('[sync][push] localToRemote log error', err);
    }
}


