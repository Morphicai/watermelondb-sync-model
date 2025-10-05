# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2025-10-05

### Added
- 🎉 Initial open source release
- Complete TypeScript implementation with full type definitions
- Bidirectional sync between WatermelonDB and Supabase
- Auto-sync with debouncing and conflict resolution
- Real-time remote change subscriptions via Supabase Realtime
- Multi-tenant data isolation support
- Pluggable architecture for logger and time provider
- Comprehensive documentation and examples
- MIT License

### Changed
- **BREAKING**: Removed hard-coded external dependencies
  - `supabase` client must now be passed to `SupabaseAdapter` constructor
  - `logger` is now optional and configurable (defaults to `noopLogger`)
  - `timeProvider` is now optional and configurable (defaults to `localTimeProvider`)
- **BREAKING**: `SupabaseAdapter` constructor now requires options object with `supabase` client
- **BREAKING**: `DataSyncManager` constructor now accepts `logger` and `timeProvider` in options
- **BREAKING**: `AutoSyncController` constructor now requires `logger` parameter
- **BREAKING**: `subscribeToRemoteChanges` deprecated function signature changed to require `supabaseClient` as first parameter

### Removed
- Removed all hard-coded imports to external modules (`@/lib/supabase`, `@/lib/log`, `@/api/serverTime`)
- Removed all `debugger` statements
- Removed all `console.log` debug statements
- Removed unused `localModelMap` property from `SupabaseAdapter`

### Fixed
- Fixed linter errors and TypeScript strict mode compliance
- Fixed deprecated function type safety issues

### Documentation
- Added comprehensive README with usage examples
- Added TSDoc comments throughout the codebase
- Added architecture diagram and best practices
- Added troubleshooting guide

## Migration Guide

### From internal version to v1.0.0

If you were using an internal version of this library, here's how to migrate:

#### 1. Install the package

```bash
npm install watermelondb-sync-model
```

#### 2. Update your imports

```typescript
// Before
import { DataSyncManager } from './lib/sync/DataSyncManager';

// After
import { DataSyncManager } from 'watermelondb-sync-model';
```

#### 3. Provide Supabase client to adapters

```typescript
// Before
export class Task extends SyncModel {
  // Adapter automatically used global supabase instance
}

// After
import { supabase } from './supabase'; // Your Supabase client
import { logger } from './logger'; // Your logger instance

export class Task extends SyncModel {
  protected static createAdapter(database, ModelCtor, defaultCtx) {
    return new SupabaseAdapter(database, ModelCtor, {
      supabase,
      logger,
      defaultCtx
    });
  }
}
```

#### 4. Update DataSyncManager initialization

```typescript
// Before
const syncManager = new DataSyncManager(database, [Task]);

// After
import { consoleLogger } from 'watermelondb-sync-model';

const syncManager = new DataSyncManager(database, [Task], {
  logger: consoleLogger, // or your custom logger
  timeProvider: {
    getServerTime: async () => {
      const response = await fetch('/api/time');
      const data = await response.json();
      return { timestamp: data.timestamp };
    }
  }
});
```

#### 5. Update deprecated function calls

```typescript
// Before
import { subscribeToRemoteChanges } from './adapters/SupabaseAdapter';
const sub = subscribeToRemoteChanges([Task], ctx, onChange);

// After - Option 1 (Recommended)
const adapter = Task.createAdapter(database, Task, ctx);
const sub = adapter.subscribeToRemoteChanges(ctx, onChange);

// After - Option 2 (If you must use the deprecated function)
import { subscribeToRemoteChanges } from 'watermelondb-sync-model';
const sub = subscribeToRemoteChanges(supabase, [Task], ctx, onChange);
```
