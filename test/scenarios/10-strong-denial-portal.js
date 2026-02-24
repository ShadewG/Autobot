/**
 * Scenario 10: Strong Denial on Portal Case
 *
 * Portal case receives a strong denial citing privacy exemption.
 * The portal_url on the case does not change denial routing. Multiple
 * strong indicators (privacy, exempt, state law) yield 'strong' strength,
 * so the router recommends CLOSE_CASE regardless of portal status.
 */

module.exports = {
  name: 'strong-denial-portal',
  description: 'Portal case + strong denial routes to CLOSE_CASE (portal does not change denial routing)',

  seed: {
    case: {
      id: 1010,
      agency_name: 'LA County Sheriff',
      agency_email: 'foia@lasd.gov',
      status: 'awaiting_response',
      state: 'CA',
      subject_name: 'Maria Lopez',
      case_name: 'LA County Sheriff - Maria Lopez FOIA',
      requested_records: ['Arrest records', 'Booking photos'],
      constraints_jsonb: [],
      scope_items_jsonb: [
        { name: 'Arrest records', status: 'pending' },
        { name: 'Booking photos', status: 'pending' }
      ],
      autopilot_mode: 'SUPERVISED',
      portal_url: 'https://portal.lacounty.gov'
    },
    messages: [
      {
        id: 2010,
        case_id: 1010,
        direction: 'inbound',
        from_email: 'records@lasd.gov',
        subject: 'RE: FOIA Request - Maria Lopez - Denial',
        body_text: 'Your request is denied. The records you seek are exempt from disclosure under the California Public Records Act. The privacy exemption applies to protect the personal information of individuals involved. These records are exempt under state law and will not be released.',
        message_id: '<msg-2010@lasd.gov>'
      }
    ],
    analyses: [
      {
        id: 3010,
        message_id: 2010,
        case_id: 1010,
        intent: 'denial',
        confidence_score: 0.94,
        sentiment: 'negative',
        key_points: [
          'Privacy exemption applies to protect personal information',
          'Records are confidential under state statute',
          'Sealed by court order pending litigation'
        ],
        extracted_fee_amount: null,
        full_analysis_json: {
          denial_subtype: 'privacy_exemption',
          constraints_to_add: ['PRIVACY_EXEMPT']
        },
        requires_action: true
      }
    ],
    followup: null
  },

  llmStubs: {
    classify: {
      classification: 'DENIAL',
      confidence: 0.94,
      sentiment: 'negative',
      denial_subtype: 'privacy_exemption',
      key_points: [
        'Privacy exemption applies to protect personal information',
        'Records are confidential under state statute',
        'Sealed by court order pending litigation'
      ]
    },
    draft: {
      subject: 'Re: FOIA Request - Maria Lopez - Appeal',
      body: 'Stubbed response body for testing'
    }
  },

  stateOverrides: {
    triggerType: 'agency_reply',
    latestInboundMessageId: 2010
  },

  expected: {
    proposalActionType: 'CLOSE_CASE',
    requiresHuman: true,
    canAutoExecute: false
  }
};
