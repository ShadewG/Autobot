/**
 * Scenario 03: Fee Under Threshold
 *
 * Agency quotes a $50 fee. This is under the $100 FEE_AUTO_APPROVE_MAX
 * but also under the $500 FEE_NEGOTIATE_THRESHOLD, so it routes to
 * ACCEPT_FEE. In SUPERVISED mode, canAutoExecute is false and
 * requiresHuman is true (human must approve the acceptance).
 */

module.exports = {
  name: 'fee-under-threshold',
  description: 'Fee quote $50 (under $100 auto-approve) routes to ACCEPT_FEE, gated in SUPERVISED mode',

  seed: {
    case: {
      id: 1003,
      agency_name: 'Austin Police Department',
      agency_email: 'records@austinpd.gov',
      status: 'awaiting_response',
      state: 'TX',
      subject_name: 'Mike Johnson',
      case_name: 'Austin PD - Mike Johnson FOIA',
      requested_records: ['Arrest reports', 'Dispatch logs'],
      constraints_jsonb: [],
      scope_items_jsonb: [
        { name: 'Arrest reports', status: 'pending' },
        { name: 'Dispatch logs', status: 'pending' }
      ],
      autopilot_mode: 'SUPERVISED',
      portal_url: null
    },
    messages: [
      {
        id: 2003,
        case_id: 1003,
        direction: 'inbound',
        from_email: 'foia@austinpd.gov',
        subject: 'RE: FOIA Request - Mike Johnson - Fee Estimate',
        body_text: 'We have located the records responsive to your request. The estimated cost for copying and processing is $50.00. Please remit payment to proceed.',
        message_id: '<msg-2003@austinpd.gov>'
      }
    ],
    analyses: [
      {
        id: 3003,
        message_id: 2003,
        case_id: 1003,
        intent: 'fee_request',
        confidence_score: 0.98,
        sentiment: 'neutral',
        key_points: [
          'Fee estimate provided: $50.00',
          'Records located and ready upon payment'
        ],
        extracted_fee_amount: 50,
        full_analysis_json: {
          denial_subtype: null,
          constraints_to_add: ['FEE_REQUIRED']
        },
        requires_action: true
      }
    ],
    followup: null
  },

  llmStubs: {
    classify: {
      classification: 'FEE_QUOTE',
      fee_amount: 50,
      confidence: 0.98,
      sentiment: 'neutral',
      key_points: [
        'Fee estimate provided: $50.00',
        'Records located and ready upon payment'
      ]
    },
    draft: {
      subject: 'Re: FOIA Request - Mike Johnson - Fee Acceptance',
      body: 'Stubbed response body for testing'
    }
  },

  stateOverrides: {
    triggerType: 'agency_reply',
    latestInboundMessageId: 2003
  },

  expected: {
    proposalActionType: 'ACCEPT_FEE',
    requiresHuman: true,
    canAutoExecute: false
  }
};
