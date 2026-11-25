CREATE TABLE `commands` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`command` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL
);
