CREATE TABLE IF NOT EXISTS `users` (
    `username` TEXT PRIMARY KEY COLLATE NOCASE,
    `password_hash` TEXT NOT NULL,
    `password_salt` TEXT NOT NULL,
    `password_iterations` INTEGER NOT NULL,
    `password_algorithm` TEXT NOT NULL,
    `role` TEXT NOT NULL CHECK (`role` IN ('admin', 'user')),
    `disabled` INTEGER NOT NULL DEFAULT 0 CHECK (`disabled` IN (0, 1)),
    `created_at` INTEGER NOT NULL,
    `updated_at` INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS `auth_sessions` (
    `token_hash` TEXT PRIMARY KEY,
    `username` TEXT NOT NULL,
    `created_at` INTEGER NOT NULL,
    `expires_at` INTEGER NOT NULL,
    FOREIGN KEY (`username`) REFERENCES `users` (`username`) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS `idx_auth_sessions_expires_at`
    ON `auth_sessions` (`expires_at`);

CREATE INDEX IF NOT EXISTS `idx_auth_sessions_username`
    ON `auth_sessions` (`username`);

CREATE TABLE IF NOT EXISTS `apns_credentials` (
    `id` INTEGER PRIMARY KEY CHECK (`id` = 1),
    `ciphertext` TEXT NOT NULL,
    `iv` TEXT NOT NULL,
    `key_version` INTEGER NOT NULL,
    `updated_by` TEXT NOT NULL,
    `updated_at` INTEGER NOT NULL,
    FOREIGN KEY (`updated_by`) REFERENCES `users` (`username`)
);
