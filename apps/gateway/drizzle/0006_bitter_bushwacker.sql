CREATE TABLE `device_tree_order` (
	`device_id` text PRIMARY KEY NOT NULL,
	`windows` text DEFAULT '[]' NOT NULL,
	`panes` text DEFAULT '{}' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `devices` ADD `sort_order` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `devices` SET `sort_order` = (
	SELECT COUNT(*) FROM `devices` d2 WHERE d2.`created_at` < `devices`.`created_at`
);