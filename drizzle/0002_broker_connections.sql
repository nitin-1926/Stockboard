CREATE TYPE "public"."broker" AS ENUM('kite', 'indmoney');--> statement-breakpoint
CREATE TYPE "public"."broker_status" AS ENUM('disconnected', 'connected', 'stale', 'login_failed', 'needs_consent');--> statement-breakpoint
CREATE TABLE "broker_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broker" "broker" NOT NULL,
	"status" "broker_status" DEFAULT 'disconnected' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"last_error_step" text,
	"token_expires_at" timestamp with time zone,
	"kite_user_id_enc" text,
	"kite_password_enc" text,
	"kite_totp_secret_enc" text,
	"mcp_client_info_enc" text,
	"mcp_tokens_enc" text,
	"oauth_state_hash" text,
	"oauth_code_verifier_enc" text,
	"oauth_state_expires_at" timestamp with time zone,
	"credentials_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "broker_connections_broker_unique" UNIQUE("broker"),
	CONSTRAINT "broker_connections_enc_envelope" CHECK ("broker_connections"."kite_user_id_enc" ~ '^v[0-9]+:' AND "broker_connections"."kite_password_enc" ~ '^v[0-9]+:'
        AND "broker_connections"."kite_totp_secret_enc" ~ '^v[0-9]+:' AND "broker_connections"."mcp_client_info_enc" ~ '^v[0-9]+:'
        AND "broker_connections"."mcp_tokens_enc" ~ '^v[0-9]+:' AND "broker_connections"."oauth_code_verifier_enc" ~ '^v[0-9]+:')
);
