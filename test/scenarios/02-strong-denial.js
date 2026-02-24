/**
 * Scenario 02: Strong Denial
 *
 * Agency cites court proceedings, sealed records, and ongoing investigation.
 * The denial_subtype is 'ongoing_investigation', and the key_points contain
 * multiple strong indicators (sealed, ongoing investigation, privacy).
 * assessDenialStrength returns 'strong' -> CLOSE_CASE.
 */

module.exports = {
  name: 'strong-denial',
  description: 'Strong denial (court proceedings + sealed records) routes to CLOSE_CASE',

  seed: {
    case: {
      id: 1002,
      agency_name: 'Metro Police Department',
      agency_email: 'foia@metropd.gov',
      status: 'awaiting_response',
      state: 'CA',
      subject_name: 'Jane Smith',
      case_name: 'Metro PD - Jane Smith FOIA',
      requested_records: ['Incident reports', 'Body camera footage'],
      constraints_jsonb: [],
      scope_items_jsonb: [
        { name: 'Incident reports', status: 'pending' },
        { name: 'Body camera footage', status: 'pending' }
      ],
      autopilot_mode: 'SUPERVISED',
      portal_url: null
    },
    messages: [
      {
        id: 2002,
        case_id: 1002,
        direction: 'inbound',
        from_email: 'records@metropd.gov',
        subject: 'RE: FOIA Request - Jane Smith',
        body_text: 'Your request is denied. The records are sealed per court order due to an ongoing investigation. Additionally, the privacy exemption applies to the individuals named in the report.',
        message_id: '<msg-2002@metropd.gov>'
      }
    ],
    analyses: [
      {
        id: 3002,
        message_id: 2002,
        case_id: 1002,
        intent: 'denial',
        confidence_score: 0.95,
        sentiment: 'negative',
        key_points: [
          'Records sealed per court order',
          'Ongoing investigation exemption applies',
          'Privacy exemption cited'
        ],
        extracted_fee_amount: null,
        full_analysis_json: {
          denial_subtype: 'ongoing_investigation',
          constraints_to_add: ['SEALED_RECORDS', 'ONGOING_INVESTIGATION']
        },
        requires_action: true
      }
    ],
    followup: null
  },

  llmStubs: {
    classify: {
      classification: 'DENIAL',
      confidence: 0.95,
      sentiment: 'negative',
      key_points: [
        'Records sealed per court order',
        'Ongoing investigation exemption applies',
        'Privacy exemption cited'
      ],
      denial_subtype: 'ongoing_investigation'
    },
    draft: {
      subject: 'Re: FOIA Request - Jane Smith - Appeal',
      body: 'Stubbed response body for testing'
    }
  },

  stateOverrides: {
    triggerType: 'agency_reply',
    latestInboundMessageId: 2002
  },

  expected: {
    proposalActionType: 'CLOSE_CASE',
    requiresHuman: true,
    canAutoExecute: false
  }
};
