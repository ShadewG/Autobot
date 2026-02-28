const express = require('express');
const router = express.Router();

// Sub-routers mounted in original declaration order
router.use('/', require('./test/notion'));
router.use('/', require('./test/email'));
router.use('/', require('./test/cases'));
router.use('/', require('./test/portal'));
router.use('/', require('./test/decisions'));
router.use('/', require('./test/fees'));
router.use('/', require('./test/status'));
router.use('/', require('./test/db-ops'));
router.use('/', require('./test/simulation'));
router.use('/', require('./test/ai-research'));
router.use('/', require('./test/data-fixes'));
router.use('/', require('./test/e2e'));

module.exports = router;
