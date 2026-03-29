/**
 * POS-to-Folio Bridge Service
 * Express server that bridges Goodtill/SumUp POS "Guest Folio" payments
 * to MEWS room folios via the Connector API.
 *
 * Also syncs checked-in MEWS rooms as Goodtill customer profiles so
 * waiters can only select occupied rooms on the POS iPad.
 */

require('dotenv').config();
const crypto = require('node:crypto');
const express = require('express');
const { init, startPolling, stopPolling, pollOnce, getRoomMap, getResourceToRoom } = require('./bridge');
const { handleReservationUpdate, fullSync } = require('./roster');

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT || '3050', 10);
const WEBHOOK_SECRET = process.env.MEWS_WEBHOOK_SECRET || '';

// ─── Health check ─────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ─── Manual triggers ──────────────────────────────────────────────────

app.post('/poll', async (_req, res) => {
  try {
    await pollOnce();
    res.json({ status: 'ok', message: 'Poll cycle completed' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/sync', async (_req, res) => {
  try {
    await fullSync(getRoomMap(), getResourceToRoom());
    res.json({ status: 'ok', message: 'Room roster sync completed' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─── MEWS Webhook ─────────────────────────────────────────────────────

app.post('/webhooks/mews', async (req, res) => {
  // Optional signature verification
  if (WEBHOOK_SECRET) {
    const sig = req.get('X-Mews-Signature');
    if (sig) {
      const payload = JSON.stringify(req.body);
      const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');
      if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
        return res.status(401).send('Invalid signature');
      }
    }
  }

  // Respond immediately — process asynchronously
  res.status(200).send('OK');

  const events = req.body?.Events || [];
  const reservationIds = new Set();

  for (const evt of events) {
    if (evt.Discriminator === 'ServiceOrderUpdated') {
      reservationIds.add(evt.Value?.Id);
    }
  }

  if (reservationIds.size === 0) return;

  console.log(`[webhook] Received ${reservationIds.size} ServiceOrderUpdated event(s)`);

  const roomMap = getRoomMap();
  const resourceToRoom = getResourceToRoom();

  for (const id of reservationIds) {
    try {
      await handleReservationUpdate(id, roomMap, resourceToRoom);
    } catch (err) {
      console.error(`[webhook] Error handling reservation ${id}:`, err.message);
    }
  }
});

// ─── Startup ──────────────────────────────────────────────────────────

let resyncTimer = null;

async function start() {
  const required = [
    'MEWS_CLIENT_TOKEN',
    'MEWS_ACCESS_TOKEN',
    'GOODTILL_SUBDOMAIN',
    'GOODTILL_USERNAME',
    'GOODTILL_PASSWORD',
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`[server] Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  try {
    // init() loads MEWS config AND runs the first fullSync
    await init();
    startPolling();

    // Periodic full re-sync as a safety net (every 10 minutes)
    const resyncInterval = parseInt(process.env.ROSTER_RESYNC_INTERVAL_MS || '600000', 10);
    resyncTimer = setInterval(() => {
      fullSync(getRoomMap(), getResourceToRoom()).catch((err) =>
        console.error('[server] Roster re-sync error:', err.message)
      );
    }, resyncInterval);

    app.listen(PORT, () => {
      console.log(`[server] POS-to-Folio bridge running on port ${PORT}`);
      console.log(`[server] Health:       GET  http://localhost:${PORT}/health`);
      console.log(`[server] Manual poll:  POST http://localhost:${PORT}/poll`);
      console.log(`[server] Manual sync:  POST http://localhost:${PORT}/sync`);
      console.log(`[server] MEWS webhook: POST http://localhost:${PORT}/webhooks/mews`);
    });
  } catch (err) {
    console.error('[server] Failed to start:', err);
    process.exit(1);
  }
}

// ─── Graceful shutdown ────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`[server] ${signal} received, shutting down...`);
  stopPolling();
  if (resyncTimer) clearInterval(resyncTimer);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start();
