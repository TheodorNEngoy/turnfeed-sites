CREATE TABLE `turnfeed_write_receipts` (
	`owner` text NOT NULL,
	`part` integer NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`owner`, `part`)
);
