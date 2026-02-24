/**
 * Scenario 09: Hostile Sentiment
 *
 * Agency responds with hostile tone. Classification is HOSTILE, which
 * always routes to ESCALATE with human gating.
 */

module.exports = {
  name: 'hostile-sentiment',
  description: 'Hostile agency response routes to ESCALATE',

  seed: {
    case: {
      id: 1009,
      agency_name: 'Dallas Police Department',
      agency_email: 'foia@dallaspd.gov',
      status: 'awaiting_response',
      state: 'TX',
      subject_name: 'Tom Wilson',
      case_name: 'Dallas PD - Tom Wilson FOIA',
      requested_records: ['Use of force reports', 'Internal affairs files'],
      constraints_jsonb: [],
      scope_items_jsonb: [
        { name: 'Use of force reports', status: 'pending' },
        { name: 'Internal affairs files', status: 'pending' }
      ],
      autopilot_mode: 'SUPERVISED',
      portal_url: null
    },
    messages: [
      {
        id: 2009,
        case_id: 1009,
        direction: 'inbound',
        from_email: 'records@dallaspd.gov',
        subject: 'RE: FOIA Request - Tom Wilson',
        body_text: 'Stop sending us these frivolous requests. We have no obligation to dig through our files for your fishing expedition. Do not contact this office again regarding this matter.',
        message_id: '<msg-2009@dallaspd.gov>'
      }
    ],
    analyses: [
      {
        id: 3009,
        message_id: 2009,
        case_id: 1009,
        intent: 'hostile',
        confidence_score: 0.88,
        sentiment: 'hostile',
        key_points: [
          'Agency characterizes request as frivolous',
          'Agency refuses to search records',
          'Agency demands no further contact'
        ],
        extracted_fee_amount: null,
        full_analysis_json: {
          denial_subtype: null,
          constraints_to_add: []
        },
        requires_action: true
      }
    ],
    followup: null
  },

  llmStubs: {
    classify: {
      classification: 'HOSTILE',
      confidence: 0.88,
      sentiment: 'hostile',
      key_points: [
        'Agency characterizes request as frivolous',
        'Agency refuses to search records',
        'Agency demands no further contact'
      ]
    },
    draft: null
  },

  stateOverrides: {
    triggerType: 'agency_reply',
    latestInboundMessageId: 2009
  },

  expected: {
    proposalActionType: 'ESCALATE',
    requiresHuman: true,
    canAutoExecute: false
  }
};
