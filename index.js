'use strict';
require('dotenv').config();
const express   = require('express');
const app       = express();
const PORT      = process.env.WA_PORT || 5100;

app.use(express.json());

// Routes
app.use('/sessions', require('./routes/sessions'));
app.use('/send',     require('./routes/send'));
app.use('/queue',    require('./routes/queue'));

app.get('/health', (req, res) => {
    const { getSessions } = require('./sessions');
    const sessions = getSessions();
    const connected = Object.values(sessions).filter(s => s.status === 'connected').length;
    res.json({ ok: true, sessions_connected: connected, sessions_total: Object.keys(sessions).length });
});

app.use((err, req, res, next) => {
    console.error('[Express]', err.message);
    res.status(500).json({ error: err.message });
});

const { loadExistingSessions } = require('./sessions');
const { recoverQueued }        = require('./recovery');

async function main() {
    // Listen only on localhost
    app.listen(PORT, '127.0.0.1', async () => {
        console.log(`[WA] Service listening on 127.0.0.1:${PORT}`);

        // Reconnect existing sessions
        await loadExistingSessions();

        // Re-enqueue any queued messages from wa.db
        // Wait 10s for sessions to connect before recovery
        setTimeout(() => recoverQueued(), 10_000);
    });
}

main().catch(err => {
    console.error('[WA] Fatal startup error:', err);
    process.exit(1);
});
