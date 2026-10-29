import {sqliteTable, text, integer, index} from 'drizzle-orm/sqlite-core';
export const control=sqliteTable('control',{id:integer('id').primaryKey(),token:text('token'),lockedAt:integer('locked_at'),cacheAt:integer('cache_at'),migrationPending:text('migration_pending'),migrationDigest:text('migration_digest'),migrationAt:integer('migration_at'),verifiedAt:integer('verified_at')});
export const ledger=sqliteTable('ledger',{pair:text('pair').primaryKey(),status:text('status').notNull(),descriptionHash:text('description_hash'),createdAt:integer('created_at').notNull(),updatedAt:integer('updated_at').notNull()},t=>[index('idx_ledger_status').on(t.status)]);
export const quota=sqliteTable('quota',{id:text('id').primaryKey(),kind:text('kind').notNull(),at:integer('at').notNull()},t=>[index('idx_quota_kind_at').on(t.kind,t.at)]);
export const cache=sqliteTable('parcel_cache',{pair:text('pair').primaryKey(),descriptionHash:text('description_hash'),statusCode:integer('status_code'),isActive:integer('is_active'),expectedDelivery:text('expected_delivery'),latestEvent:text('latest_event')});

export const briefLabels=sqliteTable('brief_labels',{pair:text('pair').primaryKey(),descriptionHash:text('description_hash').notNull(),company:text('company').notNull(),item:text('item'),attestedAt:integer('attested_at').notNull()});

export const discoveryProgress=sqliteTable('discovery_progress',{id:integer('id').primaryKey(),revision:integer('revision').notNull(),stateJson:text('state_json').notNull(),operationId:text('operation_id').notNull(),updatedAt:text('updated_at').notNull()});
export const discoveryAudit=sqliteTable('discovery_audit',{operationId:text('operation_id').primaryKey(),runId:text('run_id').notNull(),requestHash:text('request_hash').notNull(),revision:integer('revision').notNull(),oldWatermark:text('old_watermark'),newWatermark:text('new_watermark').notNull(),operation:text('operation').notNull(),at:text('at').notNull()});

export const summaryRefresh=sqliteTable('summary_refresh',{id:integer('id').primaryKey(),failures:integer('failures').notNull(),retryAt:integer('retry_at'),lastError:text('last_error'),lastAttemptAt:integer('last_attempt_at')});
