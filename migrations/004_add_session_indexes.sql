CREATE INDEX IF NOT EXISTS `idx_sessions_last_seen` ON `sessions` (`last_seen`);
CREATE INDEX IF NOT EXISTS `idx_sessions_created_at` ON `sessions` (`created_at`);
