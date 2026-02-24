/**
 * Scenario 12: Partial Approval
 *
 * Agency approves some records but withholds others. Classification is
 * PARTIAL_APPROVAL, which always routes to RESPOND_PARTIAL_APPROVAL
 * with human gating. The response will accept released items and
 * challenge the withheld items.
 */

module.exports = {
  name: 'partial-approval',
  description: 'Partial approval routes to RESPOND_PARTIAL_APPROVAL',

  seed: {
    case: {
      id: 1012,
      agency_name: 'Phoenix Police Department',
      agency_email: 'foia@phoenixpd.gov',
      status: 'awaiting_response',
      state: 'AZ',
      subject_name: 'Emily Martinez',
      case_name: 'Phoenix PD - Emily Martinez FOIA',
      requested_records: ['Incident reports', 'Body camera footage', 'Dispatch logs'],
      constraints_jsonb: [],
      scope_items_jsonb: [
        { name: 'Incident reports', status: 'pending' },
        { name: 'Body camera footage', status: 'pending' },
        { name: 'Dispatch logs', status: 'pending' }
      ],
      autopilot_mode: 'SUPERVISED',
      portal_url: null
    },
    messages: [
      {
        id: 2012,
        case_id: 1012,
        direction: 'inbound',
        from_email: 'records@phoenixpd.gov',
        subject: 'RE: FOIA Request - Emily Martinez - Partial Release',
        body_text: 'We are releasing the incident reports and dispatch logs responsive to your request. However, the body camera footage has been withheld as it is part of an active case review. The released documents are attached.',
        message_id: '<msg-2012@phoenixpd.gov>'
      }
    ],
    analyses: [
      {
        id: 3012,
        message_id: 2012,
        case_id: 1012,
        intent: 'partial_approval',
        confidence_score: 0.91,
        sentiment: 'neutral',
        key_points: [
          'Incident reports and dispatch logs released',
          'Body camera footage withheld',
          'Active case review cited for withholding'
        ],
        extracted_fee_amount: null,
        full_analysis_json: {
          denial_subtype: null,
          constraints_to_add: [],
          released_records: ['Incident reports', 'Dispatch logs'],
          withheld_records: ['Body camera footage']
        },
        requires_action: true
      }
    ],
    followup: null
  },

  llmStubs: {
    classify: {
      classification: 'PARTIAL_APPROVAL',
      confidence: 0.91,
      sentiment: 'neutral',
      key_points: [
        'Incident reports and dispatch logs released',
        'Body camera footage withheld',
        'Active case review cited for withholding'
      ]
    },
    draft: {
      subject: 'Re: FOIA Request - Emily Martinez - Partial Release Response',
      body: 'Stubbed response body for testing'
    }
  },

  stateOverrides: {
    triggerType: 'agency_reply',
    latestInboundMessageId: 2012
  },

  expected: {
    proposalActionType: 'RESPOND_PARTIAL_APPROVAL',
    requiresHuman: true,
    canAutoExecute: false
  }
};
