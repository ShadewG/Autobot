# Monitor Live Test Checklist

Use this checklist after each deploy that touches monitor, run-engine, drafting, or execution logic.

## Preconditions
- Runtime is hardcoded `LIVE` and shadow mode is off.
- Server healthy: `GET /health` returns `status: ok`.
- SendGrid inbound webhook is receiving mail.

## Scenario A: Clarification Request
1. Open `/monitor.html`, select an inbound message drawer with a linked case.
2. In Simulation panel, create:
   - `from_email`: agency sender
   - `subject`: case reply subject
   - `body_text`: `Hi, what specific materials are you looking for?`
3. Click `Create + Trigger AI`.
4. Verify:
   - Run status reaches `paused`.
   - Proposal action is `SEND_CLARIFICATION`.
   - Draft answers clarification and does not mention stale test text.
5. Click `Approve`.
6. Verify:
   - Proposal status becomes `EXECUTED`.
   - `email_job_id` is present and not prefixed with `dry_run_`.
   - Outbound message appears in monitor with `sendgrid_message_id`.
   - Case status moves to `awaiting_response`.

## Scenario B: Acknowledgment (No Response)
1. Simulate inbound body: `We received your request and are processing.`
2. Trigger AI.
3. Verify:
   - Run reaches terminal `completed`.
   - No proposal is created.
   - No outbound message created.

## Scenario C: Fee Quote
1. Simulate inbound body: `Estimated fee is $35. Please confirm to proceed.`
2. Trigger AI.
3. Verify:
   - Fee amount extracted in analysis.
   - Proposal path is fee-related and gated per policy.

## Scenario D: Denial / Rebuttal
1. Simulate inbound denial text with legal citation.
2. Trigger AI.
3. Verify:
   - Classification routes to denial branch.
   - Appropriate rebuttal/denial proposal generated.

## Scenario E: Active Run Collision
1. Trigger one inbound run.
2. Trigger another run for same case without force.
3. Verify:
   - API returns `409` with `activeRun` metadata.
4. Trigger with force.
5. Verify:
   - Previous run gets cancellation error.
   - New run queued and starts.

## Regression Checks (Always)
- Re-triggering same message without override does not create new inbound message row.
- Proposal decisions from monitor (`APPROVE|ADJUST|DISMISS`) return concrete success/error with status code.
- No run remains `running` beyond timeout at `commit_state`.

## API Smoke Commands

### Simulate inbound
```bash
curl -X POST http://localhost:3000/api/monitor/simulate-inbound \
  -H "Content-Type: application/json" \
  -d '{
    "case_id": 49,
    "subject": "Re: Case of Darren Watkins",
    "body_text": "Hi, what specific materials are you looking for?",
    "from_email": "records@agency.gov",
    "attach_to_thread": true,
    "mark_processed": false
  }'
```

### Trigger inbound run
```bash
curl -X POST http://localhost:3000/api/monitor/trigger-inbound-run \
  -H "Content-Type: application/json" \
  -d '{
    "message_id": 410,
    "autopilotMode": "SUPERVISED",
    "force_new_run": false
  }'
```

### Proposal decision
```bash
curl -X POST http://localhost:3000/api/monitor/proposals/124/decision \
  -H "Content-Type: application/json" \
  -d '{
    "action": "APPROVE",
    "instruction": null,
    "reason": "manual test"
  }'
```

## Monitoring Queries

### Stuck runs older than 2 minutes
```sql
SELECT id, case_id, trigger_type, status, started_at, metadata
FROM agent_runs
WHERE status = 'running'
  AND started_at < NOW() - INTERVAL '2 minutes'
ORDER BY started_at ASC;
```

### Executed proposals without outbound within 60 seconds
```sql
SELECT p.id AS proposal_id, p.case_id, p.executed_at, p.email_job_id
FROM proposals p
LEFT JOIN messages m
  ON m.case_id = p.case_id
 AND m.direction = 'outbound'
 AND m.created_at >= p.executed_at
 AND m.created_at <= p.executed_at + INTERVAL '60 seconds'
WHERE p.status = 'EXECUTED'
  AND p.executed_at IS NOT NULL
  AND m.id IS NULL
ORDER BY p.executed_at DESC;
```
