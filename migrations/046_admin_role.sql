-- 043_admin_role.sql
-- Add admin role to users table

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false;

-- Set Sam as admin
UPDATE users SET is_admin = true WHERE LOWER(name) = 'sam';
