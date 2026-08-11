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
  crawlEnabled: boolean('crawl_enabled').notNull().default(true),
  maxPages: integer('max_pages').notNull().default(500),
  crawlDelayMs: integer('crawl_delay_ms').notNull().default(300),
  requestTimeoutMs: integer('request_timeout_ms').notNull().default(10000),
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
    cancellationRequestedAt: timestamp('cancellation_requested_at', { withTimezone: true }),
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
    pagesDiscovered: integer('pages_discovered').notNull().default(0),
    pagesRequested: integer('pages_requested').notNull().default(0),
    pagesSucceeded: integer('pages_succeeded').notNull().default(0),
    pagesFailed: integer('pages_failed').notNull().default(0),
    pagesIndexable: integer('pages_indexable').notNull().default(0),
    pagesNonIndexable: integer('pages_non_indexable').notNull().default(0),
    issuesFound: integer('issues_found').notNull().default(0),
    durationMs: integer('duration_ms'),
    failureCode: text('failure_code'),
    failureSummary: text('failure_summary'),
    robotsMeta: jsonb('robots_meta').notNull().default({}),
    summary: jsonb('summary').notNull().default({}),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('crawl_runs_site_idx').on(t.siteId, t.createdAt),
    index('crawl_runs_site_status_idx').on(t.siteId, t.status, t.createdAt),
  ],
);
export const crawlPages = pgTable(
  'crawl_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    crawlRunId: uuid('crawl_run_id')
      .notNull()
      .references(() => crawlRuns.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    finalUrl: text('final_url'),
    statusCode: integer('status_code'),
    redirectCount: integer('redirect_count').notNull().default(0),
    contentType: text('content_type'),
    responseBytes: integer('response_bytes'),
    responseTimeMs: integer('response_time_ms'),
    title: text('title'),
    titleLength: integer('title_length'),
    metaDescription: text('meta_description'),
    descriptionLength: integer('description_length'),
    h1Count: integer('h1_count').notNull().default(0),
    primaryH1: text('primary_h1'),
    h2Count: integer('h2_count').notNull().default(0),
    canonicalUrl: text('canonical_url'),
    canonicalCount: integer('canonical_count').notNull().default(0),
    robotsMeta: text('robots_meta'),
    xRobotsTag: text('x_robots_tag'),
    indexable: boolean('indexable').notNull().default(false),
    indexabilityReasons: jsonb('indexability_reasons').notNull().default([]),
    wordCount: integer('word_count').notNull().default(0),
    internalLinksCount: integer('internal_links_count').notNull().default(0),
    externalLinksCount: integer('external_links_count').notNull().default(0),
    nofollowInternalCount: integer('nofollow_internal_count').notNull().default(0),
    contentHash: text('content_hash'),
    crawlDepth: integer('crawl_depth').notNull().default(0),
    discoverySource: text('discovery_source').notNull().default('LINK'),
    inSitemap: boolean('in_sitemap').notNull().default(false),
    language: text('language'),
    viewportPresent: boolean('viewport_present').notNull().default(false),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }),
    fetchErrorCode: text('fetch_error_code'),
    summary: jsonb('summary').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('crawl_pages_run_url_idx').on(t.crawlRunId, t.url),
    index('crawl_pages_run_status_idx').on(t.crawlRunId, t.statusCode),
    index('crawl_pages_run_indexable_idx').on(t.crawlRunId, t.indexable),
    index('crawl_pages_content_hash_idx').on(t.crawlRunId, t.contentHash),
  ],
);
export const seoIssues = pgTable(
  'seo_issues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    crawlPageId: uuid('crawl_page_id').references(() => crawlPages.id, { onDelete: 'cascade' }),
    crawlRunId: uuid('crawl_run_id').references(() => crawlRuns.id, { onDelete: 'cascade' }),
    url: text('url').notNull().default(''),
    ruleCode: text('rule_code').notNull(),
    category: text('category').notNull().default('TECHNICAL'),
    severity: text('severity').notNull(),
    title: text('title').notNull(),
    status: text('status').notNull().default('OPEN'),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
    detail: jsonb('detail').notNull().default({}),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('seo_issues_site_resolved_idx').on(t.siteId, t.resolvedAt),
    index('seo_issues_run_severity_idx').on(t.crawlRunId, t.severity),
    index('seo_issues_run_code_idx').on(t.crawlRunId, t.ruleCode),
  ],
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
