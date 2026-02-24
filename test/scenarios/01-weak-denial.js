/**
 * Scenario 01: Weak Denial
 *
 * Agency sends a generic refusal with no strong exemption citations.
 * The denial strength assessment finds zero strong indicators, so it falls
 * into the default/unknown subtype "weak" branch -> SEND_REBUTTAL.
 */

module.exports = {
  name: 'weak-denial',
  description: 'Weak denial (generic refusal, no strong exemptions) routes to SEND_REBUTTAL',

  seed: {
    case: {
      id: 1001,
      agency_name: 'Springfield Police Department',
      agency_email: 'foia@springfieldpd.gov',
      status: 'awaiting_response',
      state: 'IL',
      subject_name: 'John Doe',
      case_name: 'Springfield PD - John Doe FOIA',
      requested_records: ['Body camera footage', 'Incident reports'],
      constraints_jsonb: [],
      scope_items_jsonb: [
        { name: 'Body camera footage', status: 'pending' },
        { name: 'Incident reports', status: 'pending' }
      ],
      autopilot_mode: 'SUPERVISED',
      portal_url: null
    },
    messages: [
      {
        id: 2001,
        case_id: 1001,
        direction: 'inbound',
        from_email: 'records@springfieldpd.gov',
        subject: 'RE: FOIA Request - John Doe',
        body_text: 'Your request has been denied. The records you requested are not available at this time. If you have questions, please contact our office.',
        message_id: '<msg-2001@springfieldpd.gov>'
      }
    ],
    analyses: [
      {
        id: 3001,
        message_id: 2001,
        case_id: 1001,
        intent: 'denial',
        confidence_score: 0.92,
        sentiment: 'negative',
        key_points: [
          'Request has been denied',
          'Records are not available at this time'
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
      confidence: 0.92,
      sentiment: 'negative',
      key_points: [
        'Request has been denied',
        'Records are not available at this time'
      ],
      denial_subtype: null
    },
    draft: {
      subject: 'Re: FOIA Request - John Doe - Response to Denial',
      body: 'Stubbed response body for testing'
    }
  },

  stateOverrides: {
    triggerType: 'agency_reply',
    latestInboundMessageId: 2001
  },

  expected: {
    proposalActionType: 'SEND_REBUTTAL',
    requiresHuman: true,
    canAutoExecute: false
  }
};
