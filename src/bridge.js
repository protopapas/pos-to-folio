/**
 * Bridge Orchestrator
 * Polls Goodtill for Guest Folio sales and posts them as orders in MEWS.
 *
 * Flow:
 * 1. Fetch recent sales from Goodtill
 * 2. Filter for completed sales paid via "Guest Folio" payment method
 * 3. Look up the room from the sale's customer_id (synced roster profile)
 * 4. Find the active (checked-in) reservation for that room
 * 5. Post the order to MEWS linked to that reservation
 */

const { fetchSales, fetchSaleById, formatDateTime, extractGuestFolioSales, parseRoomNumber } = require('./goodtill');
const { getResourcesAndRoomMap, getActiveReservationForRoom, findFBService, findFBAccountingCategory, addOrder, addExternalPayment, deleteExternalPayments, getOrderItems, cancelOrderItems } = require('./mews');
const { SalesStore } = require('./store');
const { fullSync, getRoomByCustomerId } = require('./roster');

/** @type {Map<string, string>} room name → MEWS resource ID */
let roomMap = new Map();
/** @type {Map<string, string>} MEWS resource ID → room name */
let resourceToRoom = new Map();
/** @type {string|null} */
let fbServiceId = null;
/** @type {string|null} */
let fbAccountingCategoryId = null;
/** @type {SalesStore} */
let store;
/** @type {ReturnType<typeof setInterval>|null} */
let pollTimer = null;

// How far back to look on each poll cycle (in minutes)
const LOOKBACK_MINUTES = parseInt(process.env.POLL_LOOKBACK_MINUTES || '30', 10);

/**
 * Initialise the bridge: load MEWS config (rooms, services, categories),
 * then run a full roster sync to push checked-in rooms to Goodtill.
 */
async function init() {
  store = new SalesStore();

  console.log('[bridge] Loading MEWS configuration...');
  const [roomData, serviceId, catId] = await Promise.all([
    getResourcesAndRoomMap(),
    findFBService(),
    findFBAccountingCategory(),
  ]);

  roomMap = roomData.roomMap;
  fbServiceId = serviceId;
  fbAccountingCategoryId = catId;

  // Build reverse map: resource ID → room name
  resourceToRoom = new Map();
  for (const [name, id] of roomMap) {
    resourceToRoom.set(id, name);
  }

  console.log(`[bridge] Loaded ${roomMap.size} room mappings`);
  console.log(`[bridge] F&B Service ID: ${fbServiceId}`);
  console.log(`[bridge] F&B Accounting Category ID: ${fbAccountingCategoryId}`);

  // Sync checked-in rooms to Goodtill as customer profiles
  await fullSync(roomMap, resourceToRoom);
}

/** Expose maps for webhook handler */
function getRoomMap() { return roomMap; }
function getResourceToRoom() { return resourceToRoom; }

/**
 * Run a single poll cycle
 */
async function pollOnce() {
  const now = new Date();
  const from = new Date(now.getTime() - LOOKBACK_MINUTES * 60 * 1000);

  console.log(`[bridge] Polling Goodtill sales from ${formatDateTime(from)} to ${formatDateTime(now)}`);

  let sales;
  try {
    sales = await fetchSales(from, now);
  } catch (err) {
    console.error('[bridge] Failed to fetch Goodtill sales:', err.message);
    return;
  }

  const guestFolioSales = extractGuestFolioSales(sales);
  console.log(`[bridge] Found ${sales.length} total sales, ${guestFolioSales.length} Guest Folio sales`);

  let successCount = 0;
  let errorCount = 0;
  let reversedCount = 0;

  for (const { sale, voided, otherPayments } of guestFolioSales) {
    const saleId = String(sale.id || sale.sale_id);

    if (voided) {
      // Check if this voided sale was previously posted to MEWS
      const entry = store.get(saleId);
      if (!entry || entry.reversedAt) continue; // not posted or already reversed
      try {
        const reversed = await reverseSale(sale, saleId, entry);
        if (reversed) reversedCount++;
      } catch (err) {
        errorCount++;
        console.error(`[bridge] Error reversing sale ${saleId}:`, err.message);
      }
      continue;
    }

    if (store.has(saleId)) continue;

    try {
      const posted = await processSale(sale, saleId, otherPayments);
      if (posted) successCount++;
    } catch (err) {
      errorCount++;
      console.error(`[bridge] Error processing sale ${saleId}:`, err.message);
    }
  }

  if (successCount || errorCount || reversedCount) {
    console.log(`[bridge] Poll complete: ${successCount} posted, ${reversedCount} reversed, ${errorCount} errors`);
  }
}

/**
 * Process a single Guest Folio sale
 * @param {any} sale - The Goodtill sale object
 * @param {string} saleId
 * @param {Array<{method: string, amount: number}>} [otherPayments] - Non-folio payments for split bills
 */
async function processSale(sale, saleId, otherPayments = []) {
  // Primary: look up room from the sale's customer_id (roster-synced profile)
  const gtCustomerId = sale.customer_id;
  let roomNumber = null;
  let reservation = null;

  if (gtCustomerId) {
    const roomInfo = getRoomByCustomerId(gtCustomerId);
    if (roomInfo) {
      roomNumber = roomInfo.roomNumber;
      // We already have the reservation ID from the roster
      const resourceId = roomMap.get(roomNumber);
      if (resourceId) {
        reservation = await getActiveReservationForRoom(resourceId);
      }
    }
  }

  // Fallback: extract room code from the customer name (e.g. "DEM11 — Guest" or legacy "Room DEM11 — Guest")
  if (!roomNumber) {
    const custName = sale.customer?.name || sale.customer_name || sale.sales_details?.customer_name || '';
    const match = custName.match(/^(?:Room\s+)?(\S+)\s*—/i);
    if (match) {
      roomNumber = match[1];
      console.log(`[bridge] Sale ${saleId}: resolved room ${roomNumber} from customer name "${custName}"`);
    }
  }

  if (!roomNumber) {
    const custName = sale.customer?.name || sale.customer_name || sale.sales_details?.customer_name || '';
    console.warn(`[bridge] Sale ${saleId}: no room matched — customer_id="${gtCustomerId || 'null'}", customer_name="${custName}", skipping`);
    return false;
  }

  // If we didn't get a reservation from the roster, look it up
  if (!reservation) {
    const resourceId = roomMap.get(roomNumber);
    if (!resourceId) {
      console.error(`[bridge] Sale ${saleId}: room "${roomNumber}" not found in MEWS`);
      return false;
    }
    reservation = await getActiveReservationForRoom(resourceId);
  }

  if (!reservation) {
    console.error(`[bridge] Sale ${saleId}: no checked-in reservation found for room ${roomNumber}`);
    return false;
  }

  // 3. Build order items from the sale
  const items = buildOrderItems(sale);
  if (items.length === 0) {
    console.warn(`[bridge] Sale ${saleId}: no line items found, posting total as single item`);
    const total = parseFloat(sale.sales_details?.total || sale.total || '0');
    if (total <= 0) {
      console.warn(`[bridge] Sale ${saleId}: zero or negative total, skipping`);
      return false;
    }
    items.push({ name: 'POS Charge', unitCount: 1, grossValue: total });
  }

  // 4. Post to MEWS
  const saleRef = sale.receipt_no || sale.receipt_number || saleId;
  console.log(`[bridge] Posting sale ${saleRef} (room ${roomNumber}) to reservation ${reservation.Id}`);

  const result = await addOrder({
    serviceId: fbServiceId,
    accountId: reservation.AccountId || reservation.CustomerId,
    reservationId: reservation.Id,
    accountingCategoryId: fbAccountingCategoryId,
    items,
    notes: `POS Sale #${saleRef} — ${roomNumber}`,
    consumptionUtc: sale.sales_date_time
      ? new Date(sale.sales_date_time).toISOString()
      : new Date().toISOString(),
    currency: process.env.CURRENCY || 'EUR',
  });

  // 5. Post external payments for non-folio portions (split bills)
  const mewsOrderId = result?.OrderId || result?.Id;
  const paymentIds = [];

  if (otherPayments.length > 0) {
    const accountId = reservation.AccountId || reservation.CustomerId;
    for (const op of otherPayments) {
      try {
        const payResult = await addExternalPayment({
          accountId,
          amount: op.amount,
          currency: process.env.CURRENCY || 'EUR',
          type: 'Prepayment',
          externalIdentifier: `pos-${saleRef}-${op.method.toLowerCase()}`,
          notes: `${op.method} payment — POS Sale #${saleRef}`,
        });
        const paymentId = payResult?.PaymentId || payResult?.Id;
        if (paymentId) paymentIds.push(paymentId);
        console.log(`[bridge]   + Prepayment: €${op.amount.toFixed(2)} (${op.method})`);
      } catch (err) {
        console.error(`[bridge]   ✗ Failed to post ${op.method} prepayment for sale ${saleRef}:`, err.message);
      }
    }
  }

  // 6. Mark as processed
  store.add(saleId, mewsOrderId, paymentIds);
  console.log(`[bridge] ✓ Sale ${saleRef} posted to MEWS (order ${mewsOrderId || 'ok'}${paymentIds.length ? `, ${paymentIds.length} prepayment(s)` : ''})`);
  return true;
}

/**
 * Reverse a voided sale by cancelling its order items in MEWS
 * @param {any} sale - The Goodtill sale object (now voided)
 * @param {string} saleId
 * @param {{ mewsOrderId?: string }} entry - The store entry for this sale
 */
async function reverseSale(sale, saleId, entry) {
  const saleRef = sale.receipt_no || sale.receipt_number || saleId;

  if (!entry.mewsOrderId) {
    console.warn(`[bridge] Sale ${saleRef} was voided but no MEWS order ID stored — cannot auto-reverse`);
    return false;
  }

  console.log(`[bridge] Sale ${saleRef} voided on POS — cancelling MEWS order ${entry.mewsOrderId}`);

  // Fetch order items for this order
  const items = await getOrderItems([entry.mewsOrderId]);
  const activeItems = items.filter((i) => !i.CanceledUtc);

  if (activeItems.length === 0) {
    console.log(`[bridge] Sale ${saleRef}: no active order items to cancel in MEWS`);
    store.markReversed(saleId);
    return true;
  }

  // Cancel all active items
  await cancelOrderItems(activeItems.map((i) => i.Id));

  // Also reverse any external payments (split-bill prepayments)
  const paymentIds = entry.paymentIds || [];
  if (paymentIds.length > 0) {
    try {
      await deleteExternalPayments(paymentIds);
      console.log(`[bridge]   Reversed ${paymentIds.length} external payment(s)`);
    } catch (err) {
      console.error(`[bridge]   Failed to reverse external payments for ${saleRef}:`, err.message);
    }
  }

  store.markReversed(saleId);
  console.log(`[bridge] ✓ Sale ${saleRef} reversed — cancelled ${activeItems.length} item(s) in MEWS`);
  return true;
}

/**
 * Build MEWS order items from a Goodtill sale
 * @param {any} sale
 * @returns {Array<{name: string, unitCount: number, grossValue: number}>}
 */
function buildOrderItems(sale) {
  const saleItems = sale.sales_details?.sales_items || sale.sales_items || [];
  const items = [];

  for (const item of saleItems) {
    const name = item.product_name || item.item_name || item.name || 'Item';
    const qty = parseInt(item.quantity || item.qty || '1', 10);
    const price = parseFloat(item.line_total_after_discount || item.line_total_after_line_discount || item.total || item.price_inc_vat_per_item || item.price || item.amount || '0');

    if (price === 0) continue;

    items.push({
      name,
      unitCount: qty || 1,
      grossValue: price / (qty || 1), // MEWS wants per-unit gross value
    });
  }

  // Extract tips from metadata
  const tipTotal = extractTipAmount(sale);
  if (tipTotal > 0) {
    items.push({
      name: 'Tip',
      unitCount: 1,
      grossValue: tipTotal,
      taxCode: 'CY-Z', // Tips are 0% VAT
      accountingCategoryId: process.env.MEWS_TIPS_CATEGORY_ID || '88951db5-3deb-4e66-b108-b213013e2a08',
    });
  }

  return items;
}

/**
 * Extract total tip amount from a Goodtill sale's metadata
 */
function extractTipAmount(sale) {
  try {
    const metaStr = sale.sales_details?.metadata;
    if (!metaStr) return 0;
    const meta = typeof metaStr === 'string' ? JSON.parse(metaStr) : metaStr;
    const tipsObj = meta.tips_obj;
    if (!tipsObj || typeof tipsObj !== 'object') return 0;
    let total = 0;
    for (const tip of Object.values(tipsObj)) {
      total += parseFloat(tip.amount || '0');
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * Start the polling loop
 * @param {number} [intervalMs] - Polling interval in milliseconds
 */
function startPolling(intervalMs) {
  const interval = intervalMs || parseInt(process.env.POLL_INTERVAL_MS || '60000', 10);
  console.log(`[bridge] Starting poll loop every ${interval / 1000}s`);

  // Run first poll immediately
  pollOnce().catch((err) => console.error('[bridge] Initial poll error:', err.message));

  pollTimer = setInterval(() => {
    pollOnce().catch((err) => console.error('[bridge] Poll error:', err.message));
  }, interval);
}

/**
 * Stop the polling loop
 */
function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log('[bridge] Polling stopped');
  }
}

// ─── Webhook handlers ────────────────────────────────────────────────

/**
 * Handle a sale.voided webhook from Goodtill.
 * Fetches the sale, checks if it was posted to MEWS, and cancels the order items.
 * @param {string} saleId - Goodtill sale ID
 */
async function handleVoidedSale(saleId) {
  const entry = store.get(saleId);
  if (!entry) {
    console.log(`[bridge] Voided sale ${saleId} was not in store (not a guest folio or not yet posted), ignoring`);
    return;
  }
  if (entry.reversedAt) {
    console.log(`[bridge] Voided sale ${saleId} already reversed, ignoring`);
    return;
  }

  // Fetch the sale to get the receipt number for logging
  let saleRef = saleId;
  try {
    const sale = await fetchSaleById(saleId);
    if (sale) saleRef = sale.receipt_no || sale.receipt_number || saleId;
  } catch { /* use saleId as fallback ref */ }

  await reverseSale({ receipt_no: saleRef }, saleId, entry);
}

/**
 * Handle a sale.completed webhook from Goodtill.
 * Fetches the sale details and processes it if it's a guest folio payment.
 * @param {string} saleId - Goodtill sale ID
 */
async function handleCompletedSale(saleId) {
  if (store.has(saleId)) {
    console.log(`[bridge] Completed sale ${saleId} already processed, ignoring`);
    return;
  }

  let sale;
  try {
    sale = await fetchSaleById(saleId);
  } catch (err) {
    console.error(`[bridge] Failed to fetch sale ${saleId}:`, err.message);
    return;
  }

  if (!sale) {
    console.warn(`[bridge] Sale ${saleId} not found in Goodtill`);
    return;
  }

  // Check if it's a guest folio sale
  const matches = extractGuestFolioSales([sale]);
  if (matches.length === 0 || matches[0].voided) return;

  console.log(`[bridge] Webhook: processing completed guest folio sale ${saleId}`);
  try {
    await processSale(sale, saleId, matches[0].otherPayments);
  } catch (err) {
    console.error(`[bridge] Error processing webhook sale ${saleId}:`, err.message);
  }
}

module.exports = { init, pollOnce, startPolling, stopPolling, getRoomMap, getResourceToRoom, handleVoidedSale, handleCompletedSale };
