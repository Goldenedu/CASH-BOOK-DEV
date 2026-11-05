/**
 * ==============================================================================
 * GOLDEN ERP SYSTEM - CANTEEN POS CORE, SCHEMA, DASHBOARD & SETTINGS
 * File: handlers-canteen-core.js (Location: cashbook-api/handlers-canteen-core.js)
 * ==============================================================================
 */

import {
  recalculateLedgerBalances,
  getCurrentAcademicYear
} from './utils.js';

// ------------------------------------------------------------------------------
// 🕒 1. STRICT MYANMAR STANDARD TIME ENGINE & SHARED HELPERS
// ------------------------------------------------------------------------------
export function getMyanmarDateString(dInput) {
  if (dInput && typeof dInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dInput.trim())) {
    return dInput.trim();
  }
  const d = dInput ? new Date(dInput) : new Date();
  const targetMs = isNaN(d.getTime()) ? Date.now() : d.getTime();
  const mmt = new Date(targetMs + (6.5 * 60 * 60 * 1000));
  return mmt.toISOString().slice(0, 10);
}

export function computeAcademicFy(dateStr) {
  const cleanDate = dateStr || getMyanmarDateString();
  const d = new Date(cleanDate);
  if (isNaN(d.getTime())) return getCurrentAcademicYear();
  let year = d.getFullYear();
  if (d.getMonth() < 2) year -= 1;
  return `${year}-${year + 1}`;
}

// 🛡️ Strictly Positive Amount Sanitizer (For Debit, Credit, Price, Qty)
export function safeAmount(val) {
  const num = Number(val);
  return (Number.isFinite(num) && num > 0) ? Math.round(num * 100) / 100 : 0;
}

// 🛡️ Signed Amount Sanitizer (For Surplus/Deficit: Accepts both + and -)
export function safeSignedAmount(val) {
  const num = Number(val);
  return Number.isFinite(num) ? Math.round(num * 100) / 100 : 0;
}

// 🛡️ Role Privilege Checker (Admin / Owner / Finance vs Daily Operational Roles)
export function isFullAccessRole(session) {
  const rawRole = String(session?.role || 'Cashier').trim().toLowerCase().replace(/[\s_-]/g, '');
  return rawRole.includes('admin') || rawRole.includes('owner') || rawRole.includes('finance');
}

// 💡 Smart Pricing Rounding Engine (50-Step Rounding)
export function calculateSmartPrice(costPrice, markupPercent = 8, roundTo = 50) {
  const cost = safeAmount(costPrice);
  const markup = Math.max(0, Number(markupPercent !== undefined ? markupPercent : 8));
  const rawPrice = cost * (1 + markup / 100);
  if (rawPrice <= 0) return 0;

  const step = (roundTo === 100) ? 100 : 50;
  return Math.ceil(rawPrice / step) * step;
}

export async function recalculateCanteenBookBalances(db, fy, fromDate) {
  return recalculateLedgerBalances(db, 'canteen_book', fy, fromDate);
}

// ------------------------------------------------------------------------------
// 🛡️ 2. SELF-HEALING SCHEMA GUARDIAN (AUTO-MIGRATION FALLBACK)
// ------------------------------------------------------------------------------
let _schemaInitialized = false;
export async function ensureCanteenSchema(db) {
  if (_schemaInitialized || !db || typeof db.prepare !== 'function') return;

  // 2.1 POS Cash Book Table
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS pos_cash_book (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        no INTEGER DEFAULT 1,
        date TEXT NOT NULL,
        category TEXT DEFAULT 'POS Sales',
        description TEXT,
        method TEXT DEFAULT 'Cash',
        debit REAL DEFAULT 0,
        credit REAL DEFAULT 0,
        balances REAL DEFAULT 0,
        ref TEXT DEFAULT '',
        surplus_deficit REAL DEFAULT 0,
        vr_no TEXT,
        my TEXT,
        fy TEXT DEFAULT 'FY 2026-2027',
        created_by TEXT DEFAULT 'Cashier',
        created_at TEXT DEFAULT (datetime('now')),
        uniqueid TEXT UNIQUE
      )
    `).run();
  } catch (e) { }

  // 2.2 New Columns Migration for Items, Suppliers & Purchases
  const alterStatements = [
    "ALTER TABLE pos_items_master ADD COLUMN surplus_stock REAL NOT NULL DEFAULT 0",
    "ALTER TABLE pos_items_master ADD COLUMN wholesale_markup REAL NOT NULL DEFAULT 5",
    "ALTER TABLE pos_items_master ADD COLUMN wholesale_price REAL NOT NULL DEFAULT 0",
    "ALTER TABLE pos_suppliers ADD COLUMN shop_name TEXT DEFAULT ''",
    "ALTER TABLE pos_purchases ADD COLUMN no INTEGER DEFAULT 1",
    "ALTER TABLE pos_purchases ADD COLUMN voucher_no TEXT DEFAULT ''",
    "ALTER TABLE pos_purchases ADD COLUMN vr_no TEXT DEFAULT ''",
    "ALTER TABLE pos_purchases ADD COLUMN category TEXT DEFAULT 'Snack'",
    "ALTER TABLE pos_purchases ADD COLUMN item_name TEXT DEFAULT ''",
    "ALTER TABLE pos_purchases ADD COLUMN method TEXT DEFAULT 'Cash'",
    "ALTER TABLE pos_purchases ADD COLUMN wholesale_markup REAL DEFAULT 5",
    "ALTER TABLE pos_purchases ADD COLUMN wholesale_price REAL DEFAULT 0",
    "ALTER TABLE pos_purchases ADD COLUMN supplier_name TEXT DEFAULT ''",
    "ALTER TABLE pos_purchases ADD COLUMN shop_name TEXT DEFAULT ''",
    "ALTER TABLE pos_purchases ADD COLUMN phone_no TEXT DEFAULT ''",
    "ALTER TABLE pos_purchases ADD COLUMN address TEXT DEFAULT ''",
    "ALTER TABLE pos_purchases ADD COLUMN ref TEXT DEFAULT ''",
    "ALTER TABLE pos_purchases ADD COLUMN ref_no TEXT DEFAULT ''",
    "ALTER TABLE pos_purchases ADD COLUMN voucher_amount REAL DEFAULT 0",
    "ALTER TABLE pos_purchases ADD COLUMN surplus_deficit REAL DEFAULT 0",
    "ALTER TABLE pos_purchases ADD COLUMN uniqueid TEXT",
    "ALTER TABLE pos_waste_records ADD COLUMN items_json TEXT"
  ];

  for (const sql of alterStatements) {
    try { await db.prepare(sql).run(); } catch (e) { }
  }

  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS pos_surplus_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        surplus_no TEXT UNIQUE NOT NULL,
        date TEXT NOT NULL,
        reason TEXT NOT NULL,
        total_surplus_value REAL NOT NULL DEFAULT 0,
        total_items_qty REAL NOT NULL DEFAULT 0,
        items_summary TEXT NOT NULL,
        items_json TEXT,
        remark TEXT,
        reported_by TEXT NOT NULL DEFAULT 'Cashier',
        uniqueid TEXT UNIQUE NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `).run();
  } catch (e) { }

  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS canteen_day_closures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT UNIQUE NOT NULL,
        closed_at TEXT NOT NULL DEFAULT (datetime('now')),
        closed_by TEXT NOT NULL,
        total_sales REAL NOT NULL DEFAULT 0,
        cash_sales REAL NOT NULL DEFAULT 0,
        wallet_sales REAL NOT NULL DEFAULT 0,
        total_orders INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'CLOSED',
        remark TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `).run();
  } catch (e) { }

  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS pos_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL,
        description TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `).run();
    await db.prepare(`
      INSERT INTO pos_settings (setting_key, setting_value, description)
      VALUES ('daily_spending_cap', '10000', 'Daily Student Spending Cap (MMK)')
      ON CONFLICT(setting_key) DO NOTHING
    `).run();
  } catch (e) { }

  _schemaInitialized = true;
}

// ==============================================================================
// 📊 3. CANTEEN EXECUTIVE DASHBOARD METRICS
// ==============================================================================
export async function getCanteenDashboardMetrics(db, body) {
  try {
    await ensureCanteenSchema(db);
    const todayStr = getMyanmarDateString();
    const date = String(body.date || todayStr).trim();

    const monthPrefix = date.slice(0, 7);
    const monthStart = `${monthPrefix}-01`;
    const [y, m] = monthPrefix.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const monthEnd = `${monthPrefix}-${String(lastDay).padStart(2, '0')}`;

    const batchQueries = [
      db.prepare(`
        SELECT 
          COUNT(id) as totalOrders,
          COALESCE(SUM(total_amount), 0) as totalSales,
          COALESCE(SUM(CASE WHEN payment_method = 'Student Pocket Money' THEN total_amount ELSE 0 END), 0) as pocketMoneyShare,
          COALESCE(SUM(CASE WHEN payment_method = 'Cash' THEN total_amount ELSE 0 END), 0) as cashSalesShare,
          COALESCE(SUM(net_profit), 0) as totalProfit
        FROM pos_sales_orders 
        WHERE date = ?
      `).bind(date),

      db.prepare(`
        SELECT 
          settlement_no as settlementNo, 
          net_payout_amount as netPayoutAmount, 
          created_at as createdAt, 
          handed_over_by as handedOverBy, 
          received_by as receivedBy 
        FROM canteen_settlements 
        WHERE date = ? 
        LIMIT 1
      `).bind(date),

      db.prepare(`
        SELECT 
          COUNT(id) as allTimeOrders,
          COALESCE(SUM(total_amount), 0) as allTimeSales,
          COALESCE(SUM(CASE WHEN payment_method = 'Student Pocket Money' THEN total_amount ELSE 0 END), 0) as allTimePocketShare,
          COALESCE(SUM(CASE WHEN payment_method = 'Cash' THEN total_amount ELSE 0 END), 0) as allTimeCashShare,
          COALESCE(SUM(net_profit), 0) as allTimeProfit
        FROM pos_sales_orders
      `),

      db.prepare(`
        SELECT 
          COALESCE(SUM(CASE WHEN current_stock <= 10 THEN 1 ELSE 0 END), 0) as lowStockCount,
          COALESCE(SUM(
            CASE 
              WHEN (current_stock - COALESCE(surplus_stock, 0)) > 0 
              THEN (cost_price * (current_stock - COALESCE(surplus_stock, 0))) 
              ELSE 0 
            END
          ), 0) as totalStockCapital
        FROM pos_items_master 
        WHERE is_active = 1
      `),

      db.prepare(`
        SELECT 
          COALESCE(SUM(CASE WHEN date = ? THEN total_loss_cost ELSE 0 END), 0) as todayLossCost,
          COALESCE(SUM(CASE WHEN date >= ? AND date <= ? THEN total_loss_cost ELSE 0 END), 0) as monthLossCost,
          COALESCE(SUM(total_loss_cost), 0) as allTimeLossCost
        FROM pos_waste_records
      `).bind(date, monthStart, monthEnd),

      db.prepare(`
        SELECT 
          COALESCE(SUM(CASE WHEN date = ? THEN total_surplus_value ELSE 0 END), 0) as todaySurplusValue,
          COALESCE(SUM(CASE WHEN date >= ? AND date <= ? THEN total_surplus_value ELSE 0 END), 0) as monthSurplusValue,
          COALESCE(SUM(total_surplus_value), 0) as allTimeSurplusValue
        FROM pos_surplus_records
      `).bind(date, monthStart, monthEnd),

      db.prepare(`
        SELECT date, closed_at as closedAt, closed_by as closedBy, status 
        FROM canteen_day_closures WHERE date = ? LIMIT 1
      `).bind(date),

      db.prepare(`
        SELECT 
          COUNT(id) as monthOrders,
          COALESCE(SUM(total_amount), 0) as monthSales,
          COALESCE(SUM(CASE WHEN payment_method = 'Student Pocket Money' THEN total_amount ELSE 0 END), 0) as monthPocketShare,
          COALESCE(SUM(CASE WHEN payment_method = 'Cash' THEN total_amount ELSE 0 END), 0) as monthCashShare,
          COALESCE(SUM(net_profit), 0) as monthProfit
        FROM pos_sales_orders 
        WHERE date >= ? AND date <= ?
      `).bind(monthStart, monthEnd),

      db.prepare(`
        SELECT 
          p.date,
          COUNT(p.id) as totalOrders,
          COALESCE(SUM(p.total_amount), 0) as totalSales
        FROM pos_sales_orders p
        LEFT JOIN canteen_day_closures c ON p.date = c.date
        WHERE c.id IS NULL AND p.date < ?
        GROUP BY p.date
        ORDER BY p.date DESC
        LIMIT 3
      `).bind(todayStr)
    ];

    const [todayRes, settleRes, allTimeRes, stockRes, wasteRes, surplusRes, closureRes, monthRes, unclosedRes] = await db.batch(batchQueries);

    const todayStats = todayRes?.results?.[0] || {};
    const settle = settleRes?.results?.[0] || null;
    const allTimeStats = allTimeRes?.results?.[0] || {};
    const stockStats = stockRes?.results?.[0] || {};
    const wasteStats = wasteRes?.results?.[0] || {};
    const surplusStats = surplusRes?.results?.[0] || {};
    const closure = closureRes?.results?.[0] || null;
    const monthStats = monthRes?.results?.[0] || {};
    const unclosedPastDays = unclosedRes?.results || [];

    const lowStockCount = Number(stockStats.lowStockCount || 0);
    const totalStockCapital = parseFloat(stockStats.totalStockCapital || 0);

    const todayLossCost = parseFloat(wasteStats.todayLossCost || 0);
    const todaySurplusValue = parseFloat(surplusStats.todaySurplusValue || 0);
    const todayNetLoss = Math.round((todayLossCost - todaySurplusValue) * 100) / 100;

    const monthLossCost = parseFloat(wasteStats.monthLossCost || 0);
    const monthSurplusValue = parseFloat(surplusStats.monthSurplusValue || 0);
    const monthNetLoss = Math.round((monthLossCost - monthSurplusValue) * 100) / 100;

    const allTimeLossCost = parseFloat(wasteStats.allTimeLossCost || 0);
    const allTimeSurplusValue = parseFloat(surplusStats.allTimeSurplusValue || 0);
    const allTimeNetLoss = Math.round((allTimeLossCost - allTimeSurplusValue) * 100) / 100;

    return {
      success: true,
      data: {
        date,
        monthPrefix,
        unclosedPastDays,
        hasUnclosedPastDays: unclosedPastDays.length > 0,
        today: {
          totalOrders: todayStats.totalOrders || 0,
          totalSales: parseFloat(todayStats.totalSales || 0),
          pocketMoneyShare: parseFloat(todayStats.pocketMoneyShare || 0),
          cashSalesShare: parseFloat(todayStats.cashSalesShare || 0),
          totalProfit: parseFloat(todayStats.totalProfit || 0),
          todayLossCost,
          todaySurplusValue,
          todayNetLoss,
          isSettled: Boolean(settle),
          settlement: settle,
          isClosed: Boolean(closure),
          closure: closure
        },
        thisMonth: {
          monthPrefix,
          totalOrders: monthStats.monthOrders || 0,
          totalSales: parseFloat(monthStats.monthSales || 0),
          pocketMoneyShare: parseFloat(monthStats.monthPocketShare || 0),
          cashSalesShare: parseFloat(monthStats.monthCashShare || 0),
          totalProfit: parseFloat(monthStats.monthProfit || 0),
          monthLossCost,
          monthSurplusValue,
          monthNetLoss
        },
        allTime: {
          totalOrders: allTimeStats.allTimeOrders || 0,
          totalSales: parseFloat(allTimeStats.allTimeSales || 0),
          pocketMoneyShare: parseFloat(allTimeStats.allTimePocketShare || 0),
          cashSalesShare: parseFloat(allTimeStats.allTimeCashShare || 0),
          totalProfit: parseFloat(allTimeStats.allTimeProfit || 0),
          totalStockCapital,
          allTimeLossCost,
          allTimeSurplusValue,
          allTimeNetLoss
        },
        totalStockCapital,
        lowStockCount,
        todayLossCost,
        todaySurplusValue,
        todayNetLoss,
        monthLossCost,
        monthSurplusValue,
        monthNetLoss,
        allTimeLossCost,
        allTimeSurplusValue,
        allTimeNetLoss,
        isClosed: Boolean(closure)
      }
    };
  } catch (err) {
    return { success: false, message: "Failed to load dashboard metrics: " + err.message };
  }
}

// ==============================================================================
// ⚙️ 4. DYNAMIC POS SETTINGS (ALLOWANCE CAP)
// ==============================================================================
export async function getPosSettings(db) {
  try {
    await ensureCanteenSchema(db);
    const res = await db.prepare("SELECT setting_key as settingKey, setting_value as settingValue, description, updated_at as updatedAt FROM pos_settings").all();
    const settingsMap = {};
    (res.results || []).forEach(r => {
      settingsMap[r.settingKey] = r.settingValue;
    });

    if (!settingsMap.daily_spending_cap) {
      settingsMap.daily_spending_cap = '10000';
    }

    return { success: true, data: settingsMap, list: res.results || [] };
  } catch (err) {
    return { success: false, message: "Failed to load POS settings: " + err.message };
  }
}

export async function updatePosSettings(db, session, body) {
  try {
    await ensureCanteenSchema(db);
    const key = String(body.settingKey || body.key || '').trim();
    const val = String(body.settingValue || body.value || '').trim();

    if (!key) return { success: false, message: "Setting Key is required." };

    if (key === 'daily_spending_cap') {
      const numVal = parseInt(val, 10);
      if (isNaN(numVal) || numVal < 0) {
        return { success: false, message: "Daily spending cap must be 0 MMK or higher." };
      }
    }

    await db.prepare(`
      INSERT INTO pos_settings (setting_key, setting_value, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(setting_key) DO UPDATE SET
        setting_value = excluded.setting_value,
        updated_at = datetime('now')
    `).bind(key, val).run();

    return { success: true, message: "POS Settings updated successfully." };
  } catch (err) {
    return { success: false, message: "Failed to update POS settings: " + err.message };
  }
}