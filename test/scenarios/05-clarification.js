/**
 * Scenario 05: Clarification Request
 *
 * Agency asks for more details about the records being requested.
 * Classification is CLARIFICATION_REQUEST. In SUPERVISED mode with
 * non-hostile sentiment, canAutoExecute is false and requiresHuman is true.
 */

module.exports = {
  name: 'clarification',
  description: 'Agency asks clarifying question routes to SEND_CLARIFICATION',

  seed: {
    case: {
      id: 1005,
      agency_name: 'Portland Police Bureau',
      agency_email: 'records@portlandpolice.gov',
      status: 'awaiting_response',
      state: 'OR',
      subject_name: 'Alex Turner',
      case_name: 'Portland PD - Alex Turner FOIA',
      requested_records: ['Police reports', 'CAD logs'],
      constraints_jsonb: [],
      scope_items_jsonb: [
        { name: 'Police reports', status: 'pending' },
        { name: 'CAD logs', status: 'pending' }
      ],
      autopilot_mode: 'SUPERVISED',
      portal_url: null
    },
    messages: [
      {
        id: 2005,
        case_id: 1005,
        direction: 'inbound',
        from_email: 'foia@portlandpolice.gov',
        subject: 'RE: FOIA Request - Alex Turner - Additional Information Needed',
        body_text: 'Thank you for your request. Could you please provide the specific date range and incident number for the records you are seeking? This will help us locate the responsive documents more efficiently.',
        message_id: '<msg-2005@portlandpolice.gov>'
      }
    ],
    analyses: [
      {
        id: 3005,
        message_id: 2005,
        case_id: 1005,
        intent: 'question',
        confidence_score: 0.93,
        sentiment: 'neutral',
        key_points: [
          'Agency requests specific date range',
          'Agency requests incident number',
          'Willing to process once details provided'
        ],
        extracted_fee_amount: null,
        full_analysis_json: {
          denial_subtype: null,
          constraints_to_add: ['ID_REQUIRED']
        },
        requires_action: true
      }
    ],
    followup: null
  },

  llmStubs: {
    classify: {
      classification: 'CLARIFICATION_REQUEST',
      confidence: 0.93,
      sentiment: 'neutral',
      key_points: [
        'Agency requests specific date range',
        'Agency requests incident number',
        'Willing to process once details provided'
      ]
    },
    draft: {
      subject: 'Re: FOIA Request - Alex Turner - Clarification',
      body: 'Stubbed response body for testing'
    }
  },

  stateOverrides: {
    triggerType: 'agency_reply',
    latestInboundMessageId: 2005
  },

  expected: {
    proposalActionType: 'SEND_CLARIFICATION',
    requiresHuman: true,
    canAutoExecute: false
  }
};
