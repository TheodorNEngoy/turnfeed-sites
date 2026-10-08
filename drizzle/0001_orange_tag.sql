CREATE TABLE `turnfeed_state_records` (
	`record_id` text NOT NULL,
	`part` integer NOT NULL,
	`value` text NOT NULL,
	`digest` text NOT NULL,
	PRIMARY KEY(`record_id`, `part`)
);
--> statement-breakpoint
ALTER TABLE `turnfeed_state_head` ADD `storage_format` integer DEFAULT 1 NOT NULL;