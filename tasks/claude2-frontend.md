# Claude 2 — Frontend: Case Detail Pages & Components

**Scope**: Case detail pages and their exclusive components.
**Files you own** (only edit these):

```
dashboard/app/requests/detail/page.tsx
dashboard/app/requests/detail-v2/page.tsx
dashboard/components/copilot-panel.tsx
dashboard/components/decision-panel.tsx
dashboard/components/draft-approval-panel.tsx
dashboard/components/inbound-evidence-panel.tsx
dashboard/components/timeline.tsx
dashboard/components/composer.tsx
dashboard/components/adjust-modal.tsx
dashboard/components/deadline-calculator.tsx
dashboard/components/proposal-status.tsx
dashboard/components/snooze-modal.tsx
dashboard/components/autopilot-selector.tsx
dashboard/components/safety-hints.tsx
dashboard/components/paste-inbound-dialog.tsx
dashboard/components/case-info-tab.tsx
dashboard/components/portal-live-view.tsx
dashboard/components/scope-table.tsx
dashboard/components/constraints-display.tsx
dashboard/components/fee-breakdown.tsx
dashboard/components/exemption-claim-card.tsx
dashboard/components/due-display.tsx
```

**DO NOT edit** (shared with Claude 1):
`auth-provider.tsx`, `thread.tsx`, `linkified-text.tsx`, `add-correspondence-dialog.tsx`, any `dashboard/lib/` files, any `dashboard/components/ui/` files.

---

## Tasks

### Phase 1 P0

#### Agency Validation Warning Banner
- [ ] Yellow warning banner on case detail when agency has validation issues (bad email, no directory match, state mismatch)
- [ ] API field: `case.agency_warnings: string[]` — rendered as dismissable alert at top of detail page
- [ ] Link to agency detail page from warning

#### Mobile Polish — Detail Pages
- [ ] `detail-v2` tab bar: verify no overflow at 390px (separator already hidden on mobile)
- [ ] `detail-v2` pending proposal section: verify LinkifiedText renders correctly on mobile
- [ ] Copilot panel: verify draft preview readable at 390px
- [ ] Decision panel: verify draft content doesn't overflow
- [ ] Timeline: verify scrollable and readable on mobile
- [ ] Composer: verify send button accessible on mobile keyboard

### Phase 1 P1

#### Case Timeline View
- [ ] Add "Timeline" tab to detail-v2 page
- [ ] Show every state transition chronologically: import → draft → approval → send → response → classify → decide
- [ ] Each event: timestamp, actor (system/human/AI), action, details
- [ ] API endpoint: `GET /api/cases/:id/timeline` → array of events
- [ ] Render using existing `timeline.tsx` component or extend it

#### Constraint Management on Detail Page
- [ ] Show constraints list in case-info-tab with remove/add capability
- [ ] Constraint history: when added, by whom/what
- [ ] Inline "Add constraint" form

#### Proposal Content Versioning
- [ ] Show diff between original AI draft and human-edited version on detail page
- [ ] "Original draft" expandable section on draft-approval-panel when `human_edited: true`
- [ ] Visual diff highlighting (green = added, red = removed)

### Phase 2

#### Bug Report from Detail Page
- [ ] "Report Issue" button on case detail-v2 page header
- [ ] Modal: pre-fills case ID, current state, agency, recent activity
- [ ] Operator can add notes
- [ ] Submits to `POST /api/issues`

#### Decision Trace Viewer
- [ ] New tab or section in detail-v2: "AI Decision Trace"
- [ ] Shows: classification output, router decision, allowed actions, chosen action, reasoning, gate decision
- [ ] Source: `GET /api/cases/:id/decision-traces`
- [ ] Collapsible sections for prompt/response (for debugging)

#### Agency Stats on Case Detail
- [ ] Small card in case-info-tab showing agency metrics: avg response time, denial rate, success rate
- [ ] Source: `GET /api/agencies/:id/stats`

#### Draft Quality Feedback
- [ ] After case resolves, show eval judge score on the sent drafts in timeline
- [ ] Thumbs up/down on each draft in inbound-evidence-panel for operator feedback
