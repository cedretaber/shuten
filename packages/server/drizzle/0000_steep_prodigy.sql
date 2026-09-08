CREATE TABLE `candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`check_unit_id` text NOT NULL,
	`finding_id` text,
	`candidate_index` integer NOT NULL,
	`llm` text NOT NULL,
	`locate_status` text NOT NULL,
	`start` integer,
	`end` integer,
	`merge_key` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`check_unit_id`,`run_id`) REFERENCES `check_units`(`id`,`run_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`finding_id`,`run_id`) REFERENCES `findings`(`id`,`run_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `candidates_id_run_id_key` ON `candidates` (`id`,`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `candidates_run_id_candidate_index_key` ON `candidates` (`run_id`,`candidate_index`);--> statement-breakpoint
CREATE TABLE `check_units` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`target_id` text NOT NULL,
	`perspective` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`failure_reason` text,
	`failure_message` text,
	`failure_finish_reason` text,
	`failure_origin` text,
	`pending_note` text,
	`usage` text,
	`input_graphemes` integer,
	`elapsed_ms` integer,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_id`,`run_id`) REFERENCES `run_targets`(`id`,`run_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `check_units_target_id_perspective_key` ON `check_units` (`target_id`,`perspective`);--> statement-breakpoint
CREATE UNIQUE INDEX `check_units_id_run_id_key` ON `check_units` (`id`,`run_id`);--> statement-breakpoint
CREATE TABLE `diagnostics` (
	`candidate_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`quote` text NOT NULL,
	`reason` text NOT NULL,
	`search_start` integer NOT NULL,
	`search_end` integer NOT NULL,
	`exact_matches` text NOT NULL,
	`transform_version` text,
	`transform_candidates` text,
	`omitted` integer,
	`tied` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`candidate_id`,`run_id`) REFERENCES `candidates`(`id`,`run_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `findings` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`manuscript_version_id` text NOT NULL,
	`target_id` text NOT NULL,
	`locate_status` text NOT NULL,
	`start` integer,
	`end` integer,
	`paragraph_id` integer NOT NULL,
	`quote` text NOT NULL,
	`suggestion` text,
	`category` text NOT NULL,
	`initial_verdict` text NOT NULL,
	`merge_key` text,
	`suppression_word` text,
	`suppression_rule_version` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_id`,`run_id`) REFERENCES `run_targets`(`id`,`run_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`,`manuscript_version_id`) REFERENCES `runs`(`id`,`manuscript_version_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `findings_run_id_merge_key_key` ON `findings` (`run_id`,`merge_key`) WHERE "findings"."merge_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `findings_id_run_id_key` ON `findings` (`id`,`run_id`);--> statement-breakpoint
CREATE TABLE `judgments` (
	`finding_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`note` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`finding_id`) REFERENCES `findings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `manuscript_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`body` text NOT NULL,
	`body_hash` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recheck_units` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`finding_id` text NOT NULL,
	`input_start` integer,
	`input_end` integer,
	`status` text NOT NULL,
	`not_applicable_reason` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`failure_reason` text,
	`failure_message` text,
	`failure_finish_reason` text,
	`failure_origin` text,
	`pending_note` text,
	`verdict` text,
	`reason_kind` text,
	`reason` text,
	`suggestion_valid` integer,
	`usage` text,
	`input_graphemes` integer,
	`elapsed_ms` integer,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`finding_id`,`run_id`) REFERENCES `findings`(`id`,`run_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recheck_units_finding_id_key` ON `recheck_units` (`finding_id`);--> statement-breakpoint
CREATE TABLE `run_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`target_index` integer NOT NULL,
	`target_start` integer NOT NULL,
	`target_end` integer NOT NULL,
	`context_before_start` integer,
	`context_before_end` integer,
	`context_after_start` integer,
	`context_after_end` integer,
	`input_start` integer NOT NULL,
	`input_end` integer NOT NULL,
	`paragraph_ids` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_targets_run_id_target_index_key` ON `run_targets` (`run_id`,`target_index`);--> statement-breakpoint
CREATE UNIQUE INDEX `run_targets_id_run_id_key` ON `run_targets` (`id`,`run_id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`manuscript_version_id` text NOT NULL,
	`model_id` text NOT NULL,
	`model_info` text,
	`endpoint_url` text NOT NULL,
	`generation_settings` text NOT NULL,
	`chunk_settings` text NOT NULL,
	`timeouts` text NOT NULL,
	`perspectives` text NOT NULL,
	`recheck_enabled` integer NOT NULL,
	`allowed_words` text NOT NULL,
	`allowed_word_rule_version` text NOT NULL,
	`prompt_version` text NOT NULL,
	`diagnostic_transform_version` text NOT NULL,
	`status` text NOT NULL,
	`stop_reason` text,
	`stop_message` text,
	`generation_unconfirmed` integer DEFAULT false NOT NULL,
	`start_operation_id` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`manuscript_version_id`) REFERENCES `manuscript_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_start_operation_id_key` ON `runs` (`start_operation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `runs_id_manuscript_version_id_key` ON `runs` (`id`,`manuscript_version_id`);