function parseEventTimestamp(event) {
  return Number.isFinite(Number(event?.timestamp))
    ? new Date(Number(event.timestamp) * 1000)
    : new Date();
}

async function processSendgridEvent({ db, transitionCaseRuntime, event, logger = console }) {
  const providerMessageId = event?.sg_message_id || null;
  const eventTimestamp = parseEventTimestamp(event);
  const message = providerMessageId
    ? await db.getMessageBySendgridMessageId(providerMessageId)
    : null;

  await db.createEmailEvent({
    message_id: message?.id || null,
    provider_message_id: providerMessageId,
    event_type: event?.event || 'unknown',
    event_timestamp: eventTimestamp,
    raw_payload: event,
  });

  switch (event?.event) {
    case 'delivered':
      logger.log(`Email delivered: ${providerMessageId}`);
      if (message?.id) {
        await db.updateMessageDeliveryStatus(message.id, { delivered_at: eventTimestamp });
      }
      return { status: 'recorded', messageId: message?.id || null };

    case 'bounce':
    case 'dropped':
      logger.error(`Email ${event.event}: ${providerMessageId}`, event.reason);
      if (message?.id) {
        await db.updateMessageDeliveryStatus(message.id, { bounced_at: eventTimestamp });
      }
      await db.logActivity(
        event.event === 'bounce' ? 'email_bounced' : 'email_dropped',
        `Email delivery failed: ${event.reason || 'Unknown reason'}`,
        {
          case_id: message?.case_id || null,
          message_id: message?.id || null,
          sendgrid_message_id: providerMessageId,
          bounce_type: event.type,
          reason: event.reason,
          status_code: event.status,
        }
      );
      if (message?.case_id) {
        await transitionCaseRuntime(message.case_id, 'CASE_ESCALATED', {
          substatus: `Email ${event.event}: ${event.reason || 'delivery failed'}`,
          pauseReason: 'EMAIL_FAILED',
        });
      }
      return { status: 'failed', messageId: message?.id || null };

    case 'open':
      logger.log(`Email opened: ${providerMessageId}`);
      return { status: 'opened', messageId: message?.id || null };

    default:
      return { status: 'ignored', messageId: message?.id || null };
  }
}

module.exports = {
  parseEventTimestamp,
  processSendgridEvent,
};
