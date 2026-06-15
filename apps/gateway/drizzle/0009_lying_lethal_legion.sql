CREATE TABLE `terminal_shortcut_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`items` text DEFAULT '[{"id":"paste","type":"action","action":"paste","label":""},{"id":"enter","type":"send","label":"Enter","payload":"\r"},{"id":"shift-tab","type":"send","label":"SHIFT-TAB","payload":"\u001b[Z"},{"id":"esc","type":"send","label":"ESC","payload":"\u001b"},{"id":"ctrl-c","type":"send","label":"CTRL-C","payload":"\u0003"},{"id":"ctrl-d","type":"send","label":"CTRL-D","payload":"\u0004"},{"id":"arrow-up","type":"send","label":"↑","payload":"\u001b[A"},{"id":"arrow-down","type":"send","label":"↓","payload":"\u001b[B"},{"id":"arrow-left","type":"send","label":"←","payload":"\u001b[D"},{"id":"arrow-right","type":"send","label":"→","payload":"\u001b[C"},{"id":"shift-enter","type":"send","label":"SHIFT-Enter","payload":"\u001b[13;2u"},{"id":"backspace","type":"send","label":"Backspace","payload":"\b"}]' NOT NULL,
	`use_icons` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "terminal_shortcut_settings_singleton_check" CHECK("terminal_shortcut_settings"."id" = 1)
);
--> statement-breakpoint
INSERT OR IGNORE INTO `terminal_shortcut_settings` (`id`, `updated_at`) VALUES (1, '1970-01-01T00:00:00.000Z');
