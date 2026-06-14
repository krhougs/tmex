CREATE TABLE `file_roots` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_roots_path_unique` ON `file_roots` (`path`);