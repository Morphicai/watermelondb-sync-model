# WatermelonDB Sync Model

A powerful bidirectional synchronization library for [WatermelonDB](https://watermelondb.dev/) with [Supabase](https://supabase.com/) backend support. Designed for offline-first React Native and web applications.

## Features

✨ **Bidirectional Sync** - Seamlessly sync data between local WatermelonDB and remote Supabase  
🔄 **Auto-sync** - Automatic synchronization with debouncing and smart conflict resolution  
📡 **Real-time Updates** - Subscribe to remote changes via Supabase Realtime  
🎯 **Multi-tenant Support** - Built-in user/tenant data isolation  
🔌 **Pluggable Architecture** - Bring your own logger, time provider, and more  
⚡ **Optimized Performance** - Efficient incremental sync with pagination  
🛡️ **Type-safe** - Written in TypeScript with full type definitions  

## Installation

```bash
npm install watermelondb-sync-model
# or
yarn add watermelondb-sync-model
# or
pnpm add watermelondb-sync-model
```

### Peer Dependencies

This library requires the following peer dependencies:

```bash
npm install @nozbe/watermelondb @supabase/supabase-js
```

## Quick Start

### 1. Define Your Sync Model

```typescript
import { Model } from '@nozbe/watermelondb';
import { SyncModel, SyncContext } from 'watermelondb-sync-model';

// Define your remote row type
interface RemoteTask {
  id: string;
  title: string;
  user_id: string;
  updated_at: string;
  is_deleted: boolean;
}

// Define your local raw type
interface LocalTaskRaw {
  id: string;
  title: string;
  remote_id: string;
  user_id: string;
  updated_at: number;
}

export class Task extends SyncModel<LocalTaskRaw, RemoteTask> {
  // WatermelonDB table name
  static table = 'tasks';
  
  // Remote Supabase table name
  static remoteTable = 'tasks';
  
  // Sync keys configuration
  static syncKeys = {
    remotePk: 'id',
    localRemoteId: 'remote_id',
    uniqueKey: {
      local: 'title',
      remote: 'title'
    }
  };
  
  // Timestamp fields for sync
  static syncTimestamps = {
    local: 'updated_at',
    remote: 'updated_at'
  };
  
  // Multi-tenant scope (optional)
  static scope = {
    userField: 'user_id'
  };
  
  // Soft delete field (optional, defaults to 'is_deleted')
  static softDeleteField = 'is_deleted';
  
  // Convert remote data to local format
  static remoteToLocal(row: RemoteTask, ctx: SyncContext): LocalTaskRaw {
    return {
      id: row.id,
      title: row.title,
      remote_id: row.id,
      user_id: row.user_id,
      updated_at: Date.parse(row.updated_at),
    };
  }
  
  // Convert local data to remote format
  localToRemote(ctx: SyncContext): Partial<RemoteTask> {
    return {
      id: this.remoteId,
      title: this.title,
      user_id: ctx.userId,
      updated_at: new Date(this.updatedAt).toISOString(),
    };
  }
  
  // Define your model fields
  @field('title') title!: string;
  @field('remote_id') remoteId!: string;
  @field('user_id') userId!: string;
  @field('updated_at') updatedAt!: number;
}
```

### 2. Initialize Sync Manager

```typescript
import { Database } from '@nozbe/watermelondb';
import { createClient } from '@supabase/supabase-js';
import { DataSyncManager, consoleLogger } from 'watermelondb-sync-model';
import { Task } from './models/Task';

// Initialize Supabase
const supabase = createClient(
  'YOUR_SUPABASE_URL',
  'YOUR_SUPABASE_ANON_KEY'
);

// Create sync manager
const syncManager = new DataSyncManager(
  database,
  [Task], // Register your sync models
  {
    debounceMs: 3000, // Auto-sync debounce time
    logger: consoleLogger, // Or use noopLogger for production
    timeProvider: {
      getServerTime: async () => {
        // Optionally fetch server time to avoid clock skew
        const response = await fetch('/api/time');
        const data = await response.json();
        return { timestamp: data.timestamp };
      }
    }
  }
);

// Start sync with auto-sync enabled
await syncManager.start(
  { userId: 'user-123' }, // Sync context
  { auto: true } // Enable auto-sync on local changes
);

// Optionally enable real-time remote sync
syncManager.startRemoteSubscriptions();
```

### 3. Configure Supabase Adapter

The Supabase adapter needs to be configured in your model:

```typescript
import { Database } from '@nozbe/watermelondb';
import { SupabaseAdapter, SyncContext } from 'watermelondb-sync-model';
import { supabase } from './supabase'; // Your Supabase client
import { logger } from './logger'; // Your logger instance

export class Task extends SyncModel<LocalTaskRaw, RemoteTask> {
  // ... other static properties ...
  
  protected static createAdapter(
    database: Database,
    ModelCtor: any,
    defaultCtx?: SyncContext
  ) {
    return new SupabaseAdapter(database, ModelCtor, {
      supabase,
      logger,
      defaultCtx
    });
  }
}
```

## API Reference

### DataSyncManager

The main synchronization coordinator.

#### Constructor

```typescript
new DataSyncManager(
  database: Database,
  models: SyncModelCtor<any>[],
  options?: {
    debounceMs?: number;      // Default: 3000
    logger?: Logger;          // Default: noopLogger
    timeProvider?: TimeProvider; // Default: localTimeProvider
  }
)
```

#### Methods

- `start(ctx?, options?)` - Start the sync manager
- `stop()` - Stop all sync operations
- `syncNow(ctx?)` - Trigger immediate sync
- `startRemoteSubscriptions()` - Enable real-time remote sync
- `stopRemoteSubscriptions()` - Disable real-time remote sync
- `getState()` - Get current manager state
- `on(handler)` - Subscribe to sync events

#### Events

```typescript
syncManager.on((event) => {
  switch (event.type) {
    case 'pulled':
      console.log('Pulled changes:', event.detail);
      break;
    case 'pushed':
      console.log('Pushed changes:', event.detail);
      break;
    case 'error':
      console.error('Sync error:', event.detail);
      break;
    case 'state':
      console.log('State changed:', event.detail);
      break;
    case 'remoteChanged':
      console.log('Remote data changed:', event.detail);
      break;
  }
});
```

### SyncModel

Base class for all synchronized models.

#### Static Properties

- `remoteTable: string` - Remote table name
- `syncKeys: SyncKeysSpec` - Primary key and unique key mapping
- `syncTimestamps: SyncTimestampsSpec` - Timestamp field mapping
- `scope?: SyncScopeSpec` - Multi-tenant scope configuration
- `softDeleteField?: string` - Soft delete field name
- `label?: string` - Human-readable model name

#### Static Methods

- `remoteToLocal(row, ctx)` - Convert remote data to local format
- `createAdapter(database, ModelCtor, defaultCtx?)` - Create sync adapter

#### Instance Methods

- `localToRemote(ctx)` - Convert local data to remote format
- `shouldSyncLocal?(ctx)` - Filter records before push (optional)

### Logger Interface

```typescript
interface Logger {
  debug(...args: any[]): void;
  error(...args: any[]): void;
  warn(...args: any[]): void;
}
```

Built-in implementations:
- `noopLogger` - Silent logger (default)
- `consoleLogger` - Console output logger

### TimeProvider Interface

```typescript
interface TimeProvider {
  getServerTime(): Promise<{ timestamp: number }>;
}
```

Built-in implementation:
- `localTimeProvider` - Uses `Date.now()` (default)

## Advanced Usage

### Custom Conflict Resolution

The library automatically handles conflicts by comparing timestamps. Records with newer `updated_at` values take precedence.

### Unique Key Matching

For first-time sync, you can use unique keys to match existing records:

```typescript
static syncKeys = {
  remotePk: 'id',
  localRemoteId: 'remote_id',
  uniqueKey: [
    { local: 'email', remote: 'email' },
    { local: 'username', remote: 'username' }
  ]
};
```

### Conditional Sync

Filter which records should be synced:

```typescript
async shouldSyncLocal(ctx: SyncContext): Promise<boolean> {
  // Only sync if record belongs to current user
  return this.userId === ctx.userId;
}
```

### Custom Adapter

Extend `BaseSyncAdapter` to create adapters for other backends:

```typescript
import { BaseSyncAdapter } from 'watermelondb-sync-model';

export class CustomAdapter extends BaseSyncAdapter {
  async pull(lastPulledAt, ctx) {
    // Implement pull logic
  }
  
  async push(changes, ctx) {
    // Implement push logic
  }
  
  subscribeToRemoteChanges(ctx, onChange) {
    // Implement real-time subscription
    return { unsubscribe: () => {} };
  }
}
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     DataSyncManager                         │
│  • Coordinates sync cycles                                  │
│  • Manages auto-sync and debouncing                         │
│  • Handles remote subscriptions                             │
└─────────────┬───────────────────────────────────────────────┘
              │
              ├─► AutoSyncController (watches local DB)
              │
              ├─► SyncEventBus (event coordination)
              │
              └─► SyncAdapter (per model)
                  │
                  ├─► SupabaseAdapter
                  │   • Queries Supabase
                  │   • Handles real-time
                  │   • Converts data formats
                  │
                  └─► LocalDataAccessor
                      • Queries WatermelonDB
                      • Manages unique indexes
                      • Handles soft deletes
```

## Best Practices

1. **Enable RLS (Row Level Security)** on Supabase tables for security
2. **Use server time provider** in production to avoid clock skew
3. **Set appropriate debounce times** based on your use case
4. **Monitor sync events** for debugging and analytics
5. **Handle offline scenarios** gracefully in your UI
6. **Test conflict scenarios** thoroughly

## Troubleshooting

### Sync loops

If you experience infinite sync loops:
- Ensure timestamps are properly synchronized
- Check that `updated_at` is updated correctly on both sides
- Verify RLS policies don't prevent reading your own writes

### Missing data

If data doesn't sync:
- Check RLS policies on Supabase
- Verify `scope.userField` configuration
- Ensure `remoteToLocal` returns all required fields
- Check for errors in sync event logs

### Performance issues

For large datasets:
- Implement pagination in custom adapters
- Use appropriate indexes on timestamp fields
- Consider batching operations
- Monitor network requests

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Acknowledgments

- Built on top of [WatermelonDB](https://watermelondb.dev/)
- Designed for [Supabase](https://supabase.com/) backend
- Inspired by offline-first architecture principles
