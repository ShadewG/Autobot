const assert = require('assert');
const { toTimelineEvent } = require('../routes/requests/_helpers');

describe('Request history normalization', function () {
  it('rewrites stale portal workflow titles using current case identity even without case_name', function () {
    const event = toTimelineEvent(
      {
        id: 1,
        case_id: 25207,
        event_type: 'portal_workflow_triggered',
        description: 'Skyvern workflow triggered for stale unrelated case title',
        created_at: '2026-03-06T01:45:00.000Z',
        metadata: {},
      },
      {},
      {
        id: 25207,
        subject_name: 'Ryan Campbell',
        requested_records: ['Body camera footage', '911/dispatch audio'],
      }
    );

    assert.strictEqual(
      event.summary,
      'Skyvern workflow triggered for Ryan Campbell — Body camera footage, 911/dispatch audio.'
    );
  });

  it('prefers serialized request.subject when subject_name is unavailable', function () {
    const event = toTimelineEvent(
      {
        id: 2,
        case_id: 25207,
        event_type: 'portal_run_started',
        description: 'Skyvern portal automation started for stale unrelated case title',
        created_at: '2026-03-06T01:42:00.000Z',
        metadata: {},
      },
      {},
      {
        id: 25207,
        subject: 'Ryan Campbell — Body camera footage, 911/dispatch audio',
        case_name: 'Ryan Campbell Pontotoc County teen sentenced to 20 years in prison',
        requested_records: 'Body camera footage, 911/dispatch audio, Surveillance video',
      }
    );

    assert.strictEqual(
      event.summary,
      'Skyvern portal automation started for Ryan Campbell — Body camera footage, 911/dispatch audio.'
    );
  });
});
