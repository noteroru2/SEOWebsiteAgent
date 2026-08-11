CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_ai_running_idx
 ON jobs(type) WHERE type='ANALYZE_OPPORTUNITY' AND status='RUNNING';
