CREATE TABLE `workflow_dedupe_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workflow_id` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`expires_at` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_workflow_dedupe_keys` ON `workflow_dedupe_keys` (`workflow_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_workflow_dedupe_expires` ON `workflow_dedupe_keys` (`expires_at`);--> statement-breakpoint
CREATE TABLE `workflow_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`trigger` text DEFAULT '{}' NOT NULL,
	`graph` text DEFAULT '{}' NOT NULL,
	`scope` text DEFAULT '{}' NOT NULL,
	`created_by` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_workflow_rules_enabled` ON `workflow_rules` (`enabled`);--> statement-breakpoint
CREATE INDEX `idx_workflow_rules_name` ON `workflow_rules` (`name`);--> statement-breakpoint
CREATE TABLE `workflow_run_steps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`node_id` text DEFAULT '' NOT NULL,
	`type` text NOT NULL,
	`action_type` text DEFAULT '' NOT NULL,
	`ok` integer DEFAULT true NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`details` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "workflow_run_steps_type_check" CHECK("workflow_run_steps"."type" IN ('action','switch','join','agent','decision'))
);
--> statement-breakpoint
CREATE INDEX `idx_workflow_run_steps_run` ON `workflow_run_steps` (`run_id`);--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`trigger` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` integer DEFAULT 0 NOT NULL,
	`finished_at` integer,
	`summary` text DEFAULT '' NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflow_rules`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "workflow_runs_status_check" CHECK("workflow_runs"."status" IN ('running','completed','partial_failed','failed'))
);
--> statement-breakpoint
CREATE INDEX `idx_workflow_runs_workflow` ON `workflow_runs` (`workflow_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_workflow_runs_status` ON `workflow_runs` (`status`);--> statement-breakpoint
CREATE TABLE `device_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`device_id` text NOT NULL,
	`command` text NOT NULL,
	`input` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`response` text,
	`error_code` text,
	`error_message` text,
	`requested_by` text DEFAULT '' NOT NULL,
	`sent_at` integer DEFAULT 0 NOT NULL,
	`deadline_at` integer DEFAULT 0 NOT NULL,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "device_commands_status_check" CHECK("device_commands"."status" IN ('pending','completed','failed','timeout'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_device_commands_dedupe` ON `device_commands` (`product_id`,`device_id`,`command`,`sent_at`);--> statement-breakpoint
CREATE INDEX `idx_device_commands_status` ON `device_commands` (`status`);--> statement-breakpoint
CREATE INDEX `idx_device_commands_device` ON `device_commands` (`product_id`,`device_id`);--> statement-breakpoint
CREATE INDEX `idx_device_commands_deadline` ON `device_commands` (`deadline_at`);--> statement-breakpoint
CREATE TABLE `device_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` text DEFAULT '' NOT NULL,
	`device_id` text DEFAULT '' NOT NULL,
	`namespace` text DEFAULT '' NOT NULL,
	`type` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`detail` text DEFAULT '{}' NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`occurred_at` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_device_events_device_time` ON `device_events` (`device_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_device_events_type` ON `device_events` (`type`);--> statement-breakpoint
CREATE INDEX `idx_device_events_namespace` ON `device_events` (`namespace`);--> statement-breakpoint
CREATE TABLE `device_tags` (
	`product_id` text NOT NULL,
	`device_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`product_id`, `device_id`, `tag_id`),
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_device_tags_tag` ON `device_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text NOT NULL,
	`product_id` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'offline' NOT NULL,
	`reported_state` text DEFAULT '{}' NOT NULL,
	`desired_state` text DEFAULT '{}' NOT NULL,
	`last_seen_at` integer DEFAULT 0 NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`product_id`, `id`),
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "devices_status_check" CHECK("devices"."status" IN ('online','offline','error'))
);
--> statement-breakpoint
CREATE INDEX `idx_devices_product` ON `devices` (`product_id`);--> statement-breakpoint
CREATE INDEX `idx_devices_status` ON `devices` (`status`);--> statement-breakpoint
CREATE TABLE `product_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`version` integer NOT NULL,
	`device_spec` text DEFAULT '{}' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_product_versions_product_version` ON `product_versions` (`product_id`,`version`);--> statement-breakpoint
CREATE INDEX `idx_product_versions_product` ON `product_versions` (`product_id`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`device_spec` text DEFAULT '{}' NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`iot_platform_provider_id` text DEFAULT 'default' NOT NULL,
	`lifecycle_status` text DEFAULT 'developing' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "products_id_check" CHECK("products"."id" NOT GLOB '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "products_lifecycle_status_check" CHECK("products"."lifecycle_status" IN ('developing','published','archived'))
);
--> statement-breakpoint
CREATE INDEX `idx_products_lifecycle` ON `products` (`lifecycle_status`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_tags_name` ON `tags` (`name`);--> statement-breakpoint
CREATE TABLE `app_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text DEFAULT '' NOT NULL,
	`principal_id` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`issued_at` integer DEFAULT 0 NOT NULL,
	`expires_at` integer DEFAULT 0 NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	CONSTRAINT "app_sessions_status_check" CHECK("app_sessions"."status" IN ('active','expired','revoked'))
);
--> statement-breakpoint
CREATE INDEX `idx_app_sessions_app` ON `app_sessions` (`app_id`);--> statement-breakpoint
CREATE TABLE `marketplace_apps` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text DEFAULT '' NOT NULL,
	`name` text NOT NULL,
	`entry_url` text DEFAULT '' NOT NULL,
	`manifest` text DEFAULT '{}' NOT NULL,
	`installed` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_marketplace_apps_name` ON `marketplace_apps` (`name`);--> statement-breakpoint
CREATE TABLE `marketplace_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text DEFAULT '' NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`card` text DEFAULT '{}' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`published` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_marketplace_cards_product` ON `marketplace_cards` (`product_id`);--> statement-breakpoint
CREATE TABLE `webhook_credential_key_check` (
	`id` text PRIMARY KEY NOT NULL,
	`key_fingerprint` text NOT NULL,
	`sample_ciphertext` text NOT NULL,
	`sample_iv` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_webhook_credential_key_check_fp` ON `webhook_credential_key_check` (`key_fingerprint`);--> statement-breakpoint
CREATE TABLE `webhook_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`ciphertext` text NOT NULL,
	`iv` text NOT NULL,
	`auth_tag` text NOT NULL,
	`key_fingerprint` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_webhook_credentials_name` ON `webhook_credentials` (`name`);--> statement-breakpoint
CREATE TABLE `webhook_endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'outbound' NOT NULL,
	`url` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`events` text DEFAULT '[]' NOT NULL,
	`headers` text DEFAULT '{}' NOT NULL,
	`credential_id` text,
	`last_status` integer,
	`last_called_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "webhook_endpoints_kind_check" CHECK("webhook_endpoints"."kind" IN ('outbound','inbound'))
);
--> statement-breakpoint
CREATE INDEX `idx_webhook_endpoints_enabled` ON `webhook_endpoints` (`enabled`);--> statement-breakpoint
CREATE TABLE `memory_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`memory_id` text DEFAULT '' NOT NULL,
	`action` text NOT NULL,
	`scope_key` text DEFAULT '' NOT NULL,
	`detail` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "memory_events_action_check" CHECK("memory_events"."action" IN ('created','updated','deleted','read'))
);
--> statement-breakpoint
CREATE INDEX `idx_memory_events_memory` ON `memory_events` (`memory_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `memory_items` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_key` text DEFAULT '' NOT NULL,
	`kind` text DEFAULT 'fact' NOT NULL,
	`key` text NOT NULL,
	`value` text DEFAULT '' NOT NULL,
	`importance` integer DEFAULT 50 NOT NULL,
	`expires_at` integer DEFAULT 0 NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "memory_items_kind_check" CHECK("memory_items"."kind" IN ('fact','preference','procedure','note')),
	CONSTRAINT "memory_items_importance_check" CHECK("memory_items"."importance" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_memory_items_scope_key` ON `memory_items` (`scope_key`,`key`);--> statement-breakpoint
CREATE INDEX `idx_memory_items_scope` ON `memory_items` (`scope_key`);--> statement-breakpoint
CREATE TABLE `principals` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`display_name` text DEFAULT '' NOT NULL,
	`external_id` text DEFAULT '' NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "principals_kind_check" CHECK("principals"."kind" IN ('user','agent','service','device'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_principals_external` ON `principals` (`kind`,`external_id`);--> statement-breakpoint
CREATE TABLE `agent_timer_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`timer_id` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` integer DEFAULT 0 NOT NULL,
	`finished_at` integer,
	`session_id` text DEFAULT '' NOT NULL,
	`result_text` text DEFAULT '' NOT NULL,
	`error` text,
	FOREIGN KEY (`timer_id`) REFERENCES `agent_timers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_timer_runs_status_check" CHECK("agent_timer_runs"."status" IN ('running','completed','failed'))
);
--> statement-breakpoint
CREATE INDEX `idx_agent_timer_runs_timer` ON `agent_timer_runs` (`timer_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `agent_timers` (
	`id` text PRIMARY KEY NOT NULL,
	`origin_session_id` text DEFAULT '' NOT NULL,
	`scope` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`instruction` text NOT NULL,
	`schedule_kind` text NOT NULL,
	`schedule_expr` text NOT NULL,
	`timezone` text DEFAULT 'Asia/Shanghai' NOT NULL,
	`next_run_at` integer DEFAULT 0 NOT NULL,
	`last_run_at` integer,
	`last_error` text,
	`execution_policy` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "agent_timers_status_check" CHECK("agent_timers"."status" IN ('active','paused','running','completed','deleted')),
	CONSTRAINT "agent_timers_schedule_kind_check" CHECK("agent_timers"."schedule_kind" IN ('cron','interval','once'))
);
--> statement-breakpoint
CREATE INDEX `idx_agent_timers_next_run` ON `agent_timers` (`status`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_timers_session` ON `agent_timers` (`origin_session_id`);--> statement-breakpoint
CREATE TABLE `voice_keyword_terms` (
	`id` text PRIMARY KEY NOT NULL,
	`term` text NOT NULL,
	`term_hash` text NOT NULL,
	`match_mode` text DEFAULT 'substring' NOT NULL,
	`curated` integer DEFAULT 0 NOT NULL,
	`weight` integer DEFAULT 100 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "voice_keyword_terms_term_hash_check" CHECK(length("voice_keyword_terms"."term_hash") = 64),
	CONSTRAINT "voice_keyword_terms_term_check" CHECK(length("voice_keyword_terms"."term") BETWEEN 2 AND 64),
	CONSTRAINT "voice_keyword_terms_match_mode_check" CHECK("voice_keyword_terms"."match_mode" IN ('substring','word_boundary','context')),
	CONSTRAINT "voice_keyword_terms_curated_check" CHECK("voice_keyword_terms"."curated" IN (0,1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_voice_keyword_terms_hash` ON `voice_keyword_terms` (`term_hash`);--> statement-breakpoint
CREATE TABLE `voice_question_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`question_hash` text NOT NULL,
	`question` text DEFAULT '' NOT NULL,
	`answer` text DEFAULT '' NOT NULL,
	`hit_count` integer DEFAULT 0 NOT NULL,
	`expires_at` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "voice_question_cache_hash_check" CHECK(length("voice_question_cache"."question_hash") = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_voice_question_cache_hash` ON `voice_question_cache` (`question_hash`);--> statement-breakpoint
CREATE INDEX `idx_voice_question_cache_expires` ON `voice_question_cache` (`expires_at`);