ALTER TABLE `site_settings` ADD `notification_throttle_seconds` integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `site_settings` ADD `enable_browser_notification_toast` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `site_settings` ADD `enable_telegram_notification_push` integer DEFAULT true NOT NULL;