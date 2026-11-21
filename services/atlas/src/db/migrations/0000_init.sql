CREATE TABLE "collector_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'collect' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"ok" boolean,
	"stats" jsonb,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "finding_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"finding_id" bigint NOT NULL,
	"type" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "finding_sightings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"finding_id" bigint NOT NULL,
	"namespace" text NOT NULL,
	"workload_kind" text NOT NULL,
	"workload_name" text NOT NULL,
	"container" text NOT NULL,
	"image_tag" text NOT NULL,
	"image_digest" text NOT NULL,
	"installed_version" text,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"image_registry" text NOT NULL,
	"image_repository" text NOT NULL,
	"vuln_id" text NOT NULL,
	"pkg_name" text NOT NULL,
	"pkg_type" text,
	"severity" text NOT NULL,
	"title" text,
	"score" real,
	"primary_link" text,
	"links" jsonb,
	"fixed_version" text DEFAULT '' NOT NULL,
	"published_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"fix_available_at" timestamp with time zone,
	"fix_in_control_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scan_reports" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"image_digest" text NOT NULL,
	"image_ref" text NOT NULL,
	"content_hash" text NOT NULL,
	"report" jsonb NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finding_events" ADD CONSTRAINT "finding_events_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_sightings" ADD CONSTRAINT "finding_sightings_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finding_events_finding" ON "finding_events" USING btree ("finding_id","at");--> statement-breakpoint
CREATE INDEX "finding_events_type_at" ON "finding_events" USING btree ("type","at");--> statement-breakpoint
CREATE UNIQUE INDEX "finding_sightings_identity" ON "finding_sightings" USING btree ("finding_id","namespace","workload_kind","workload_name","container","image_digest");--> statement-breakpoint
CREATE INDEX "finding_sightings_active" ON "finding_sightings" USING btree ("active","namespace");--> statement-breakpoint
CREATE UNIQUE INDEX "findings_identity" ON "findings" USING btree ("image_registry","image_repository","vuln_id","pkg_name");--> statement-breakpoint
CREATE INDEX "findings_status_severity" ON "findings" USING btree ("status","severity");--> statement-breakpoint
CREATE INDEX "findings_vuln_id" ON "findings" USING btree ("vuln_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scan_reports_identity" ON "scan_reports" USING btree ("image_digest","content_hash");