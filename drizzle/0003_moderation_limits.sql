CREATE TABLE `turnfeed_moderation_limits` (
	`bucket` text PRIMARY KEY NOT NULL,
	`minute` integer NOT NULL,
	`count` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `turnfeed_moderation_limits_minute` ON `turnfeed_moderation_limits` (`minute`);