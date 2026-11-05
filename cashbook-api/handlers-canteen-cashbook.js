/**
 * ==============================================================================
 * GOLDEN ERP SYSTEM - POS CASH BOOK, DAY CLOSING & EVENING SETTLEMENT HANDLERS
 * File: handlers-canteen-cashbook.js (Location: cashbook-api/handlers-canteen-cashbook.js)
 * ==============================================================================
 */

import {
  normalizeFyStr,
  generateUniqueId,
  generateVoucherNo,
  generateFyNo,
  recalculateLedgerBalances,
  verifyRecordMutationPolicy
} from './utils.js';

import {
  getMyanmarDateString,
  computeAcademicFy,
  safeAmount,
  safeSignedAmount,
  isFullAccessRole,
  ensureCanteenSchema,
  recalculateCanteenBookBalances
} from './handlers-canteen-core.js';

// ==============================================================================
// 💰 1. POS CASH BOOK LEDGER (ROLE-SCOPED KPIS & TRANSACTIONS)
// ==============================================================================
export async function getPosCashBookData(db, session, body) {
  try {
    await ensureCanteenSchema(db);
    const todayStr = getMyanmarDateString();
    const isAdmin = isFullAccessRole(session);

    const page = Math.max(1, parseInt(body.page || 1, 10));
    const limit = Math.min(100, Math.max(1, parseInt(body.limit || 20, 10)));
    const offset = (page - 1) * limit;

    const searchVal = String(body.searchVal || "").trim();
    let dateFrom = String(body.dateFrom || "").trim();
    let dateTo = String(body.dateTo || "").trim();

    // Calendar Year Scope for Admin (Jan 1 to Dec 31 - Resets every new year)
    const activeYear = (dateFrom && /^\d{4}/.test(dateFrom)) ? dateFrom.slice(0, 4) : todayStr.slice(0, 4);
    const yearStart = `${activeYear}-01-01`;
    const yearEnd = `${activeYear}-12-31`;

    let whereClauses = [];
    let params = [];

    if (isAdmin) {
      if (dateFrom) { whereClauses.push(`date >= ?`); params.push(dateFrom); }
      else { whereClauses.push(`date >= ?`); params.push(yearStart); }

      if (dateTo) { whereClauses.push(`date <= ?`); params.push(dateTo); }
      else { whereClauses.push(`date <= ?`); params.push(yearEnd); }
    } else {
      // Non-admin roles strictly view ONLY Today's Daily Transactions
      whereClauses.push(`date = ?`);
      params.push(todayStr);
    }

    if (searchVal) {
      whereClauses.push(`(description LIKE ? OR category LIKE ? OR ref LIKE ? OR vr_no LIKE ?)`);
      const p = `%${searchVal}%`;
      params.push(p, p, p, p);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // KPI Scope: Admin sees Jan-Dec Yearly KPIs; Others see strictly Today's Daily KPIs
    const kpiWhereSql = isAdmin ? `WHERE date >= ? AND date <= ?` : `WHERE date = ?`;
    const kpiParams = isAdmin ? [yearStart, yearEnd] : [todayStr];

    const [kpiRes, countRes, rowsRes] = await db.batch([
      db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN method = 'Bank' THEN (debit - credit) ELSE 0 END), 0) as bankBalance,
          COALESCE(SUM(CASE WHEN method = 'Cash' THEN (debit - credit) ELSE 0 END), 0) as cashBalance,
          COALESCE(SUM(debit - credit), 0) as totalBalance,
          COUNT(id) as totalEntries
        FROM pos_cash_book
        ${kpiWhereSql}
      `).bind(...kpiParams),

      db.prepare(`SELECT COUNT(id) as totalRows FROM pos_cash_book ${whereSql}`).bind(...params),

      db.prepare(`
        SELECT
          id,
          no,
          date,
          category,
          description,
          method,
          debit,
          credit,
          balances,
          ref,
          COALESCE(surplus_deficit, 0) as surplusDeficit,
          vr_no as vrNo,
          my,
          fy,
          created_by as createdBy,
          uniqueid as uniqueId
        FROM pos_cash_book
        ${whereSql}
        ORDER BY CAST(no AS INTEGER) DESC, id DESC
        LIMIT ? OFFSET ?
      `).bind(...params, limit, offset)
    ]);

    const kpi = kpiRes?.results?.[0] || {};
    const totalRows = countRes?.results?.[0]?.totalRows || 0;

    return {
      success: true,
      year: activeYear,
      scope: isAdmin ? 'YEARLY' : 'DAILY',
      data: rowsRes?.results || [],
      totalRows,
      page,
      limit,
      stats: {
        bankBalance: parseFloat(kpi.bankBalance || 0),
        cashBalance: parseFloat(kpi.cashBalance || 0),
        totalBalance: parseFloat(kpi.totalBalance || 0),
        totalEntries: parseInt(kpi.totalEntries || 0, 10)
      }
    };
  } catch (err) {
    return { success: false, message: "Failed to load POS Cash Book: " + err.message };
  }
}

export async function savePosCashBookEntry(db, session, body) {
  try {
    await ensureCanteenSchema(db);
    const entryDate = getMyanmarDateString(body.date);
    const d = new Date(entryDate);
    const my = `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]}-${d.getFullYear()}`;
    const fy = normalizeFyStr(body.fy || computeAcademicFy(entryDate));

    // Strict Validation: Debit & Credit only accept positive values (>= 0)
    if (Number(body.debit) < 0 || Number(body.credit) < 0) {
      return { success: false, message: "Debit and Credit cannot be negative numbers." };
    }

    const debit = safeAmount(body.debit);
    const credit = safeAmount(body.credit);
    // Surplus/Deficit accepts both + and -
    const surplusDeficit = safeSignedAmount(body.surplusDeficit !== undefined ? body.surplusDeficit : body.surplus_deficit);

    if (debit <= 0 && credit <= 0 && surplusDeficit === 0) {
      return { success: false, message: "Please enter a valid Debit, Credit, or Surplus/Deficit amount." };
    }

    const category = String(body.category || 'POS Sales').trim();
    const description = String(body.description || '').trim();
    const method = (String(body.method || 'Cash').trim() === 'Bank') ? 'Bank' : 'Cash';
    const ref = String(body.ref || '').trim();

    const rawCore = body.uniqueId ? String(body.uniqueId).trim().replace(/^PCB_/i, '') : generateUniqueId('').replace(/^_/, '');
    const pcbUniqueId = `PCB_${rawCore}`;

    const existing = await db.prepare("SELECT id, vr_no FROM pos_cash_book WHERE uniqueid = ?").bind(pcbUniqueId).first();
    if (existing && !body.isUpdate) {
      return { success: true, uniqueId: pcbUniqueId, vrNo: existing.vr_no, message: "Entry already recorded." };
    }

    const noPcb = await generateFyNo(db, 'pos_cash_book', fy);
    const vrPcb = body.vrNo || await generateVoucherNo(db, 'pos_cash_book', 'PCB', entryDate);

    await db.prepare(`
      INSERT INTO pos_cash_book (no, date, category, description, method, debit, credit, balances, ref, surplus_deficit, vr_no, my, fy, created_by, uniqueid)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      noPcb, entryDate, category, description, method,
      debit, credit, ref || vrPcb, surplusDeficit,
      vrPcb, my, fy, session?.name || 'Cashier', pcbUniqueId
    ).run();

    await recalculateLedgerBalances(db, 'pos_cash_book', fy, entryDate);

    return {
      success: true,
      uniqueId: pcbUniqueId,
      vrNo: vrPcb,
      message: "POS Cash Book entry saved successfully."
    };
  } catch (err) {
    return { success: false, message: "Failed to save POS Cash Book entry: " + err.message };
  }
}

export async function deletePosCashBookEntry(db, session, body) {
  try {
    await ensureCanteenSchema(db);
    const uid = String(body.uniqueId || "").trim();
    if (!uid) return { success: false, message: "Unique ID is required." };

    const existing = await db.prepare("SELECT id, fy, date FROM pos_cash_book WHERE uniqueid = ?").bind(uid).first();
    if (!existing) return { success: false, message: "Entry not found." };

    const policy = verifyRecordMutationPolicy(session, existing.date);
    if (!policy.allowed) return { success: false, message: policy.message };

    await db.prepare("DELETE FROM pos_cash_book WHERE id = ?").bind(existing.id).run();
    await recalculateLedgerBalances(db, 'pos_cash_book', existing.fy, existing.date);

    return { success: true, message: "POS Cash Book entry deleted successfully." };
  } catch (err) {
    return { success: false, message: "Failed to delete POS Cash Book entry: " + err.message };
  }
}

// ==============================================================================
// 🔒 2. CANTEEN STORE CLOSURE & EVENING SETTLEMENT
// ==============================================================================
export async function closeCanteenDay(db, session, body) {
  try {
    await ensureCanteenSchema(db);
    const todayStr = getMyanmarDateString();
    let targetDate = String(body.date || "").trim();
    if (!targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) targetDate = todayStr;

    if (targetDate > todayStr) {
      return { success: false, message: `Cannot close register for a future date (${targetDate}).` };
    }

    const existing = await db.prepare("SELECT id, closed_at as closedAt, closed_by as closedBy FROM canteen_day_closures WHERE date = ?").bind(targetDate).first();
    if (existing) {
      return { success: false, message: `Register is already closed for (${targetDate}) by ${existing.closedBy}.` };
    }

    const stats = await db.prepare(`
      SELECT 
        COUNT(id) as totalOrders, 
        COALESCE(SUM(total_amount), 0) as totalSales,
        COALESCE(SUM(CASE WHEN payment_method = 'Student Pocket Money' THEN total_amount ELSE 0 END), 0) as walletSales,
        COALESCE(SUM(CASE WHEN payment_method = 'Cash' THEN total_amount ELSE 0 END), 0) as cashSales
      FROM pos_sales_orders 
      WHERE date = ?
    `).bind(targetDate).first();

    const totalOrders = stats?.totalOrders || 0;
    const totalSales = parseFloat(stats?.totalSales || 0);
    const walletSales = parseFloat(stats?.walletSales || 0);
    const cashSales = parseFloat(stats?.cashSales || 0);
    const closedBy = session?.name || 'Canteen Manager';
    const remark = String(body.remark || '').trim();

    await db.prepare(`
      INSERT INTO canteen_day_closures (date, closed_at, closed_by, total_sales, cash_sales, wallet_sales, total_orders, status, remark)
      VALUES (?, datetime('now'), ?, ?, ?, ?, ?, 'CLOSED', ?)
    `).bind(targetDate, closedBy, totalSales, cashSales, walletSales, totalOrders, remark).run();

    return {
      success: true,
      data: { date: targetDate, totalSales, cashSales, walletSales, totalOrders, closedBy },
      message: `Daily register closed for (${targetDate}). Ready for Finance settlement.`
    };
  } catch (err) {
    return { success: false, message: "Failed to close register: " + err.message };
  }
}

export async function getCanteenClosureStatus(db, body) {
  try {
    const todayStr = getMyanmarDateString();
    let targetDate = String(body.date || "").trim();
    if (!targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) targetDate = todayStr;

    let row = null;
    try {
      row = await db.prepare(`SELECT date, closed_at as closedAt, closed_by as closedBy, total_sales as totalSales, cash_sales as cashSales, wallet_sales as walletSales, total_orders as totalOrders, status, remark FROM canteen_day_closures WHERE date = ? LIMIT 1`).bind(targetDate).first();
    } catch (e) { }

    return { success: true, isClosed: Boolean(row), data: row || null };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

export async function getCanteenDailySummary(db, body) {
  try {
    await ensureCanteenSchema(db);
    const todayStr = getMyanmarDateString();
    const todayMs = new Date(todayStr + "T00:00:00Z").getTime();
    const yesterdayStr = new Date(todayMs - 86400000).toISOString().slice(0, 10);

    let targetDate = String(body.date || "").trim();
    if (!targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) targetDate = todayStr;

    const [summaryRes, settleRes, closureRes, unclosedRes] = await db.batch([
      db.prepare(`
        SELECT 
          COUNT(id) as totalOrders, 
          COALESCE(SUM(total_amount), 0) as totalSales,
          COALESCE(SUM(CASE WHEN payment_method = 'Student Pocket Money' THEN total_amount ELSE 0 END), 0) as pocketMoneyShare,
          COALESCE(SUM(CASE WHEN payment_method = 'Cash' THEN total_amount ELSE 0 END), 0) as cashSalesShare,
          COALESCE(SUM(net_profit), 0) as totalProfit
        FROM pos_sales_orders 
        WHERE date = ?
      `).bind(targetDate),

      db.prepare(`
        SELECT settlement_no as settlementNo, net_payout_amount as netPayoutAmount, created_at as createdAt, handed_over_by as handedOverBy, received_by as receivedBy 
        FROM canteen_settlements WHERE date = ? LIMIT 1
      `).bind(targetDate),

      db.prepare(`
        SELECT date, closed_at as closedAt, closed_by as closedBy, total_sales as totalSales, status 
        FROM canteen_day_closures WHERE date = ? LIMIT 1
      `).bind(targetDate),

      db.prepare(`
        SELECT 
          p.date,
          COUNT(p.id) as totalOrders,
          COALESCE(SUM(p.total_amount), 0) as totalSales,
          COALESCE(SUM(CASE WHEN p.payment_method = 'Student Pocket Money' THEN p.total_amount ELSE 0 END), 0) as walletSales,
          COALESCE(SUM(CASE WHEN p.payment_method = 'Cash' THEN p.total_amount ELSE 0 END), 0) as cashSales
        FROM pos_sales_orders p
        LEFT JOIN canteen_day_closures c ON p.date = c.date
        WHERE c.id IS NULL AND p.date < ?
        GROUP BY p.date
        ORDER BY p.date DESC
        LIMIT 5
      `).bind(todayStr)
    ]);

    const stats = summaryRes?.results?.[0] || {};
    const settleRow = settleRes?.results?.[0] || null;
    const closureRow = closureRes?.results?.[0] || null;
    const unclosedPastDays = unclosedRes?.results || [];
    const isYesterdayUnclosed = unclosedPastDays.some(d => d.date === yesterdayStr);

    return {
      success: true,
      data: {
        date: targetDate,
        today: todayStr,
        yesterday: yesterdayStr,
        isYesterdayUnclosed,
        unclosedPastDays,
        totalOrders: stats.totalOrders || 0,
        totalSales: parseFloat(stats.totalSales || 0),
        pocketMoneyShare: parseFloat(stats.pocketMoneyShare || 0),
        cashSalesShare: parseFloat(stats.cashSalesShare || 0),
        totalProfit: parseFloat(stats.totalProfit || 0),
        isSettled: Boolean(settleRow),
        settlement: settleRow,
        isClosed: Boolean(closureRow),
        closure: closureRow
      }
    };
  } catch (err) {
    return { success: false, message: "Failed to load daily summary: " + err.message };
  }
}

export async function saveCanteenSettlement(db, session, body) {
  try {
    const todayStr = getMyanmarDateString();
    let entryDate = String(body.date || "").trim();
    if (!entryDate || !/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) entryDate = todayStr;

    const pocketMoneyShare = safeAmount(body.pocketMoneyShare);
    const cashSalesShare = safeAmount(body.cashSalesShare);
    const totalSales = Math.round((pocketMoneyShare + cashSalesShare) * 100) / 100;
    const netPayout = safeAmount(body.netPayoutAmount || pocketMoneyShare);

    if (totalSales <= 0) return { success: false, message: "No sales to settle for this date." };

    try {
      const closureCheck = await db.prepare("SELECT id FROM canteen_day_closures WHERE date = ?").bind(entryDate).first();
      if (!closureCheck) {
        return {
          success: false,
          message: `Cannot settle yet! Canteen register for (${entryDate}) must be closed first.`
        };
      }
    } catch (e) { }

    const rawCore = body.uniqueId ? String(body.uniqueId).trim().replace(/^SETTLE_/i, '') : generateUniqueId('').replace(/^_/, '');
    const settleUniqueId = `SETTLE_${rawCore}`;
    const canSettleUniqueId = `CAN_SETTLE_${rawCore}`;
    const settlementNo = `SETTLE-${entryDate.replace(/-/g, '')}-${generateUniqueId('').slice(-3).toUpperCase()}`;

    const dupCheck = await db.prepare("SELECT settlement_no FROM canteen_settlements WHERE uniqueid = ? OR date = ?").bind(settleUniqueId, entryDate).first();
    if (dupCheck) return { success: false, message: `Date (${entryDate}) is already settled (${dupCheck.settlement_no}).` };

    const d = new Date(entryDate);
    const my = `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]}-${d.getFullYear()}`;
    const fy = normalizeFyStr(computeAcademicFy(entryDate));
    const noCan = await generateFyNo(db, 'canteen_book', fy);

    await db.batch([
      db.prepare(`
        INSERT INTO canteen_settlements (settlement_no, date, settlement_type, total_sales_amount, pocket_money_share, cash_sales_share, net_payout_amount, handed_over_by, received_by, remark, uniqueid)
        VALUES (?, ?, 'Evening Cash Out', ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        settlementNo, entryDate, totalSales, pocketMoneyShare, cashSalesShare, netPayout,
        body.handedOverBy || session?.name || 'Finance Admin',
        body.receivedBy || 'Canteen Manager',
        body.remark || 'Evening Canteen Pocket Money Settlement',
        settleUniqueId
      ),

      db.prepare(`
        INSERT INTO canteen_book (no, date, category, description, method, debit, credit, balances, vr_no, my, fy, created_by, uniqueid)
        VALUES (?, ?, 'Settlement Payout', ?, 'Cash', 0, ?, 0, ?, ?, ?, ?, ?)
      `).bind(
        noCan, entryDate, `[${settlementNo}] Pocket Money Sales Settlement Payout from Finance`,
        netPayout, settlementNo, my, fy, session?.name || 'Finance Admin', canSettleUniqueId
      )
    ]);

    await recalculateCanteenBookBalances(db, fy, entryDate);
    return {
      success: true,
      settlementNo,
      netPayoutAmount: netPayout,
      message: "Canteen settlement recorded successfully."
    };
  } catch (err) {
    return { success: false, message: "Settlement failed: " + err.message };
  }
}

export async function getCanteenSettlements(db, body) {
  try {
    const dateFrom = String(body.dateFrom || "").trim();
    const dateTo = String(body.dateTo || "").trim();
    const searchVal = String(body.searchVal || "").trim();
    const page = Math.max(1, parseInt(body.page || 1, 10));
    const limit = Math.min(100, Math.max(1, parseInt(body.limit || 20, 10)));
    const offset = (page - 1) * limit;

    let whereClauses = [];
    let params = [];

    if (dateFrom) { whereClauses.push(`date >= ?`); params.push(dateFrom); }
    if (dateTo) { whereClauses.push(`date <= ?`); params.push(dateTo); }
    if (searchVal) {
      whereClauses.push(`(settlement_no LIKE ? OR handed_over_by LIKE ? OR received_by LIKE ? OR remark LIKE ?)`);
      const p = `%${searchVal}%`;
      params.push(p, p, p, p);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const [countRes, rowsRes] = await db.batch([
      db.prepare(`
        SELECT 
          COUNT(id) as totalRows,
          COALESCE(SUM(total_sales_amount), 0) as totalSalesAmount,
          COALESCE(SUM(pocket_money_share), 0) as totalPocketMoneyShare,
          COALESCE(SUM(cash_sales_share), 0) as totalCashSalesShare,
          COALESCE(SUM(net_payout_amount), 0) as totalPayoutAmount
        FROM canteen_settlements
        ${whereSql}
      `).bind(...params),

      db.prepare(`
        SELECT 
          id, settlement_no as settlementNo, date, settlement_type as settlementType,
          total_sales_amount as totalSalesAmount, pocket_money_share as pocketMoneyShare,
          cash_sales_share as cashSalesShare, net_payout_amount as netPayoutAmount,
          handed_over_by as handedOverBy, received_by as receivedBy, 
          remark, uniqueid, created_at as createdAt
        FROM canteen_settlements 
        ${whereSql}
        ORDER BY date DESC, id DESC 
        LIMIT ? OFFSET ?
      `).bind(...params, limit, offset)
    ]);

    const stats = countRes?.results?.[0] || {};
    return {
      success: true,
      data: rowsRes?.results || [],
      totalRows: stats.totalRows || 0,
      totalSalesAmount: parseFloat(stats.totalSalesAmount || 0),
      totalPocketMoneyShare: parseFloat(stats.totalPocketMoneyShare || 0),
      totalCashSalesShare: parseFloat(stats.totalCashSalesShare || 0),
      totalPayoutAmount: parseFloat(stats.totalPayoutAmount || 0),
      page,
      limit
    };
  } catch (err) {
    return { success: false, message: "Failed to load settlements: " + err.message };
  }
}

export async function getUnclosedCanteenDates(db, body) {
  try {
    await ensureCanteenSchema(db);
    const todayStr = getMyanmarDateString();
    const limit = Math.min(20, Math.max(1, parseInt(body?.limit || 10, 10)));

    const res = await db.prepare(`
      SELECT 
        p.date,
        COUNT(p.id) as totalOrders,
        COALESCE(SUM(p.total_amount), 0) as totalSales,
        COALESCE(SUM(CASE WHEN p.payment_method = 'Student Pocket Money' THEN p.total_amount ELSE 0 END), 0) as walletSales,
        COALESCE(SUM(CASE WHEN p.payment_method = 'Cash' THEN p.total_amount ELSE 0 END), 0) as cashSales,
        MAX(CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END) as isSettled
      FROM pos_sales_orders p
      LEFT JOIN canteen_day_closures c ON p.date = c.date
      LEFT JOIN canteen_settlements s ON p.date = s.date
      WHERE c.id IS NULL AND p.date <= ?
      GROUP BY p.date
      ORDER BY p.date DESC
      LIMIT ?
    `).bind(todayStr, limit).all();

    return {
      success: true,
      today: todayStr,
      data: res.results || []
    };
  } catch (err) {
    return { success: false, message: "Failed to load unclosed dates: " + err.message };
  }
}