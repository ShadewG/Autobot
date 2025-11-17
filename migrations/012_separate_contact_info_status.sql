-- Migration: Separate missing contact info cases from other human reviews
-- Created: 2025-11-17
-- Description: Creates a dedicated status for cases missing contact information
--              to distinguish them from cases needing actual content review

-- Update existing cases that are marked for human review due to missing contact info
-- to use the new dedicated status 'needs_contact_info'
UPDATE cases
SET
    status = 'needs_contact_info',
    updated_at = CURRENT_TIMESTAMP
WHERE
    status = 'needs_human_review'
    AND (
        substatus ILIKE '%missing contact%'
        OR substatus ILIKE '%no valid portal or email%'
        OR substatus ILIKE '%no contact info%'
        OR substatus ILIKE '%No valid portal%'
    );

-- Log the migration
DO $$
DECLARE
    updated_count INTEGER;
BEGIN
    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RAISE NOTICE 'Migration completed: Updated % cases from needs_human_review to needs_contact_info', updated_count;

    -- Log to activity log for audit trail
    INSERT INTO activity_log (event_type, description, metadata)
    VALUES (
        'migration_012_contact_info_status',
        'Migrated cases with missing contact info to new dedicated status',
        jsonb_build_object(
            'updated_count', updated_count,
            'migration_date', CURRENT_TIMESTAMP
        )
    );
END $$;
