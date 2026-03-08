function classifyOperatorActionError(error, fallbackCode = 'OPERATOR_ACTION_FAILED') {
  const message = String(error?.message || '').toLowerCase();
  const constraint = String(error?.constraint || '').toLowerCase();

  if (error?.code === '23505' || constraint.includes('one_active_per_case')) {
    return 'ACTIVE_RUN_EXISTS';
  }
  if (message.includes('waitpoint')) {
    return 'WAITPOINT_COMPLETION_FAILED';
  }
  if (message.includes('trigger') || message.includes('dispatch')) {
    return 'TRIGGER_DISPATCH_FAILED';
  }
  if (message.includes('portal url')) {
    return 'PORTAL_URL_MISSING';
  }
  if (message.includes('no pending action found')) {
    return 'NO_PENDING_ACTION';
  }
  if (message.includes('already executed')) {
    return 'ACTION_ALREADY_EXECUTED';
  }
  if (message.includes('already being executed')) {
    return 'ACTION_ALREADY_EXECUTING';
  }
  if (message.includes('blocked by policy')) {
    return 'ACTION_BLOCKED_BY_POLICY';
  }
  if (message.includes('body is required')) {
    return 'MANUAL_BODY_REQUIRED';
  }
  if (message.includes('message or case not found') || message.includes('request not found') || message.includes('case not found')) {
    return 'CASE_NOT_FOUND';
  }
  if (message.includes('no linked notion page') || message.includes('case has no linked notion page')) {
    return 'NOTION_NOT_LINKED';
  }
  return fallbackCode;
}

function buildOperatorActionErrorResponse(error, fallbackCode = 'OPERATOR_ACTION_FAILED') {
  return {
    success: false,
    error: error?.message || 'Operator action failed',
    error_code: classifyOperatorActionError(error, fallbackCode),
  };
}

module.exports = {
  classifyOperatorActionError,
  buildOperatorActionErrorResponse,
};
