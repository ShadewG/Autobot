# Claude 1 — Frontend: List Pages, Eval, Runs, Agencies, Settings

**Scope**: All dashboard pages EXCEPT `requests/detail/` and `requests/detail-v2/`.
**Files you own** (only edit these):

```
dashboard/app/page.tsx
dashboard/app/inbox/page.tsx
dashboard/app/queue/page.tsx
dashboard/app/portal-tasks/page.tsx
dashboard/app/agencies/page.tsx
dashboard/app/agencies/detail/page.tsx
dashboard/app/eval/page.tsx
dashboard/app/runs/page.tsx
dashboard/app/shadow/page.tsx
dashboard/app/simulate/page.tsx
dashboard/app/requests/page.tsx
dashboard/app/gated/page.tsx
dashboard/app/admin/page.tsx
dashboard/app/settings/page.tsx
dashboard/components/inbox-sections.tsx
dashboard/components/notion-import.tsx
dashboard/components/user-filter.tsx
dashboard/components/request-table.tsx
```

**DO NOT edit** (shared with Claude 2):
`auth-provider.tsx`, `thread.tsx`, `linkified-text.tsx`, `add-correspondence-dialog.tsx`, any `dashboard/lib/` files, any `dashboard/components/ui/` files.

---

## Tasks

### Phase 1 P0

#### System Health Dashboard Card
- [ ] Add "System Health" card to main dashboard page: stuck cases, orphaned runs, stale proposals, overdue deadlines
- [ ] Each metric red if > 0, clickable to filtered view
- [ ] API endpoint: `GET /api/health/summary` → `{ stuck_cases: N, orphaned_runs: N, stale_proposals: N, overdue_deadlines: N }`

#### Operator Workflow — Bulk Actions (`/gated`)
- [ ] Add checkbox column to gated proposals list
- [ ] "Select All" / "Deselect All" toggle
- [ ] "Approve Selected" and "Dismiss Selected" buttons with confirmation dialog
- [ ] Batch API call: `POST /api/proposals/batch-decision` with `{ ids: [...], decision: "APPROVE" | "DISMISS" }`

#### Operator Workflow — Search (`/requests`)
- [ ] Add full-text search bar to requests page
- [ ] Search across: case name, agency name, subject name, email content
- [ ] API endpoint: `GET /api/requests?search=<query>` with `ts_vector` or `ILIKE` search
- [ ] Debounced input, loading state, empty state

#### Mobile Polish
- [ ] `/eval` — verify error toasts work on mobile, failure categories don't overflow
- [ ] `/runs` — verify dialog fits at 390px
- [ ] `/agencies` — verify table scrolls horizontally on mobile
- [ ] `/portal-tasks` — verify layout at 390px
- [ ] `/gated` — verify bulk action buttons don't overflow on mobile

### Phase 1 P1

#### Notion Sync UI
- [ ] Add "Sync Now" button on requests page (triggers `POST /api/notion/sync`)
- [ ] Add "last synced" timestamp badge per case in request list
- [ ] Loading spinner while sync is in progress

#### Constraint Management UI
- [ ] Show constraints list on case in `/gated` detail view
- [ ] "Remove constraint" button per constraint
- [ ] "Add constraint" form (tag + note)
- [ ] API: `DELETE /api/cases/:id/constraints/:tag`, `POST /api/cases/:id/constraints`

### Phase 2

#### Eval Dashboard Enhancements
- [ ] Decision quality over time chart (7d rolling) on `/eval`
- [ ] Classification confusion matrix visualization
- [ ] Filter eval cases by failure_category
- [ ] Track eval results over time — score trend line

#### Bug Reporting
- [ ] "Report Issue" button on `/gated` case detail (captures case ID, state, operator notes)
- [ ] Auto-creates GitHub issue via `POST /api/issues`
- [ ] Operator annotation tags: "AI wrong", "agency difficult", "unusual" — filterable on `/requests`

#### Agency Intelligence UI
- [ ] Agency detail page (`/agencies/detail`): show per-agency metrics (avg response time, denial rate, common denial reasons)
- [ ] Agency stats card on `/gated` when reviewing a case for that agency

#### Analytics Dashboard
- [ ] Case outcome dashboard page: records received rate, avg time, denial rate — by state, agency type
- [ ] Cost tracking display: AI + email + portal cost per case
