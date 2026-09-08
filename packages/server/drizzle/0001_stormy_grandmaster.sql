ALTER TABLE `runs` ADD `recovery_confirm_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `stop_requested_at` integer;