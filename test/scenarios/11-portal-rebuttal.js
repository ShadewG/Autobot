/**
 * Scenario 11: Portal Case + Weak Denial
 *
 * Portal case receives a weak denial with no strong exemption citations.
 * The denial_subtype is null (unknown), key_points have zero strong
 * indicators, so assessDenialStrength returns 'weak'. In SUPERVISED mode,
 * the router proposes SEND_REBUTTAL. The portal_url does not block
 * rebuttals (SEND_REBUTTAL is in the replyActions allow-list).
 */

module.exports = {
  name: 'portal-rebuttal',
  description: 'Portal case + weak denial routes to SEND_REBUTTAL (portal does not block rebuttals)',

  seed: {
    case: {
      id: 1011,
      agency_name: 'San Jose Police Department',
      agency_email: 'foia@sanjosepd.gov',
      status: 'awaiting_response',
      state: 'CA',
      subject_name: 'David Chen',
      case_name: 'San Jose PD - David Chen FOIA',
      requested_records: ['Incident reports', 'Dispatch records'],
      constraints_jsonb: [],
      scope_items_jsonb: [
        { name: 'Incident reports', status: 'pending' },
        { name: 'Dispatch records', status: 'pending' }
      ],
      autopilot_mode: 'SUPERVISED',
      portal_url: 'https://sanjoseca.gov/portal'
    },
    messages: [
      {
        id: 2011,
        case_id: 1011,
        direction: 'inbound',
        from_email: 'records@sanjosepd.gov',
        subject: 'RE: FOIA Request - David Chen - Response',
        body_text: 'After review of your request, the records have been withheld pending further review by our legal department. We are unable to release these records at this time.',
        message_id: '<msg-2011@sanjosepd.gov>'
      }
    ],
    analyses: [
      {
        id: 3011,
        message_id: 2011,
        case_id: 1011,
        intent: 'denial',
        confidence_score: 0.85,
        sentiment: 'negative',
        key_points: [
          'Records withheld pending review'
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
      classification: 'DENIAL',
      confidence: 0.85,
      sentiment: 'negative',
      denial_subtype: null,
      key_points: [
        'Records withheld pending review'
      ]
    },
    draft: {
      subject: 'Re: FOIA Request - David Chen - Response to Denial',
      body: 'Stubbed response body for testing'
    }
  },

  stateOverrides: {
    triggerType: 'agency_reply',
    latestInboundMessageId: 2011
  },

  expected: {
    proposalActionType: 'SEND_REBUTTAL',
    requiresHuman: true,
    canAutoExecute: false
  }
};
