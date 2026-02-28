const express = require('express');
const router = express.Router();

// Sub-routers mounted in original declaration order
router.use('/', require('./monitor/overview'));
router.use('/', require('./monitor/inbound'));
router.use('/', require('./monitor/outbound'));
router.use('/', require('./monitor/cases'));
router.use('/', require('./monitor/proposals'));
router.use('/', require('./monitor/agent'));
router.use('/', require('./monitor/portal'));
router.use('/', require('./monitor/lessons'));
router.use('/', require('./monitor/events'));

module.exports = router;
