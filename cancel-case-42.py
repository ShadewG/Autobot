#!/usr/bin/env python3
import psycopg2
import os
from datetime import datetime

# Get DATABASE_URL from env
DATABASE_URL = os.getenv('DATABASE_URL')

try:
    # Connect to database
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()

    # Cancel case 42 portal submission
    cur.execute("""
        UPDATE cases
        SET status = %s, portal_url = NULL, last_portal_status = %s
        WHERE id = 42
        RETURNING id, case_name, status
    """, ('sent', 'Cancelled - Odessa account locked'))

    result = cur.fetchone()
    print(f"Case 42 updated: ID={result[0]}, Name={result[1][:50]}, Status={result[2]}")

    # Log activity
    cur.execute("""
        INSERT INTO activity_log (case_id, event_type, description, created_at)
        VALUES (%s, %s, %s, %s)
    """, (42, 'portal_cancelled', 'Portal submission cancelled - Odessa account locked', datetime.now()))

    conn.commit()
    print("Activity logged for case 42")

    cur.close()
    conn.close()
    print("Successfully cancelled case 42 portal submission")

except Exception as e:
    print(f"Error: {e}")
