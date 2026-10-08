import {sqliteTable, text, integer, index} from 'drizzle-orm/sqlite-core';
export const control=sqliteTable('control',{id:integer('id').primaryKey(),token:text('token'),lockedAt:integer('locked_at'),cacheAt:integer('cache_at'),migrationPending:text('migration_pending'),migrationDigest:text('migration_digest'),migrationAt:integer('migration_at'),verifiedAt:integer('verified_at')});
export const ledger=sqliteTable('ledger',{pair:text('pair').primaryKey(),status:text('status').notNull(),descriptionHash:text('description_hash'),createdAt:integer('created_at').notNull(),updatedAt:integer('updated_at').notNull()},t=>[index('idx_ledger_status').on(t.status)]);
export const quota=sqliteTable('quota',{id:text('id').primaryKey(),kind:text('kind').notNull(),at:integer('at').notNull()},t=>[index('idx_quota_kind_at').on(t.kind,t.at)]);
export const cache=sqliteTable('parcel_cache',{pair:text('pair').primaryKey(),descriptionHash:text('description_hash')});
