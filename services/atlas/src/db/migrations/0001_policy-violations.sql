CREATE TABLE "policy_violation_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"violation_id" bigint NOT NULL,
	"type" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "policy_violations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"policy" text NOT NULL,
	"rule" text NOT NULL,
	"namespace" text NOT NULL,
	"resource_kind" text NOT NULL,
	"resource_name" text NOT NULL,
	"category" text DEFAULT '' NOT NULL,
	"severity" text DEFAULT '' NOT NULL,
	"source" text DEFAULT '' NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"baseline" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "policy_violation_events" ADD CONSTRAINT "policy_violation_events_violation_id_policy_violations_id_fk" FOREIGN KEY ("violation_id") REFERENCES "public"."policy_violations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "policy_violation_events_violation" ON "policy_violation_events" USING btree ("violation_id","at");--> statement-breakpoint
CREATE INDEX "policy_violation_events_type_at" ON "policy_violation_events" USING btree ("type","at");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_violations_identity" ON "policy_violations" USING btree ("policy","rule","namespace","resource_kind","resource_name");--> statement-breakpoint
CREATE INDEX "policy_violations_status_category" ON "policy_violations" USING btree ("status","category");--> statement-breakpoint
CREATE INDEX "policy_violations_workload" ON "policy_violations" USING btree ("namespace","resource_kind","resource_name");