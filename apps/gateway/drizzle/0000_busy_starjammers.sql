CREATE TABLE `device_runtime_status` (
	`device_id` text PRIMARY KEY NOT NULL,
	`last_seen_at` text,
	`tmux_available` integer DEFAULT false NOT NULL,
	`last_error` text,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`host` text,
	`port` integer DEFAULT 22,
	`username` text,
	`ssh_config_ref` text,
	`session` text DEFAULT 'tmex',
	`auth_mode` text NOT NULL,
	`password_enc` text,
	`private_key_enc` text,
	`private_key_passphrase_enc` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "devices_type_check" CHECK("devices"."type" in ('local', 'ssh')),
	CONSTRAINT "devices_auth_mode_check" CHECK("devices"."auth_mode" in ('password', 'key', 'agent', 'configRef', 'auto'))
);
--> statement-breakpoint
CREATE TABLE `site_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`site_name` text NOT NULL,
	`site_url` text NOT NULL,
	`bell_throttle_seconds` integer NOT NULL,
	`ssh_reconnect_max_retries` integer NOT NULL,
	`ssh_reconnect_delay_seconds` integer NOT NULL,
	`language` text DEFAULT 'en_US' NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "site_settings_singleton_check" CHECK("site_settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `telegram_bot_chats` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`chat_type` text NOT NULL,
	`display_name` text NOT NULL,
	`status` text NOT NULL,
	`applied_at` text NOT NULL,
	`authorized_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `telegram_bots`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "telegram_bot_chats_status_check" CHECK("telegram_bot_chats"."status" in ('pending', 'authorized')),
	CONSTRAINT "telegram_bot_chats_chat_type_check" CHECK("telegram_bot_chats"."chat_type" in ('private', 'group', 'supergroup', 'channel', 'unknown'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_bot_chats_bot_chat_unique` ON `telegram_bot_chats` (`bot_id`,`chat_id`);--> statement-breakpoint
CREATE TABLE `telegram_bots` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_enc` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`allow_auth_requests` integer DEFAULT true NOT NULL,
	`last_update_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `webhook_endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`url` text NOT NULL,
	`secret` text NOT NULL,
	`event_mask` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
