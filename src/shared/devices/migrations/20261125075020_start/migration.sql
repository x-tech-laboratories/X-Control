CREATE TABLE `paired_devices` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`certificate` text NOT NULL,
	`paired_at` text NOT NULL,
	`last_address` text,
	`last_seen` text
);
