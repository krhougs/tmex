CREATE TABLE `agent_queued_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`text` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `provider_hosted_tools` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `origin_pane_title` text;--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `origin_process_name` text;--> statement-breakpoint
ALTER TABLE `llm_providers` ADD `manual_models` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `llm_providers` ADD `disabled_models` text DEFAULT '[]' NOT NULL;