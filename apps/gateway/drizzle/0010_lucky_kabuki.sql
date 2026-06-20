CREATE TABLE `weixin_account_users` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`user_id` text NOT NULL,
	`display_name` text NOT NULL,
	`status` text NOT NULL,
	`last_context_token` text,
	`last_inbound_at` text,
	`needs_reactivation` integer DEFAULT false NOT NULL,
	`applied_at` text NOT NULL,
	`authorized_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `weixin_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "weixin_account_users_status_check" CHECK("weixin_account_users"."status" in ('pending', 'authorized'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `weixin_account_users_account_user_unique` ON `weixin_account_users` (`account_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `weixin_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`allow_auth_requests` integer DEFAULT true NOT NULL,
	`weixin_uin` text,
	`bot_token_enc` text,
	`base_url` text,
	`sync_buf` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `site_settings` ADD `enable_weixin_bell_push` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `site_settings` ADD `enable_weixin_notification_push` integer DEFAULT false NOT NULL;