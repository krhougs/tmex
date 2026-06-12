CREATE TABLE `agent_confirmations` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`input_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reason` text,
	`decided_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_confirmations_status_check" CHECK("agent_confirmations"."status" in ('pending', 'approved', 'denied', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE `agent_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_messages_session_seq_unique` ON `agent_messages` (`session_id`,`seq`);--> statement-breakpoint
CREATE TABLE `agent_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`device_id` text,
	`pane_id` text,
	`provider_id` text,
	`model_id` text NOT NULL,
	`system_prompt` text,
	`write_mode` text DEFAULT 'confirm' NOT NULL,
	`use_provider_web_search` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`last_error` text,
	`max_steps_per_turn` integer DEFAULT 25 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`provider_id`) REFERENCES `llm_providers`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "agent_sessions_write_mode_check" CHECK("agent_sessions"."write_mode" in ('confirm', 'auto')),
	CONSTRAINT "agent_sessions_status_check" CHECK("agent_sessions"."status" in ('idle', 'running', 'waiting_confirmation', 'stopped', 'error'))
);
--> statement-breakpoint
CREATE TABLE `agent_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`search_provider` text DEFAULT 'none' NOT NULL,
	`tavily_api_key_enc` text,
	`brave_api_key_enc` text,
	`default_provider_id` text,
	`default_model_id` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`default_provider_id`) REFERENCES `llm_providers`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "agent_settings_singleton_check" CHECK("agent_settings"."id" = 1),
	CONSTRAINT "agent_settings_search_provider_check" CHECK("agent_settings"."search_provider" in ('none', 'tavily', 'brave'))
);
--> statement-breakpoint
CREATE TABLE `llm_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`protocol` text NOT NULL,
	`base_url` text NOT NULL,
	`api_key_enc` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`models_cache` text,
	`models_fetched_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "llm_providers_protocol_check" CHECK("llm_providers"."protocol" in ('openai-chat', 'openai-responses'))
);
--> statement-breakpoint
CREATE TABLE `watch_rule_state` (
	`rule_id` text PRIMARY KEY NOT NULL,
	`last_sampled_at` text,
	`last_value` text,
	`last_value_changed_at` text,
	`triggered_since_change` integer DEFAULT false NOT NULL,
	`last_triggered_at` text,
	`consecutive_errors` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`model_unavailable_notified` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`rule_id`) REFERENCES `watch_rules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `watch_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`device_id` text NOT NULL,
	`pane_id` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`trigger_type` text NOT NULL,
	`pattern` text,
	`pattern_flags` text DEFAULT '' NOT NULL,
	`extract_group` integer DEFAULT 0 NOT NULL,
	`condition_prompt` text,
	`provider_id` text,
	`model_id` text,
	`confirm_with_llm` integer DEFAULT false NOT NULL,
	`summarize_with_llm` integer DEFAULT false NOT NULL,
	`interval_seconds` integer DEFAULT 30 NOT NULL,
	`unchanged_minutes` integer,
	`no_match_behavior` text DEFAULT 'reset' NOT NULL,
	`fire_mode` text DEFAULT 'once' NOT NULL,
	`cooldown_seconds` integer DEFAULT 600 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_id`) REFERENCES `llm_providers`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "watch_rules_trigger_type_check" CHECK("watch_rules"."trigger_type" in ('match', 'unchanged', 'llm')),
	CONSTRAINT "watch_rules_no_match_behavior_check" CHECK("watch_rules"."no_match_behavior" in ('reset', 'ignore')),
	CONSTRAINT "watch_rules_fire_mode_check" CHECK("watch_rules"."fire_mode" in ('once', 'repeat'))
);
