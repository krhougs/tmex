DROP INDEX `file_roots_path_unique`;--> statement-breakpoint
-- file_roots 现绑定到设备：清空旧的无设备占位根（该特性未发版，存量仅为 home 占位，可丢），
-- 以便 ADD NOT NULL device_id 在 SQLite 下成功。
DELETE FROM `file_roots`;--> statement-breakpoint
ALTER TABLE `file_roots` ADD `device_id` text NOT NULL REFERENCES devices(id);--> statement-breakpoint
ALTER TABLE `file_roots` ADD `enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `file_roots_device_path_unique` ON `file_roots` (`device_id`,`path`);