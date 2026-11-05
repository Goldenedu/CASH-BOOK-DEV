/**
 * ==============================================================================
 * GOLDEN ERP SYSTEM - CANTEEN POS CENTRAL BARREL HUB (MODULAR V10.0)
 * File: handlers-canteen-pos.js (Location: cashbook-api/handlers-canteen-pos.js)
 * 
 * 💡 Architecture:
 *   Re-exports all modular Canteen POS domain handlers so `worker.js` and other
 *   modules maintain 100% backward-compatible imports with zero breaking changes:
 *     1. ./handlers-canteen-core.js      (Schema, Timezone, Pricing, Dashboard, Settings)
 *     2. ./handlers-canteen-cashbook.js  (POS Cash Book, Day Close, Settlements)
 *     3. ./handlers-canteen-sales.js     (POS Checkout, Student Radar, Offline Sync, Sales)
 *     4. ./handlers-canteen-inventory.js (Purchases, Inventory, Items, Suppliers, Waste, Surplus)
 * ==============================================================================
 */

// 1. Core Helpers, Self-Healing Schema, Dashboard Metrics & POS Settings
export {
  getMyanmarDateString,
  computeAcademicFy,
  safeAmount,
  safeSignedAmount,
  isFullAccessRole,
  calculateSmartPrice,
  recalculateCanteenBookBalances,
  ensureCanteenSchema,
  getCanteenDashboardMetrics,
  getPosSettings,
  updatePosSettings
} from './handlers-canteen-core.js';

// 2. POS Cash Book Ledger, Store Day Closure & Evening Settlements
export {
  getPosCashBookData,
  savePosCashBookEntry,
  deletePosCashBookEntry,
  closeCanteenDay,
  getCanteenClosureStatus,
  getCanteenDailySummary,
  saveCanteenSettlement,
  getCanteenSettlements,
  getUnclosedCanteenDates
} from './handlers-canteen-cashbook.js';

// 3. POS Checkout, Student Pocket Money Radar, Offline Sync & Sales History
export {
  getPosSalesOrdersHistory,
  lookupStudentForPos,
  getPosStudentsSnapshot,
  checkoutPosSale,
  syncOfflinePosOrders
} from './handlers-canteen-sales.js';

// 4. Purchases, Stock Inventory, Items Master, Suppliers, Wastage & Surplus
export {
  getPosSurplusHistory,
  savePosSurplusEntry,
  deletePosSurplusEntry,
  getPosWasteHistory,
  savePosWasteEntry,
  deletePosWasteEntry,
  getPosPurchasesHistory,
  savePosPurchase,
  updatePosPurchase,
  deletePosPurchase,
  getPosStockInventory,
  updatePosItemQuick,
  getPosItems,
  savePosItem,
  getPosSuppliers,
  savePosSupplier
} from './handlers-canteen-inventory.js';