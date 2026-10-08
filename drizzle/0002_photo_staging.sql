CREATE TABLE `turnfeed_photo_daily` (
	`owner` text NOT NULL,
	`day` text NOT NULL,
	`count` integer NOT NULL,
	PRIMARY KEY(`owner`, `day`)
);
--> statement-breakpoint
CREATE TABLE `turnfeed_photos` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`object_key` text NOT NULL,
	`mime` text NOT NULL,
	`bytes` integer NOT NULL,
	`digest` text NOT NULL,
	`status` text NOT NULL,
	`claim` text NOT NULL,
	`created_at` integer NOT NULL,
	`day` text NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER `turnfeed_photo_count_day` AFTER INSERT ON `turnfeed_photos`
BEGIN
  INSERT INTO `turnfeed_photo_daily` (`owner`, `day`, `count`) VALUES (NEW.owner, NEW.day, 1)
  ON CONFLICT (`owner`, `day`) DO UPDATE SET `count` = `count` + 1;
END;
