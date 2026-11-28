CREATE TABLE "vuln_intel" (
	"vuln_id" text PRIMARY KEY NOT NULL,
	"kev" boolean DEFAULT false NOT NULL,
	"kev_added_at" timestamp with time zone,
	"kev_due_at" timestamp with time zone,
	"kev_ransomware" boolean DEFAULT false NOT NULL,
	"kev_name" text,
	"epss" real,
	"epss_percentile" real,
	"epss_date" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workload_exposure" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"namespace" text NOT NULL,
	"workload_kind" text NOT NULL,
	"workload_name" text NOT NULL,
	"exposure" text NOT NULL,
	"hosts" jsonb NOT NULL,
	"via" jsonb NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workload_exposure_identity" ON "workload_exposure" USING btree ("namespace","workload_kind","workload_name");--> statement-breakpoint
CREATE INDEX "workload_exposure_active" ON "workload_exposure" USING btree ("active","exposure");