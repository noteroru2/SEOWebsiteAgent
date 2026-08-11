import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const jobStatus = pgEnum('job_status', [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
]);
export const approvalStatus = pgEnum('approval_status', [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
]);

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const sites = pgTable('sites', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  url: text('url').notNull().unique(),
  active: boolean('active').notNull().default(true),
  ...timestamps,
});
export const siteRepositories = pgTable(
  'site_repositories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    localPath: text('local_path').notNull(),
    defaultBranch: text('default_branch'),
    ...timestamps,
  },
  (t) => [index('site_repositories_site_idx').on(t.siteId)],
);
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id').references(() => sites.id, { onDelete: 'set null' }),
    type: text('type').notNull(),
    status: jobStatus('status').notNull().default('QUEUED'),
    heavy: boolean('heavy').notNull().default(true),
    payload: jsonb('payload').notNull().default({}),
    result: jsonb('result'),
    attemptCount: integer('attempt_count').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    workerId: text('worker_id'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    failureCode: text('failure_code'),
    failureSummary: text('failure_summary'),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [
    index('jobs_claim_idx').on(t.status, t.availableAt, t.createdAt),
    index('jobs_site_idx').on(t.siteId, t.createdAt),
    uniqueIndex('jobs_one_heavy_running_idx')
      .on(t.heavy)
      .where(sql`${t.status} = 'RUNNING' AND ${t.heavy} = true`),
  ],
);
export const jobEvents = pgTable(
  'job_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    detail: jsonb('detail').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('job_events_job_idx').on(t.jobId, t.createdAt)],
);
export const crawlRuns = pgTable(
  'crawl_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    status: text('status').notNull(),
    pagesCrawled: integer('pages_crawled').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('crawl_runs_site_idx').on(t.siteId, t.createdAt)],
);
export const crawlPages = pgTable(
  'crawl_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    crawlRunId: uuid('crawl_run_id')
      .notNull()
      .references(() => crawlRuns.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    statusCode: integer('status_code'),
    title: text('title'),
    metaDescription: text('meta_description'),
    canonicalUrl: text('canonical_url'),
    summary: jsonb('summary').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('crawl_pages_run_url_idx').on(t.crawlRunId, t.url)],
);
export const seoIssues = pgTable(
  'seo_issues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    crawlPageId: uuid('crawl_page_id').references(() => crawlPages.id, { onDelete: 'cascade' }),
    ruleCode: text('rule_code').notNull(),
    severity: text('severity').notNull(),
    title: text('title').notNull(),
    detail: jsonb('detail').notNull().default({}),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('seo_issues_site_resolved_idx').on(t.siteId, t.resolvedAt)],
);
export const opportunities = pgTable(
  'opportunities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    priority: integer('priority').notNull().default(0),
    status: text('status').notNull().default('OPEN'),
    evidence: jsonb('evidence').notNull().default({}),
    ...timestamps,
  },
  (t) => [index('opportunities_site_status_idx').on(t.siteId, t.status, t.priority)],
);
export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id').references(() => sites.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    actionType: text('action_type').notNull(),
    summary: text('summary').notNull(),
    status: approvalStatus('status').notNull().default('PENDING'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('approvals_status_idx').on(t.status, t.createdAt)],
);
export const aiUsage = pgTable(
  'ai_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id').references(() => sites.id, { onDelete: 'set null' }),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costMicros: integer('cost_micros').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ai_usage_created_idx').on(t.createdAt)],
);
export const systemEvents = pgTable(
  'system_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source').notNull(),
    level: text('level').notNull(),
    event: text('event').notNull(),
    detail: jsonb('detail').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('system_events_source_created_idx').on(t.source, t.createdAt)],
);
