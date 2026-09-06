'use strict';
const express = require('express');
const router  = express.Router();
const { getQueueStatus } = require('../queue');
const { getSessions }    = require('../sessions');

// GET /queue/status
router.get('/status', (req, res) => {
    const status  = getQueueStatus();
    const sessions = getSessions();
    const result  = {};
    for (const [key, q] of Object.entries(status)) {
        result[key] = {
            pending:  q.pending,
            active:   q.active,
            session_status: sessions[key]?.status || 'unknown',
        };
    }
    res.json(result);
});

module.exports = router;
