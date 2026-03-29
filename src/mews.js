/**
 * MEWS Connector API client
 * Handles authentication and paginated requests to the MEWS Connector API
 */

const MEWS_BASE = process.env.MEWS_BASE_URL || 'https://api.mews-demo.com';

function authBody() {
  return {
    ClientToken: process.env.MEWS_CLIENT_TOKEN,
    AccessToken: process.env.MEWS_ACCESS_TOKEN_V2 || process.env.MEWS_ACCESS_TOKEN,
    Client: process.env.MEWS_CLIENT_NAME || 'AgoraPOSBridge',
  };
}

/**
 * POST to a MEWS Connector API endpoint
 */
async function post(endpoint, body = {}) {
  const res = await fetch(`${MEWS_BASE}/api/connector/v1/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...authBody(), ...body }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`MEWS ${endpoint} failed: ${res.status} ${res.statusText} — ${text}`);
  }
  return res.json();
}

/**
 * Paginated GET (via POST) returning all items from a given result key
 */
async function getAll(endpoint, body = {}, resultKey) {
  const all = [];
  let cursor = null;
  while (true) {
    const req = { ...body, Limitation: { Count: 1000, ...(cursor ? { Cursor: cursor } : {}) } };
    const data = await post(endpoint, req);
    const items = data[resultKey] || [];
    all.push(...items);
    cursor = data.Cursor;
    if (!cursor || items.length < 1000) break;
  }
  return all;
}

// ─── Customers (guests) ───────────────────────────────────────────────

/**
 * Get MEWS customer details by IDs
 * @param {string[]} customerIds
 * @returns {Promise<any[]>}
 */
async function getCustomers(customerIds) {
  if (!customerIds.length) return [];
  const data = await post('customers/getAll', {
    CustomerIds: customerIds,
    Extent: { Customers: true },
  });
  return data.Customers || [];
}

// ─── Resources (rooms) ────────────────────────────────────────────────

/**
 * Fetch all resources (rooms) and build a map of room name → resource ID
 * @returns {{ resources: any[], roomMap: Map<string, string> }}
 */
async function getResourcesAndRoomMap() {
  const data = await post('resources/getAll', {
    Extent: { Resources: true },
  });

  const resources = data.Resources || [];
  const roomMap = new Map();
  for (const r of resources) {
    if (r.IsActive && r.Name) {
      // Map by the resource name (which is typically the room number like "101")
      roomMap.set(r.Name.trim(), r.Id);
      // Also try without leading zeros
      const num = r.Name.trim().replace(/^0+/, '');
      if (num !== r.Name.trim()) roomMap.set(num, r.Id);
    }
  }

  return { resources, roomMap };
}

// ─── Reservations ─────────────────────────────────────────────────────

/**
 * Get ALL currently checked-in reservations
 * @returns {Promise<any[]>}
 */
async function getAllCheckedInReservations() {
  const now = new Date();
  return getAll('reservations/getAll/2023-06-06', {
    States: ['Started'],
    CollidingUtc: {
      StartUtc: now.toISOString(),
      EndUtc: now.toISOString(),
    },
    Extent: { Reservations: true },
  }, 'Reservations');
}

/**
 * Find the active (checked-in) reservation for a given room resource ID
 * @param {string} resourceId - MEWS resource ID
 * @returns {Promise<any|null>} The reservation or null
 */
async function getActiveReservationForRoom(resourceId) {
  const now = new Date();
  const reservations = await getAll('reservations/getAll/2023-06-06', {
    AssignedResourceIds: [resourceId],
    States: ['Started'],
    CollidingUtc: {
      StartUtc: now.toISOString(),
      EndUtc: now.toISOString(),
    },
  }, 'Reservations');

  if (reservations.length === 0) return null;
  if (reservations.length === 1) return reservations[0];

  // Multiple started reservations for same room — pick the one closest to now
  console.warn(`[mews] ${reservations.length} active reservations found for resource ${resourceId}, using most recent`);
  reservations.sort((a, b) => new Date(b.StartUtc) - new Date(a.StartUtc));
  return reservations[0];
}

// ─── Services ─────────────────────────────────────────────────────────

/**
 * Find the F&B / Restaurant service
 * Looks for a service with "Additional" discriminator and name matching common F&B names
 */
async function findFBService() {
  // If explicitly configured, use that
  if (process.env.MEWS_FB_SERVICE_ID) {
    return process.env.MEWS_FB_SERVICE_ID;
  }

  const services = await getAll('services/getAll', {}, 'Services');
  const fbService = services.find((s) => {
    const name = (s.Name || '').toLowerCase();
    return (
      s.IsActive &&
      s.Data?.Discriminator === 'Additional' &&
      (name.includes('restaurant') || name.includes('f&b') || name.includes('food'))
    );
  });

  if (!fbService) throw new Error('Could not find an F&B service in MEWS. Set MEWS_FB_SERVICE_ID explicitly.');
  return fbService.Id;
}

// ─── Accounting Categories ────────────────────────────────────────────

/**
 * Find the F&B accounting category
 */
async function findFBAccountingCategory() {
  if (process.env.MEWS_FB_ACCOUNTING_CATEGORY_ID) {
    return process.env.MEWS_FB_ACCOUNTING_CATEGORY_ID;
  }

  const categories = await getAll('accountingcategories/getAll', {}, 'AccountingCategories');
  const fbCat = categories.find((c) => {
    const name = (c.Name || '').toLowerCase();
    return (
      c.IsActive &&
      (name.includes('restaurant') || name.includes('f&b') || name.includes('food') || name.includes('beverage'))
    );
  });

  if (!fbCat) throw new Error('Could not find an F&B accounting category in MEWS. Set MEWS_FB_ACCOUNTING_CATEGORY_ID explicitly.');
  return fbCat.Id;
}

// ─── Orders ───────────────────────────────────────────────────────────

/**
 * Post an order (POS charge) to a guest's folio in MEWS
 *
 * @param {object} params
 * @param {string} params.serviceId - F&B service ID in MEWS
 * @param {string} params.accountId - Customer/Account ID (from reservation)
 * @param {string} params.reservationId - Reservation ID to link the order to
 * @param {string} params.accountingCategoryId - Accounting category for F&B
 * @param {Array<{name: string, unitCount: number, grossValue: number}>} params.items - Line items
 * @param {string} params.notes - Reference notes (e.g. SumUp sale ID)
 * @param {string} [params.consumptionUtc] - ISO timestamp of consumption
 * @param {string} [params.currency] - Currency code (default EUR)
 */
async function addOrder({ serviceId, accountId, reservationId, accountingCategoryId, items, notes, consumptionUtc, currency = 'EUR' }) {
  const mewsItems = items.map((item) => ({
    Name: item.name,
    UnitCount: item.unitCount,
    UnitAmount: {
      Currency: currency,
      GrossValue: item.grossValue,
      TaxCodes: [process.env.MEWS_TAX_CODE || 'CY-2024-1-S'],
    },
    AccountingCategoryId: accountingCategoryId,
  }));

  const body = {
    ServiceId: serviceId,
    AccountId: accountId,
    LinkedReservationId: reservationId,
    Items: mewsItems,
    Notes: notes,
  };

  if (consumptionUtc) body.ConsumptionUtc = consumptionUtc;

  return post('orders/add', body);
}

module.exports = {
  post,
  getAll,
  getCustomers,
  getResourcesAndRoomMap,
  getAllCheckedInReservations,
  getActiveReservationForRoom,
  findFBService,
  findFBAccountingCategory,
  addOrder,
};
