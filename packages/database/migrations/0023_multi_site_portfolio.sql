ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "site_role" text DEFAULT 'UNCLASSIFIED' NOT NULL;
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "watch_mode" text DEFAULT 'MONITOR_ONLY' NOT NULL;
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "source_status" text DEFAULT 'NOT_CONFIGURED' NOT NULL;
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "stagger_minute" integer DEFAULT 0 NOT NULL;
ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "gsc_property_ids" jsonb;

-- Ensure validated amphon.co.th site has role, mode, and source_status initialized
UPDATE "sites" 
SET "site_role" = 'PRIMARY_NATIONAL', 
    "watch_mode" = 'CHANGE_ENABLED', 
    "source_status" = 'CURRENT' 
WHERE "url" LIKE '%amphon.co.th%';
