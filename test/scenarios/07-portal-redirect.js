/**
 * Scenario 07: Portal Redirect
 *
 * Agency instructs us to use their online portal instead of email.
 * Classification is PORTAL_REDIRECT with requires_response=false,
 * suggested_action='use_portal', and portal_url extracted.
 * The router creates a portal task and marks the case complete with NONE.
 */

module.exports = {
  name: 'portal-redirect',
  description: 'Agency says use portal routes to NONE (portal task created)',

  seed: {
    case: {
      id: 1007,
      agency_name: 'Chicago Police Department',
      agency_email: 'foia@chicagopd.gov',
      status: 'awaiting_response',
      state: 'IL',
      subject_name: 'Robert Brown',
      case_name: 'Chicago PD - Robert Brown FOIA',
      requested_records: ['Arrest reports', 'Mugshots'],
      constraints_jsonb: [],
      scope_items_jsonb: [
        { name: 'Arrest reports', status: 'pending' },
        { name: 'Mugshots', status: 'pending' }
      ],
      autopilot_mode: 'SUPERVISED',
      portal_url: null
    },
    messages: [
      {
        id: 2007,
        case_id: 1007,
        direction: 'inbound',
        from_email: 'foia@chicagopd.gov',
        subject: 'RE: FOIA Request - Robert Brown - Portal Submission Required',
        body_text: 'The City of Chicago requires all FOIA requests to be submitted through our online portal. Please visit https://foia.chicago.gov to submit your request. We cannot process requests received via email.',
        message_id: '<msg-2007@chicagopd.gov>'
      }
    ],
    analyses: [
      {
        id: 3007,
        message_id: 2007,
        case_id: 1007,
        intent: 'portal_redirect',
        confidence_score: 0.96,
        sentiment: 'neutral',
        key_points: [
          'Agency requires portal submission',
          'Portal URL: https://foia.chicago.gov',
          'Email requests not accepted'
        ],
        extracted_fee_amount: null,
        full_analysis_json: {
          denial_subtype: null,
          constraints_to_add: [],
          portal_url: 'https://foia.chicago.gov'
        },
        requires_action: false
      }
    ],
    followup: null
  },

  llmStubs: {
    classify: {
      classification: 'PORTAL_REDIRECT',
      confidence: 0.96,
      sentiment: 'neutral',
      requires_response: false,
      suggested_action: 'use_portal',
      portal_url: 'https://foia.chicago.gov',
      key_points: [
        'Agency requires portal submission',
        'Portal URL: https://foia.chicago.gov',
        'Email requests not accepted'
      ]
    },
    draft: null
  },

  stateOverrides: {
    triggerType: 'agency_reply',
    latestInboundMessageId: 2007
  },

  expected: {
    proposalActionType: 'NONE',
    isComplete: true
  }
};
