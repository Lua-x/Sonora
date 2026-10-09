import { pgTable, text, integer, bigint, boolean, timestamp, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';
import type { ListeningEvent, UserSettings, SourceKind } from './types';
export const users = pgTable('users', {
  id: integer('id').primaryKey(), passwordHash: text('password_hash').notNull(),
  settings: jsonb('settings').$type<UserSettings>().notNull(),
});
export const sessions = pgTable('sessions', {
  tokenHash: text('token_hash').primaryKey(), expiresAt: timestamp('expires_at', {withTimezone:true,mode:'string'}).notNull(),
});
export const authAttempts = pgTable('auth_attempts', {
  key: text('key').primaryKey(), count: integer('count').notNull(), resetsAt: timestamp('resets_at',{withTimezone:true,mode:'string'}).notNull(),
});
export const sources = pgTable('sources', {
  id: text('id').primaryKey(), kind: text('kind').$type<SourceKind>().notNull(), label: text('label').notNull(),
  username: text('username'), secret: text('secret'), enabled: boolean('enabled').notNull().default(true),
  intervalMinutes: integer('interval_minutes').notNull().default(30),
  lastSuccessAt: timestamp('last_success_at',{withTimezone:true,mode:'string'}),
  nextSyncAt: timestamp('next_sync_at',{withTimezone:true,mode:'string'}),
  coverageNote: text('coverage_note').notNull().default('Die Vollständigkeit des Verlaufs ist nicht bestätigt.'),
  error: text('error'), nowPlaying: jsonb('now_playing').$type<ListeningEvent[]>().notNull().default([]),
});
export const events = pgTable('events', {
  id: text('id').primaryKey(), sourceId: text('source_id').notNull().references(()=>sources.id,{onDelete:'cascade'}),
  sourceKind: text('source_kind').$type<SourceKind>().notNull(), externalId: text('external_id').notNull(),
  playedAt: timestamp('played_at',{withTimezone:true,mode:'string'}).notNull(), artist: text('artist').notNull(), track: text('track').notNull(),
  album: text('album'), durationMs: bigint('duration_ms',{mode:'number'}), durationKind: text('duration_kind').$type<'measured'|'estimated'>(),
  tags: jsonb('tags').$type<string[]>().notNull().default([]),
}, table=>[uniqueIndex('events_source_external_idx').on(table.sourceId,table.externalId)]);
export interface JobPayload { previewEvents?: ListeningEvent[]; previewGroupId?:string; retryAt?:string; cursor?: string|null; since?: string|null; processed?: number; inserted?: number; }
export const jobs = pgTable('jobs', {
  id:text('id').primaryKey(), type:text('type').$type<'sync'|'import'>().notNull(),
  sourceId:text('source_id').notNull().references(()=>sources.id,{onDelete:'cascade'}),
  status:text('status').$type<'preview'|'queued'|'running'|'complete'|'failed'>().notNull(),
  payload:jsonb('payload').$type<JobPayload>().notNull().default({}), progress:integer('progress').notNull().default(0),
  error:text('error'), createdAt:timestamp('created_at',{withTimezone:true,mode:'string'}).notNull(),
  updatedAt:timestamp('updated_at',{withTimezone:true,mode:'string'}).notNull(),
});
export const system = pgTable('system', {key:text('key').primaryKey(), value:text('value').notNull()});
