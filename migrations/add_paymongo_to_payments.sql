-- eli: Run this SQL once on your database to support PayMongo payments and refunds.
-- Safe to run more than once (uses IF NOT EXISTS / MODIFY checks won't fail).

-- 1. Fix the status ENUM to include refund_pending (was missing, making refund logic unreachable)
-- eli to eli: MySQL requires listing ALL enum values when you MODIFY a column, not just the new one.
ALTER TABLE payments
    MODIFY COLUMN status ENUM('pending', 'paid', 'refund_pending', 'refunded') NOT NULL DEFAULT 'pending';

-- 2. Store the PayMongo Payment Link ID so we can fetch its status and issue refunds later
ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS paymongo_link_id VARCHAR(100) NULL AFTER method,
    ADD COLUMN IF NOT EXISTS paymongo_payment_id VARCHAR(100) NULL AFTER paymongo_link_id,
    ADD COLUMN IF NOT EXISTS checkout_url TEXT NULL AFTER paymongo_payment_id,
    ADD COLUMN IF NOT EXISTS paid_at DATETIME NULL AFTER checkout_url;
