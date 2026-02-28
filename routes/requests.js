const express = require('express');
const router = express.Router();

// dlq-reaper must be mounted BEFORE query to prevent /dlq matching /:id
router.use('/', require('./requests/dlq-reaper'));
router.use('/', require('./requests/screenshots'));
router.use('/', require('./requests/case-updates'));
router.use('/', require('./requests/proposals'));
router.use('/', require('./requests/agent-control'));
router.use('/', require('./requests/legacy-actions'));
router.use('/', require('./requests/case-management'));
router.use('/', require('./requests/query'));

module.exports = router;
