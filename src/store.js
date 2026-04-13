/**
 * Processed-sales tracker
 * Keeps track of Goodtill sale IDs that have been successfully posted to MEWS.
 * Persists to a local JSON file so the service survives restarts without duplicating charges.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PATH = path.resolve(process.cwd(), 'data', 'processed-sales.json');

class SalesStore {
  /**
   * @param {string} [filePath] - Path to the JSON persistence file
   */
  constructor(filePath = DEFAULT_PATH) {
    this.filePath = filePath;
    /** @type {Map<string, { postedAt: string, mewsOrderId?: string, paymentIds?: string[] }>} */
    this.processed = new Map();
    this._load();
  }

  _load() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      if (fs.existsSync(this.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        for (const [k, v] of Object.entries(raw)) {
          this.processed.set(k, v);
        }
        console.log(`[store] Loaded ${this.processed.size} processed sales from disk`);
      }
    } catch (err) {
      console.error('[store] Failed to load processed sales:', err.message);
    }
  }

  _save() {
    try {
      const obj = Object.fromEntries(this.processed);
      fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2));
    } catch (err) {
      console.error('[store] Failed to save processed sales:', err.message);
    }
  }

  /**
   * Check whether a sale ID has already been processed
   * @param {string} saleId
   * @returns {boolean}
   */
  has(saleId) {
    return this.processed.has(String(saleId));
  }

  /**
   * Get the stored data for a sale
   * @param {string} saleId
   * @returns {{ postedAt: string, mewsOrderId?: string, paymentIds?: string[], reversedAt?: string } | undefined}
   */
  get(saleId) {
    return this.processed.get(String(saleId));
  }

  /**
   * Mark a sale as successfully processed
   * @param {string} saleId
   * @param {string} [mewsOrderId]
   * @param {string[]} [paymentIds] - MEWS external payment IDs (for split-bill prepayments)
   */
  add(saleId, mewsOrderId, paymentIds = []) {
    const entry = {
      postedAt: new Date().toISOString(),
      mewsOrderId,
    };
    if (paymentIds.length > 0) entry.paymentIds = paymentIds;
    this.processed.set(String(saleId), entry);
    this._save();
  }

  /**
   * Mark a previously processed sale as reversed (voided)
   * @param {string} saleId
   */
  markReversed(saleId) {
    const entry = this.processed.get(String(saleId));
    if (entry) {
      entry.reversedAt = new Date().toISOString();
      this._save();
    }
  }

  /** Number of processed sales */
  get size() {
    return this.processed.size;
  }
}

module.exports = { SalesStore };
