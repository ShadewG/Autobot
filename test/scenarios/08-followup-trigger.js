/**
 * Scenario 08: Followup Trigger
 *
 * No response from agency; a scheduled followup fires. The trigger type
 * is 'followup_trigger' with no latestInboundMessageId. The classify node
 * skips classification and returns NO_RESPONSE. The decide node routes
 * to SEND_FOLLOWUP. In SUPERVISED mode, requiresHuman is true.
 */

module.exports = {
  name: 'followup-trigger',
  description: 'No agency response, scheduled followup routes to SEND_FOLLOWUP',

  seed: {
    case: {
      id: 1008,
      agency_name: 'Miami Police Department',
      agency_email: 'records@miamipd.gov',
      status: 'awaiting_response',
      state: 'FL',
      subject_name: 'Lisa Garcia',
      case_name: 'Miami PD - Lisa Garcia FOIA',
      requested_records: ['Incident reports', 'Body camera footage'],
      constraints_jsonb: [],
      scope_items_jsonb: [
        { name: 'Incident reports', status: 'pending' },
        { name: 'Body camera footage', status: 'pending' }
      ],
      autopilot_mode: 'SUPERVISED',
      portal_url: null
    },
    messages: [],
    analyses: [],
    followup: {
      followup_count: 0
    }
  },

  llmStubs: {
    classify: null,
    draft: {
      subject: 'Follow-up: Miami PD - Lisa Garcia FOIA',
      body: 'Stubbed response body for testing'
    }
  },

  stateOverrides: {
    triggerType: 'followup_trigger',
    latestInboundMessageId: null
  },

  expected: {
    proposalActionType: 'SEND_FOLLOWUP',
    requiresHuman: true,
    canAutoExecute: false
  }
};
