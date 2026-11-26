CREATE TABLE `device_states` (
	`device_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`state` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `device_states_pk` PRIMARY KEY(`device_id`, `plugin_id`)
);
