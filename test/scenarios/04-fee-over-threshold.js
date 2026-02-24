/**
 * Scenario 04: Fee Over Threshold
 *
 * Agency quotes a $750 fee. This exceeds the $500 FEE_NEGOTIATE_THRESHOLD,
 * so the router recommends NEGOTIATE_FEE with human gating.
 */

module.exports = {
  name: 'fee-over-threshold',
  description: 'Fee quote $750 (over $500 negotiate threshold) routes to NEGOTIATE_FEE',

  seed: {
    case: {
      id: 1004,
      agency_name: 'Denver Police Department',
      agency_email: 'foia@denverpd.gov',
      status: 'awaiting_response',
      state: 'CO',
      subject_name: 'Sarah Williams',
      case_name: 'Denver PD - Sarah Williams FOIA',
      requested_records: ['Internal affairs investigation files', 'Use of force reports'],
      constraints_jsonb: [],
      scope_items_jsonb: [
        { name: 'Internal affairs investigation files', status: 'pending' },
        { name: 'Use of force reports', status: 'pending' }
      ],
      autopilot_mode: 'SUPERVISED',
      portal_url: null
    },
    messages: [
      {
        id: 2004,
        case_id: 1004,
        direction: 'inbound',
        from_email: 'records@denverpd.gov',
        subject: 'RE: FOIA Request - Sarah Williams - Cost Estimate',
        body_text: 'The estimated cost for your request is $750.00, reflecting 15 hours of staff time at $50/hour for review and redaction of approximately 300 pages of responsive documents.',
        message_id: '<msg-2004@denverpd.gov>'
      }
    ],
    analyses: [
      {
        id: 3004,
        message_id: 2004,
        case_id: 1004,
        intent: 'fee_request',
        confidence_score: 0.97,
        sentiment: 'neutral',
        key_points: [
          'Fee estimate: $750.00',
          '15 hours of staff time at $50/hour',
          'Approximately 300 pages of responsive documents'
        ],
        extracted_fee_amount: 750,
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
      fee_amount: 750,
      confidence: 0.97,
      sentiment: 'neutral',
      key_points: [
        'Fee estimate: $750.00',
        '15 hours of staff time at $50/hour',
        'Approximately 300 pages of responsive documents'
      ]
    },
    draft: {
      subject: 'Re: FOIA Request - Sarah Williams - Fee Negotiation',
      body: 'Stubbed response body for testing'
    }
  },

  stateOverrides: {
    triggerType: 'agency_reply',
    latestInboundMessageId: 2004
  },

  expected: {
    proposalActionType: 'NEGOTIATE_FEE',
    requiresHuman: true,
    canAutoExecute: false
  }
};
