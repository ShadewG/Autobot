/**
 * Scenario 06: Records Ready
 *
 * Agency notifies that records are ready for download. Classification is
 * RECORDS_READY with requires_response=false and suggested_action='download'.
 * The router marks the case complete with proposalActionType=NONE.
 */

module.exports = {
  name: 'records-ready',
  description: 'Records ready for download routes to NONE (case complete)',

  seed: {
    case: {
      id: 1006,
      agency_name: 'Seattle Police Department',
      agency_email: 'foia@seattlepd.gov',
      status: 'awaiting_response',
      state: 'WA',
      subject_name: 'Chris Davis',
      case_name: 'Seattle PD - Chris Davis FOIA',
      requested_records: ['Incident reports', 'Witness statements'],
      constraints_jsonb: [],
      scope_items_jsonb: [
        { name: 'Incident reports', status: 'pending' },
        { name: 'Witness statements', status: 'pending' }
      ],
      autopilot_mode: 'SUPERVISED',
      portal_url: null
    },
    messages: [
      {
        id: 2006,
        case_id: 1006,
        direction: 'inbound',
        from_email: 'records@seattlepd.gov',
        subject: 'RE: FOIA Request - Chris Davis - Records Available',
        body_text: 'The records responsive to your request are now available for download. Please use the link below to access your documents. Link: https://seattlepd.gov/records/download/12345',
        message_id: '<msg-2006@seattlepd.gov>'
      }
    ],
    analyses: [
      {
        id: 3006,
        message_id: 2006,
        case_id: 1006,
        intent: 'records_ready',
        confidence_score: 0.99,
        sentiment: 'positive',
        key_points: [
          'Records are available for download',
          'Download link provided'
        ],
        extracted_fee_amount: null,
        full_analysis_json: {
          denial_subtype: null,
          constraints_to_add: []
        },
        requires_action: false
      }
    ],
    followup: null
  },

  llmStubs: {
    classify: {
      classification: 'RECORDS_READY',
      confidence: 0.99,
      sentiment: 'positive',
      requires_response: false,
      suggested_action: 'download',
      key_points: [
        'Records are available for download',
        'Download link provided'
      ]
    },
    draft: null
  },

  stateOverrides: {
    triggerType: 'agency_reply',
    latestInboundMessageId: 2006
  },

  expected: {
    proposalActionType: 'NONE',
    isComplete: true
  }
};
