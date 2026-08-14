import { sql } from 'drizzle-orm';
import {
  boolean,
  bigint,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
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
    repositoryType: text('repository_type').notNull().default('LOCAL_GIT'),
    expectedRemote: text('expected_remote'),
    defaultBranch: text('default_branch'),
    enabled: boolean('enabled').notNull().default(true),
    headSha: text('head_sha'),
    currentBranch: text('current_branch'),
    originUrl: text('origin_url'),
    worktreeClean: boolean('worktree_clean'),
    trackedFileCount: integer('tracked_file_count'),
    lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('site_repositories_site_idx').on(t.siteId)],
);
export const sourceRouteMappings = pgTable(
  'source_route_mappings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => siteRepositories.id, { onDelete: 'cascade' }),
    routeUrl: text('route_url').notNull(),
    routePath: text('route_path').notNull(),
    mappingStatus: text('mapping_status').notNull(),
    primarySourcePath: text('primary_source_path'),
    relatedSourcePaths: jsonb('related_source_paths').notNull().default([]),
    repositoryHeadSha: text('repository_head_sha').notNull(),
    mappingEvidence: jsonb('mapping_evidence').notNull().default({}),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('source_route_mapping_repo_route_idx').on(t.repositoryId, t.routePath),
    index('source_route_mapping_site_status_idx').on(t.siteId, t.mappingStatus),
  ],
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
    uniqueIndex('jobs_one_gsc_running_idx')
      .on(t.type)
      .where(sql`${t.type} = 'GSC_SYNC' AND ${t.status} = 'RUNNING'`),
    uniqueIndex('jobs_one_gsc_sync_per_site_idx')
      .on(t.siteId)
      .where(sql`${t.type} = 'GSC_SYNC' AND ${t.status} IN ('QUEUED','RUNNING')`),
    uniqueIndex('jobs_one_opportunity_generation_per_site_idx')
      .on(t.siteId)
      .where(sql`${t.type} = 'GENERATE_OPPORTUNITIES' AND ${t.status} IN ('QUEUED','RUNNING')`),
    uniqueIndex('jobs_one_ai_running_idx')
      .on(t.type)
      .where(sql`${t.type} = 'ANALYZE_OPPORTUNITY' AND ${t.status} = 'RUNNING'`),
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

export const gscConnections = pgTable('gsc_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  siteId: uuid('site_id')
    .notNull()
    .unique()
    .references(() => sites.id, { onDelete: 'cascade' }),
  encryptedRefreshToken: text('encrypted_refresh_token'),
  encryptedAccessToken: text('encrypted_access_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  scope: text('scope').notNull(),
  status: text('status').notNull().default('CONNECTED'),
  lastErrorCode: text('last_error_code'),
  disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
  ...timestamps,
});

export const gscOAuthStates = pgTable(
  'gsc_oauth_states',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    stateHash: text('state_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('gsc_oauth_states_expiry_idx').on(t.expiresAt)],
);

export const gscProperties = pgTable(
  'gsc_properties',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id').references(() => gscConnections.id, {
      onDelete: 'set null',
    }),
    propertyUri: text('property_uri').notNull(),
    propertyType: text('property_type').notNull(),
    permissionLevel: text('permission_level').notNull(),
    lastDiscoveredAt: timestamp('last_discovered_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('gsc_properties_connection_uri_idx').on(t.connectionId, t.propertyUri),
    index('gsc_properties_connection_idx').on(t.connectionId),
  ],
);

export const siteGscProperties = pgTable(
  'site_gsc_properties',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => gscProperties.id, { onDelete: 'restrict' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => gscConnections.id, { onDelete: 'restrict' }),
    searchType: text('search_type').notNull().default('web'),
    syncEnabled: boolean('sync_enabled').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('site_gsc_properties_site_idx').on(t.siteId),
    index('site_gsc_properties_property_idx').on(t.propertyId),
  ],
);

export const gscSyncRuns = pgTable(
  'gsc_sync_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => gscProperties.id, { onDelete: 'restrict' }),
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    mode: text('mode').notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    status: text('status').notNull().default('RUNNING'),
    apiRequests: integer('api_requests').notNull().default(0),
    rowsReceived: integer('rows_received').notNull().default(0),
    rowsInserted: integer('rows_inserted').notNull().default(0),
    rowsUpdated: integer('rows_updated').notNull().default(0),
    coverageStatus: text('coverage_status').notNull().default('COMPLETE_AS_RETURNED'),
    failureCode: text('failure_code'),
    failureSummary: text('failure_summary'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('gsc_sync_runs_site_idx').on(t.siteId, t.startedAt),
    index('gsc_sync_runs_status_idx').on(t.status, t.startedAt),
  ],
);

const metricColumns = () => ({
  clicks: bigint('clicks', { mode: 'number' }).notNull().default(0),
  impressions: bigint('impressions', { mode: 'number' }).notNull().default(0),
  ctr: doublePrecision('ctr').notNull().default(0),
  position: doublePrecision('position').notNull().default(0),
  ...timestamps,
});

export const gscDailySiteMetrics = pgTable(
  'gsc_daily_site_metrics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => gscProperties.id, { onDelete: 'cascade' }),
    searchType: text('search_type').notNull().default('web'),
    metricDate: date('metric_date').notNull(),
    ...metricColumns(),
  },
  (t) => [
    uniqueIndex('gsc_daily_site_unique_idx').on(t.siteId, t.propertyId, t.searchType, t.metricDate),
    index('gsc_daily_site_date_idx').on(t.siteId, t.metricDate),
  ],
);
export const gscQueryMetrics = pgTable(
  'gsc_query_metrics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => gscProperties.id, { onDelete: 'cascade' }),
    searchType: text('search_type').notNull().default('web'),
    metricDate: date('metric_date').notNull(),
    query: text('query').notNull(),
    ...metricColumns(),
  },
  (t) => [
    uniqueIndex('gsc_query_unique_idx').on(
      t.siteId,
      t.propertyId,
      t.searchType,
      t.metricDate,
      t.query,
    ),
    index('gsc_query_lookup_idx').on(t.siteId, t.query, t.metricDate),
  ],
);
export const gscPageMetrics = pgTable(
  'gsc_page_metrics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => gscProperties.id, { onDelete: 'cascade' }),
    searchType: text('search_type').notNull().default('web'),
    metricDate: date('metric_date').notNull(),
    page: text('page').notNull(),
    ...metricColumns(),
  },
  (t) => [
    uniqueIndex('gsc_page_unique_idx').on(
      t.siteId,
      t.propertyId,
      t.searchType,
      t.metricDate,
      t.page,
    ),
    index('gsc_page_lookup_idx').on(t.siteId, t.page, t.metricDate),
  ],
);
export const gscQueryPageMetrics = pgTable(
  'gsc_query_page_metrics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => gscProperties.id, { onDelete: 'cascade' }),
    searchType: text('search_type').notNull().default('web'),
    metricDate: date('metric_date').notNull(),
    query: text('query').notNull(),
    page: text('page').notNull(),
    ...metricColumns(),
  },
  (t) => [
    uniqueIndex('gsc_query_page_unique_idx').on(
      t.siteId,
      t.propertyId,
      t.searchType,
      t.metricDate,
      t.query,
      t.page,
    ),
    index('gsc_query_page_lookup_idx').on(t.siteId, t.query, t.page, t.metricDate),
  ],
);

export const gscSyncSummaries = pgTable('gsc_sync_summaries', {
  siteId: uuid('site_id')
    .primaryKey()
    .references(() => sites.id, { onDelete: 'cascade' }),
  propertyId: uuid('property_id')
    .notNull()
    .references(() => gscProperties.id, { onDelete: 'cascade' }),
  lastSyncRunId: uuid('last_sync_run_id').references(() => gscSyncRuns.id, {
    onDelete: 'set null',
  }),
  lastFinalizedDate: date('last_finalized_date'),
  currentMetrics: jsonb('current_metrics').notNull().default({}),
  previousMetrics: jsonb('previous_metrics').notNull().default({}),
  deltas: jsonb('deltas').notNull().default({}),
  topPagesCount: integer('top_pages_count').notNull().default(0),
  topQueriesCount: integer('top_queries_count').notNull().default(0),
  rowsStored: bigint('rows_stored', { mode: 'number' }).notNull().default(0),
  coverageStatus: text('coverage_status').notNull().default('COMPLETE_AS_RETURNED'),
  latestStatus: text('latest_status').notNull().default('SUCCEEDED'),
  ...timestamps,
});

export const gscPageCrawlMappings = pgTable(
  'gsc_page_crawl_mappings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => gscProperties.id, { onDelete: 'cascade' }),
    gscPage: text('gsc_page').notNull(),
    crawlRunId: uuid('crawl_run_id').references(() => crawlRuns.id, { onDelete: 'set null' }),
    crawlPageId: uuid('crawl_page_id').references(() => crawlPages.id, { onDelete: 'set null' }),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('gsc_page_crawl_mapping_unique_idx').on(t.siteId, t.propertyId, t.gscPage),
    index('gsc_page_crawl_mapping_reason_idx').on(t.siteId, t.reason),
  ],
);
export const opportunityRuns = pgTable(
  'opportunity_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id')
      .unique()
      .references(() => jobs.id, { onDelete: 'set null' }),
    crawlRunId: uuid('crawl_run_id').references(() => crawlRuns.id, { onDelete: 'set null' }),
    gscSyncReference: uuid('gsc_sync_reference').references(() => gscSyncRuns.id, {
      onDelete: 'set null',
    }),
    status: text('status').notNull().default('RUNNING'),
    candidatesGenerated: integer('candidates_generated').notNull().default(0),
    opportunitiesCreated: integer('opportunities_created').notNull().default(0),
    opportunitiesUpdated: integer('opportunities_updated').notNull().default(0),
    opportunitiesResolved: integer('opportunities_resolved').notNull().default(0),
    opportunitiesSuppressed: integer('opportunities_suppressed').notNull().default(0),
    suppressionCounts: jsonb('suppression_counts').notNull().default({}),
    durationMs: integer('duration_ms'),
    engineVersion: text('engine_version').notNull(),
    failureCode: text('failure_code'),
    failureSummary: text('failure_summary'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('opportunity_runs_site_created_idx').on(t.siteId, t.createdAt),
    index('opportunity_runs_status_idx').on(t.status, t.createdAt),
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
    entityType: text('entity_type').notNull().default('SITE'),
    url: text('url'),
    query: text('query'),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    priority: integer('priority').notNull().default(0),
    priorityLabel: text('priority_label').notNull().default('LOW'),
    confidence: text('confidence').notNull().default('LOW'),
    score: integer('score').notNull().default(0),
    status: text('status').notNull().default('OPEN'),
    evidence: jsonb('evidence').notNull().default({}),
    scoreComponents: jsonb('score_components').notNull().default({}),
    fingerprint: text('fingerprint').notNull(),
    engineVersion: text('engine_version').notNull().default('legacy'),
    generationRunId: uuid('generation_run_id').references(() => opportunityRuns.id, {
      onDelete: 'set null',
    }),
    firstDetectedAt: timestamp('first_detected_at', { withTimezone: true }).notNull().defaultNow(),
    lastDetectedAt: timestamp('last_detected_at', { withTimezone: true }).notNull().defaultNow(),
    missingRunCount: integer('missing_run_count').notNull().default(0),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('opportunities_site_status_idx').on(t.siteId, t.status, t.priority),
    uniqueIndex('opportunities_fingerprint_unique_idx').on(
      t.siteId,
      t.engineVersion,
      t.fingerprint,
    ),
    index('opportunities_site_status_score_idx').on(t.siteId, t.status, t.score),
    index('opportunities_site_priority_idx').on(t.siteId, t.priorityLabel, t.score),
    index('opportunities_site_kind_idx').on(t.siteId, t.kind, t.score),
    index('opportunities_last_detected_idx').on(t.siteId, t.lastDetectedAt),
  ],
);
export const aiAnalysisRuns = pgTable(
  'ai_analysis_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id')
      .unique()
      .references(() => jobs.id, { onDelete: 'set null' }),
    reusedRunId: uuid('reused_run_id'),
    status: text('status').notNull().default('QUEUED'),
    analysisKey: text('analysis_key').notNull(),
    evidenceHash: text('evidence_hash').notNull(),
    opportunityFingerprint: text('opportunity_fingerprint').notNull(),
    promptVersion: text('prompt_version').notNull(),
    schemaVersion: text('schema_version').notNull(),
    model: text('model').notNull(),
    reasoningEffort: text('reasoning_effort').notNull(),
    estimatedCostMicros: integer('estimated_cost_micros').notNull().default(0),
    actualCostMicros: integer('actual_cost_micros').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    cachedInputTokens: integer('cached_input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    providerRequestId: text('provider_request_id'),
    latencyMs: integer('latency_ms'),
    contextChars: integer('context_chars').notNull().default(0),
    failureCode: text('failure_code'),
    failureSummary: text('failure_summary'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('ai_analysis_opportunity_created_idx').on(t.opportunityId, t.createdAt),
    index('ai_analysis_site_created_idx').on(t.siteId, t.createdAt),
    index('ai_analysis_reuse_idx').on(t.analysisKey, t.status, t.createdAt),
    index('ai_analysis_status_idx').on(t.status, t.createdAt),
  ],
);
export const aiRecommendations = pgTable(
  'ai_recommendations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    analysisRunId: uuid('analysis_run_id')
      .notNull()
      .unique()
      .references(() => aiAnalysisRuns.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    verdict: text('verdict').notNull(),
    confidence: text('confidence').notNull(),
    summary: text('summary').notNull(),
    result: jsonb('result').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ai_recommendations_opportunity_idx').on(t.opportunityId, t.createdAt)],
);
export const sourcePlanRuns = pgTable(
  'source_plan_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id, {
      onDelete: 'cascade',
    }),
    ownerResearchCaseId: uuid('owner_research_case_id'),
    subjectType: text('subject_type').notNull().default('OPPORTUNITY'),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => siteRepositories.id, { onDelete: 'restrict' }),
    jobId: uuid('job_id')
      .unique()
      .references(() => jobs.id, { onDelete: 'set null' }),
    reusedRunId: uuid('reused_run_id'),
    status: text('status').notNull().default('RUNNING'),
    model: text('model').notNull(),
    reasoningEffort: text('reasoning_effort').notNull(),
    promptVersion: text('prompt_version').notNull(),
    schemaVersion: text('schema_version').notNull(),
    repositoryHeadSha: text('repository_head_sha').notNull(),
    sourceEvidenceHash: text('source_evidence_hash').notNull(),
    sourceContext: jsonb('source_context').notNull().default({}),
    inputTokens: integer('input_tokens').notNull().default(0),
    cachedInputTokens: integer('cached_input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    actualCostMicros: integer('actual_cost_micros').notNull().default(0),
    providerRequestId: text('provider_request_id'),
    latencyMs: integer('latency_ms'),
    failureCode: text('failure_code'),
    failureSummary: text('failure_summary'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('source_plan_runs_opportunity_idx').on(t.opportunityId, t.createdAt),
    index('source_plan_runs_reuse_idx').on(t.sourceEvidenceHash, t.status),
  ],
);
export const sourceChangePlans = pgTable(
  'source_change_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .unique()
      .references(() => sourcePlanRuns.id, { onDelete: 'cascade' }),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id, {
      onDelete: 'cascade',
    }),
    ownerResearchCaseId: uuid('owner_research_case_id'),
    subjectType: text('subject_type').notNull().default('OPPORTUNITY'),
    verdict: text('verdict').notNull(),
    confidence: text('confidence').notNull(),
    batch5Reconciliation: text('batch5_reconciliation').notNull(),
    summary: text('summary').notNull(),
    structuredOutput: jsonb('structured_output').notNull(),
    status: text('status').notNull().default('READY_FOR_REVIEW'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    staleAt: timestamp('stale_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('source_change_plans_status_idx').on(t.status, t.createdAt),
    index('source_change_plans_opportunity_idx').on(t.opportunityId, t.createdAt),
  ],
);

export const ownerResearchCases = pgTable(
  'owner_research_cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id, {
      onDelete: 'set null',
    }),
    query: text('query').notNull(),
    normalizedQuery: text('normalized_query').notNull(),
    researchType: text('research_type').notNull(),
    status: text('status').notNull().default('DRAFT'),
    priority: text('priority').notNull().default('HIGH'),
    reason: text('reason').notNull(),
    requestedBy: text('requested_by').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    ownerIntent: text('owner_intent').notNull(),
    targetPage: text('target_page'),
    primaryGscPage: text('primary_gsc_page'),
    repositoryId: uuid('repository_id').references(() => siteRepositories.id, {
      onDelete: 'set null',
    }),
    sourceHeadSha: text('source_head_sha'),
    lastAssessedAt: timestamp('last_assessed_at', { withTimezone: true }),
    metadata: jsonb('metadata').notNull().default({}),
    ...timestamps,
  },
  (t) => [
    index('owner_research_cases_site_status_idx').on(t.siteId, t.status, t.createdAt),
    index('owner_research_cases_opportunity_idx').on(t.opportunityId),
  ],
);

export const ownerResearchAiAuthorizations = pgTable(
  'owner_research_ai_authorizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => ownerResearchCases.id, { onDelete: 'cascade' }),
    authorizationRef: text('authorization_ref').notNull().unique(),
    scope: text('scope').notNull().default('OWNER_RESEARCH_V3'),
    status: text('status').notNull().default('AUTHORIZED'),
    authorizedBy: text('authorized_by').notNull(),
    authorizedAt: timestamp('authorized_at', { withTimezone: true }).notNull().defaultNow(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    jobId: uuid('job_id')
      .unique()
      .references(() => jobs.id, { onDelete: 'set null' }),
    runId: uuid('run_id')
      .unique()
      .references(() => sourcePlanRuns.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [index('owner_research_ai_authorizations_case_idx').on(t.caseId, t.status, t.createdAt)],
);

export const ownerResearchRequests = pgTable(
  'owner_research_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => ownerResearchCases.id, { onDelete: 'cascade' }),
    requestedBy: text('requested_by').notNull(),
    reason: text('reason').notNull(),
    ownerIntent: text('owner_intent').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('owner_research_requests_case_idx').on(t.caseId, t.requestedAt)],
);

export const ownerResearchSourceLinks = pgTable(
  'owner_research_source_links',
  {
    caseId: uuid('case_id')
      .notNull()
      .references(() => ownerResearchCases.id, { onDelete: 'cascade' }),
    mappingId: uuid('mapping_id')
      .notNull()
      .references(() => sourceRouteMappings.id, { onDelete: 'restrict' }),
    role: text('role').notNull(),
    sourceHeadSha: text('source_head_sha').notNull(),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.caseId, t.mappingId, t.role] })],
);

export const ownerResearchFindings = pgTable(
  'owner_research_findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => ownerResearchCases.id, { onDelete: 'cascade' }),
    findingType: text('finding_type').notNull(),
    findingStatus: text('finding_status').notNull(),
    summary: text('summary').notNull(),
    evidence: jsonb('evidence').notNull().default({}),
    assessedAt: timestamp('assessed_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [uniqueIndex('owner_research_findings_case_type_idx').on(t.caseId, t.findingType)],
);

export const evidenceRequests = pgTable(
  'evidence_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    opportunityId: uuid('opportunity_id').references(() => opportunities.id, {
      onDelete: 'cascade',
    }),
    ownerResearchCaseId: uuid('owner_research_case_id').references(() => ownerResearchCases.id, {
      onDelete: 'cascade',
    }),
    type: text('type').notNull(),
    requirement: text('requirement').notNull(),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('OPEN'),
    source: text('source').notNull(),
    required: boolean('required').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    index('evidence_request_opportunity_idx').on(t.opportunityId, t.status),
    index('evidence_request_research_idx').on(t.ownerResearchCaseId, t.status),
  ],
);
export const evidenceItems = pgTable(
  'evidence_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => evidenceRequests.id, { onDelete: 'cascade' }),
    sourceType: text('source_type').notNull(),
    evidence: jsonb('evidence').notNull(),
    evidenceHash: text('evidence_hash').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }),
    observedTimezone: text('observed_timezone'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('evidence_item_request_idx').on(t.requestId, t.createdAt)],
);

export const ownerFactConfirmations = pgTable(
  'owner_fact_confirmations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    provenance: text('provenance').notNull(),
    confirmedBy: text('confirmed_by').notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull().defaultNow(),
    reviewStatus: text('review_status').notNull(),
    sourceContext: text('source_context'),
    metadata: jsonb('metadata').notNull().default({}),
    ...timestamps,
  },
  (t) => [index('owner_fact_confirmations_site_idx').on(t.siteId, t.confirmedAt)],
);

export const ownerFacts = pgTable(
  'owner_facts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    factKey: text('fact_key').notNull(),
    valueJson: jsonb('value_json').notNull(),
    scopeType: text('scope_type').notNull(),
    scopeKey: text('scope_key').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull().defaultNow(),
    reviewAfter: timestamp('review_after', { withTimezone: true }),
    sourceEvidenceItemId: uuid('source_evidence_item_id').references(() => evidenceItems.id, {
      onDelete: 'restrict',
    }),
    directConfirmationId: uuid('direct_confirmation_id').references(
      () => ownerFactConfirmations.id,
      { onDelete: 'restrict' },
    ),
    confirmedBy: text('confirmed_by').notNull().default('OWNER'),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    supersededBy: uuid('superseded_by'),
    factHash: text('fact_hash').notNull(),
    metadata: jsonb('metadata').notNull().default({}),
    ...timestamps,
  },
  (t) => [
    index('owner_facts_site_scope_idx').on(t.siteId, t.factKey, t.scopeType, t.scopeKey),
    uniqueIndex('owner_facts_hash_unique_idx').on(t.factHash),
  ],
);

export const ownerResearchFactLinks = pgTable(
  'owner_research_fact_links',
  {
    caseId: uuid('case_id')
      .notNull()
      .references(() => ownerResearchCases.id, { onDelete: 'cascade' }),
    factId: uuid('fact_id')
      .notNull()
      .references(() => ownerFacts.id, { onDelete: 'restrict' }),
    factHash: text('fact_hash').notNull(),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.caseId, t.factId] })],
);

export const ownerFactConfirmationLinks = pgTable(
  'owner_fact_confirmation_links',
  {
    factId: uuid('fact_id')
      .notNull()
      .references(() => ownerFacts.id, { onDelete: 'cascade' }),
    confirmationId: uuid('confirmation_id')
      .notNull()
      .references(() => ownerFactConfirmations.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.factId, t.confirmationId] }),
    index('owner_fact_confirmation_links_confirmation_idx').on(t.confirmationId),
  ],
);

export const serpCaptures = pgTable(
  'serp_captures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    requestId: uuid('request_id')
      .notNull()
      .references(() => evidenceRequests.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id')
      .unique()
      .references(() => jobs.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('QUEUED'),
    query: text('query').notNull(),
    targetDomain: text('target_domain').notNull(),
    deviceProvenance: text('device_provenance').notNull(),
    requestedLocationLabel: text('requested_location_label').notNull(),
    requestedGeolocation: jsonb('requested_geolocation'),
    timezone: text('timezone').notNull(),
    googleDisplayedLocation: text('google_displayed_location'),
    captureNetworkContext: text('capture_network_context'),
    machineCapture: jsonb('machine_capture'),
    ownerConfirmedValue: jsonb('owner_confirmed_value'),
    corrected: boolean('corrected').notNull().default(false),
    screenshotPath: text('screenshot_path'),
    screenshotSha256: text('screenshot_sha256'),
    parserVersion: text('parser_version'),
    positionExtractionVersion: text('position_extraction_version'),
    capturedAt: timestamp('captured_at', { withTimezone: true }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    discardedAt: timestamp('discarded_at', { withTimezone: true }),
    failureCode: text('failure_code'),
    failureSummary: text('failure_summary'),
    ...timestamps,
  },
  (t) => [
    index('serp_captures_request_idx').on(t.requestId, t.createdAt),
    index('serp_captures_status_idx').on(t.status, t.createdAt),
  ],
);

export const browserCaptureTokens = pgTable(
  'browser_capture_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunities.id, { onDelete: 'cascade' }),
    requestId: uuid('request_id')
      .notNull()
      .references(() => evidenceRequests.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expectedQuery: text('expected_query').notNull(),
    targetDomain: text('target_domain').notNull(),
    ownerDeclaredLocation: text('owner_declared_location').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('browser_capture_tokens_hash_unique_idx').on(t.tokenHash),
    index('browser_capture_tokens_request_idx').on(t.requestId, t.createdAt),
  ],
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
    opportunityId: uuid('opportunity_id').references(() => opportunities.id, {
      onDelete: 'set null',
    }),
    ownerResearchCaseId: uuid('owner_research_case_id').references(() => ownerResearchCases.id, {
      onDelete: 'set null',
    }),
    analysisRunId: uuid('analysis_run_id').references(() => aiAnalysisRuns.id, {
      onDelete: 'set null',
    }),
    sourcePlanRunId: uuid('source_plan_run_id').references(() => sourcePlanRuns.id, {
      onDelete: 'set null',
    }),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version'),
    inputTokens: integer('input_tokens').notNull().default(0),
    cachedInputTokens: integer('cached_input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costMicros: integer('cost_micros').notNull().default(0),
    status: text('status').notNull().default('SUCCEEDED'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ai_usage_created_idx').on(t.createdAt),
    index('ai_usage_site_created_idx').on(t.siteId, t.createdAt),
    index('ai_usage_analysis_idx').on(t.analysisRunId),
  ],
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
