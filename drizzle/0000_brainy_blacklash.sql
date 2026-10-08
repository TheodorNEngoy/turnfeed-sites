CREATE TABLE `turnfeed_state_chunks` (
	`revision` text NOT NULL,
	`position` integer NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`revision`, `position`)
);
--> statement-breakpoint
CREATE TABLE `turnfeed_state_head` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` text NOT NULL,
	`digest` text NOT NULL,
	`chunks` integer NOT NULL,
	`bytes` integer NOT NULL
);
