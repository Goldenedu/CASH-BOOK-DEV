/**
 * ==============================================================================
 * GOLDEN ERP SYSTEM - CANTEEN INVENTORY, PURCHASES, SUPPLIERS, WASTE & SURPLUS
 * File: handlers-canteen-inventory.js (Location: cashbook-api/handlers-canteen-inventory.js)
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
  calculateSmartPrice,
  ensureCanteenSchema
} from './handlers-canteen-core.js';

// ==============================================================================
// 📦 1. STOCK SURPLUS LEDGER (CAPITAL INVARIANCE ENGINE)
// ==============================================================================
export async function getPosSurplusHistory(db, body) {
  try {
    await ensureCanteenSchema(db);
    const page = Math.max(1, parseInt(body.page || 1, 10));
    const limit = Math.min(100, Math.max(1, parseInt(body.limit || 20, 10)));
    const offset = (page - 1) * limit;

    const reason = String(body.reason || "").trim();
    const dateFrom = String(body.dateFrom || "").trim();
    const dateTo = String(body.dateTo || "").trim();
    const searchVal = String(body.searchVal || "").trim();

    let whereClauses = [];
    let params = [];

    if (reason) { whereClauses.push(`reason = ?`); params.push(reason); }
    if (dateFrom) { whereClauses.push(`date >= ?`); params.push(dateFrom); }
    if (dateTo) { whereClauses.push(`date <= ?`); params.push(dateTo); }
    if (searchVal) {
      whereClauses.push(`(surplus_no LIKE ? OR items_summary LIKE ? OR remark LIKE ? OR reported_by LIKE ?)`);
      const p = `%${searchVal}%`;
      params.push(p, p, p, p);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const [countRes, rowsRes] = await db.batch([
      db.prepare(`
        SELECT 
          COUNT(id) as totalRows, 
          COALESCE(SUM(total_surplus_value), 0) as totalSurplusAmount, 
          COALESCE(SUM(total_items_qty), 0) as totalSurplusQty 
        FROM pos_surplus_records 
        ${whereSql}
      `).bind(...params),

      db.prepare(`
        SELECT 
          id, surplus_no as surplusNo, date, reason, 
          total_surplus_value as totalSurplusValue, total_items_qty as totalItemsQty, 
          items_summary as itemsSummary, items_json as itemsJson, 
          remark, reported_by as reportedBy, uniqueid as uniqueId, created_at as createdAt 
        FROM pos_surplus_records 
        ${whereSql} 
        ORDER BY id DESC LIMIT ? OFFSET ?
      `).bind(...params, limit, offset)
    ]);

    const stats = countRes.results[0] || {};
    return {
      success: true,
      data: rowsRes.results || [],
      totalRows: stats.totalRows || 0,
      totalSurplusAmount: parseFloat(stats.totalSurplusAmount || 0),
      totalSurplusQty: parseFloat(stats.totalSurplusQty || 0),
      page,
      limit
    };
  } catch (err) {
    return { success: false, message: "Failed to load surplus history: " + err.message };
  }
}

export async function savePosSurplusEntry(db, session, body) {
  try {
    await ensureCanteenSchema(db);
    const entryDate = getMyanmarDateString(body.date);
    const reason = String(body.reason || 'Count Surplus').trim();
    const items = Array.isArray(body.items) ? body.items : [];
    const remark = String(body.remark || '').trim();

    if (items.length === 0) {
      return { success: false, message: "Please select at least 1 item for surplus entry." };
    }

    let totalSurplusValue = 0;
    let totalItemsQty = 0;
    const summaryParts = [];
    const stockAdditions = [];

    for (const it of items) {
      const bCode = String(it.barcode || '').trim();
      const name = String(it.name || it.itemName || 'Item').trim();
      const q = safeAmount(it.qty);
      const cost = safeAmount(it.costPrice || it.cost);

      if (!bCode || q <= 0) continue;

      totalItemsQty += q;
      totalSurplusValue += (q * cost);
      summaryParts.push(`${name} x ${q}`);
      stockAdditions.push({ barcode: bCode, qty: q, costPrice: cost, name });
    }

    totalSurplusValue = Math.round(totalSurplusValue * 100) / 100;
    if (totalItemsQty <= 0) {
      return { success: false, message: "Invalid item quantity." };
    }

    const itemsSummary = summaryParts.join(', ');
    const itemsJson = JSON.stringify(stockAdditions);
    const rawCore = body.uniqueId ? String(body.uniqueId).trim().replace(/^SUR_/i, '') : generateUniqueId('').replace(/^_/, '');
    const surplusUniqueId = `SUR_${rawCore}`;
    const surplusNo = `SUR-${entryDate.replace(/-/g, '')}-${generateUniqueId('').slice(-3).toUpperCase()}`;

    const batchStatements = [
      db.prepare(`
        INSERT INTO pos_surplus_records (surplus_no, date, reason, total_surplus_value, total_items_qty, items_summary, items_json, remark, reported_by, uniqueid) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(surplusNo, entryDate, reason, totalSurplusValue, totalItemsQty, itemsSummary, itemsJson, remark, session?.name || 'Cashier', surplusUniqueId)
    ];

    for (const sa of stockAdditions) {
      batchStatements.push(
        db.prepare(`
          UPDATE pos_items_master 
          SET current_stock = current_stock + ?, 
              surplus_stock = COALESCE(surplus_stock, 0) + ?, 
              updated_at = datetime('now') 
          WHERE barcode = ?
        `).bind(sa.qty, sa.qty, sa.barcode)
      );
    }

    await db.batch(batchStatements);
    return {
      success: true,
      surplusNo,
      totalSurplusValue,
      totalItemsQty,
      message: "Stock surplus recorded and inventory updated."
    };
  } catch (err) {
    return { success: false, message: "Failed to save surplus entry: " + err.message };
  }
}

export async function deletePosSurplusEntry(db, session, body) {
  try {
    await ensureCanteenSchema(db);
    const id = parseInt(body.id, 10);
    const surplusNo = String(body.surplusNo || "").trim();
    if (!id && !surplusNo) return { success: false, message: "Surplus ID or Number is required." };

    const existing = await db.prepare("SELECT id, surplus_no, date, items_json FROM pos_surplus_records WHERE id = ? OR surplus_no = ?").bind(id || 0, surplusNo || "").first();
    if (!existing) return { success: false, message: "Surplus record not found." };

    const policy = verifyRecordMutationPolicy(session, existing.date);
    if (!policy.allowed) return { success: false, message: policy.message };

    const batchStatements = [
      db.prepare("DELETE FROM pos_surplus_records WHERE id = ?").bind(existing.id)
    ];

    if (existing.items_json) {
      try {
        const items = JSON.parse(existing.items_json);
        for (const it of items) {
          const q = safeAmount(it.qty);
          if (it.barcode && q > 0) {
            batchStatements.push(
              db.prepare(`
                UPDATE pos_items_master 
                SET current_stock = MAX(0, current_stock - ?), 
                    surplus_stock = MAX(0, COALESCE(surplus_stock, 0) - ?), 
                    updated_at = datetime('now') 
                WHERE barcode = ?
              `).bind(q, q, it.barcode)
            );
          }
        }
      } catch (jsonErr) { }
    }

    await db.batch(batchStatements);
    return { success: true, message: `Surplus record (${existing.surplus_no}) deleted and stock rolled back.` };
  } catch (err) {
    return { success: false, message: "Failed to delete surplus record: " + err.message };
  }
}

// ==============================================================================
// ⚠️ 2. WASTAGE & LOSS LEDGER
// ==============================================================================
export async function getPosWasteHistory(db, body) {
  try {
    const page = Math.max(1, parseInt(body.page || 1, 10));
    const limit = Math.min(100, Math.max(1, parseInt(body.limit || 20, 10)));
    const offset = (page - 1) * limit;

    const reason = String(body.reason || "").trim();
    const dateFrom = String(body.dateFrom || "").trim();
    const dateTo = String(body.dateTo || "").trim();
    const searchVal = String(body.searchVal || "").trim();

    let whereClauses = [];
    let params = [];

    if (reason) { whereClauses.push(`reason = ?`); params.push(reason); }
    if (dateFrom) { whereClauses.push(`date >= ?`); params.push(dateFrom); }
    if (dateTo) { whereClauses.push(`date <= ?`); params.push(dateTo); }
    if (searchVal) {
      whereClauses.push(`(waste_no LIKE ? OR items_summary LIKE ? OR remark LIKE ? OR reported_by LIKE ?)`);
      const p = `%${searchVal}%`;
      params.push(p, p, p, p);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const [countRes, rowsRes] = await db.batch([
      db.prepare(`
        SELECT 
          COUNT(id) as totalRows, 
          COALESCE(SUM(total_loss_cost), 0) as totalLossAmount, 
          COALESCE(SUM(total_items_qty), 0) as totalLossQty 
        FROM pos_waste_records 
        ${whereSql}
      `).bind(...params),

      db.prepare(`
        SELECT 
          id, waste_no as wasteNo, date, reason, 
          total_loss_cost as totalLossCost, total_items_qty as totalItemsQty, 
          items_summary as itemsSummary, items_json as itemsJson, 
          remark, reported_by as reportedBy, uniqueid as uniqueId, created_at as createdAt 
        FROM pos_waste_records 
        ${whereSql} 
        ORDER BY id DESC LIMIT ? OFFSET ?
      `).bind(...params, limit, offset)
    ]);

    const stats = countRes.results[0] || {};
    return {
      success: true,
      data: rowsRes.results || [],
      totalRows: stats.totalRows || 0,
      totalLossAmount: parseFloat(stats.totalLossAmount || 0),
      totalLossQty: parseFloat(stats.totalLossQty || 0),
      page,
      limit
    };
  } catch (err) {
    return { success: false, message: "Failed to load wastage history: " + err.message };
  }
}

export async function savePosWasteEntry(db, session, body) {
  try {
    await ensureCanteenSchema(db);
    const entryDate = getMyanmarDateString(body.date);
    const reason = String(body.reason || 'Damaged').trim();
    const items = Array.isArray(body.items) ? body.items : [];
    const remark = String(body.remark || '').trim();

    if (items.length === 0) {
      return { success: false, message: "Please select at least 1 item for wastage entry." };
    }

    let totalLossCost = 0;
    let totalItemsQty = 0;
    const summaryParts = [];
    const stockDeductions = [];

    for (const it of items) {
      const bCode = String(it.barcode || '').trim();
      const name = String(it.name || it.itemName || 'Item').trim();
      const q = safeAmount(it.qty);
      const cost = safeAmount(it.costPrice || it.cost);

      if (!bCode || q <= 0) continue;

      totalItemsQty += q;
      totalLossCost += (q * cost);
      summaryParts.push(`${name} x ${q}`);
      stockDeductions.push({ barcode: bCode, qty: q, costPrice: cost, name });
    }

    totalLossCost = Math.round(totalLossCost * 100) / 100;
    if (totalItemsQty <= 0) {
      return { success: false, message: "Invalid item quantity." };
    }

    const itemsSummary = summaryParts.join(', ');
    const itemsJson = JSON.stringify(stockDeductions);
    const rawCore = body.uniqueId ? String(body.uniqueId).trim().replace(/^WST_/i, '') : generateUniqueId('').replace(/^_/, '');
    const wasteUniqueId = `WST_${rawCore}`;
    const wasteNo = `WST-${entryDate.replace(/-/g, '')}-${generateUniqueId('').slice(-3).toUpperCase()}`;

    const batchStatements = [
      db.prepare(`
        INSERT INTO pos_waste_records (waste_no, date, reason, total_loss_cost, total_items_qty, items_summary, items_json, remark, reported_by, uniqueid) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(wasteNo, entryDate, reason, totalLossCost, totalItemsQty, itemsSummary, itemsJson, remark, session?.name || 'Cashier', wasteUniqueId)
    ];

    for (const sd of stockDeductions) {
      batchStatements.push(
        db.prepare(`
          UPDATE pos_items_master 
          SET current_stock = current_stock - ?, 
              surplus_stock = MAX(0, COALESCE(surplus_stock, 0) - ?), 
              updated_at = datetime('now') 
          WHERE barcode = ?
        `).bind(sd.qty, sd.qty, sd.barcode)
      );
    }

    await db.batch(batchStatements);
    return {
      success: true,
      wasteNo,
      totalLossCost,
      totalItemsQty,
      message: "Wastage & loss entry recorded successfully."
    };
  } catch (err) {
    return { success: false, message: "Failed to save wastage entry: " + err.message };
  }
}

export async function deletePosWasteEntry(db, session, body) {
  try {
    await ensureCanteenSchema(db);
    const id = parseInt(body.id, 10);
    const wasteNo = String(body.wasteNo || "").trim();
    if (!id && !wasteNo) return { success: false, message: "Wastage ID or Number is required." };

    const existing = await db.prepare("SELECT id, waste_no, date, items_json FROM pos_waste_records WHERE id = ? OR waste_no = ?").bind(id || 0, wasteNo || "").first();
    if (!existing) return { success: false, message: "Wastage record not found." };

    const policy = verifyRecordMutationPolicy(session, existing.date);
    if (!policy.allowed) return { success: false, message: policy.message };

    const batchStatements = [
      db.prepare("DELETE FROM pos_waste_records WHERE id = ?").bind(existing.id)
    ];

    if (existing.items_json) {
      try {
        const items = JSON.parse(existing.items_json);
        for (const it of items) {
          const q = safeAmount(it.qty);
          if (it.barcode && q > 0) {
            batchStatements.push(
              db.prepare(`
                UPDATE pos_items_master 
                SET current_stock = current_stock + ?, 
                    updated_at = datetime('now') 
                WHERE barcode = ?
              `).bind(q, it.barcode)
            );
          }
        }
      } catch (jsonErr) { }
    }

    await db.batch(batchStatements);
    return { success: true, message: `Wastage record (${existing.waste_no}) deleted and stock restored.` };
  } catch (err) {
    return { success: false, message: "Failed to delete wastage record: " + err.message };
  }
}

// ==============================================================================
// 🛒 3. PURCHASES & VOUCHER LEDGER (17 COLUMNS + 4 ERP KPIS + MULTI-ITEM SAVE)
// ==============================================================================
export async function getPosPurchasesHistory(db, body) {
  try {
    await ensureCanteenSchema(db);
    const todayStr = getMyanmarDateString();
    const monthPrefix = todayStr.slice(0, 7);
    const monthStart = `${monthPrefix}-01`;
    const [y, m] = monthPrefix.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const monthEnd = `${monthPrefix}-${String(lastDay).padStart(2, '0')}`;

    const supplierId = parseInt(body.supplierId, 10) || 0;
    const searchVal = String(body.searchVal || "").trim();
    const dateFrom = String(body.dateFrom || "").trim();
    const dateTo = String(body.dateTo || "").trim();

    const page = Math.max(1, parseInt(body.page || 1, 10));
    const limit = Math.min(100, Math.max(1, parseInt(body.limit || 20, 10)));
    const offset = (page - 1) * limit;

    let whereClauses = [];
    let params = [];

    if (supplierId > 0) { whereClauses.push(`p.supplier_id = ?`); params.push(supplierId); }
    if (dateFrom) { whereClauses.push(`p.date >= ?`); params.push(dateFrom); }
    if (dateTo) { whereClauses.push(`p.date <= ?`); params.push(dateTo); }
    if (searchVal) {
      whereClauses.push(`(p.item_barcode LIKE ? OR COALESCE(NULLIF(p.item_name, ''), m.item_name) LIKE ? OR p.purchase_no LIKE ? OR p.voucher_no LIKE ? OR COALESCE(NULLIF(p.supplier_name, ''), s.supplier_name) LIKE ? OR p.shop_name LIKE ? OR p.ref LIKE ?)`);
      const q = `%${searchVal}%`;
      params.push(q, q, q, q, q, q, q);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const [countRes, rowsRes, kpiRes, stockBalRes] = await db.batch([
      db.prepare(`
        SELECT 
          COUNT(p.id) as totalRows, 
          COALESCE(SUM(p.total_cost), 0) as totalPurchasesAmount 
        FROM pos_purchases p 
        LEFT JOIN pos_items_master m ON p.item_barcode = m.barcode 
        LEFT JOIN pos_suppliers s ON p.supplier_id = s.id 
        ${whereSql}
      `).bind(...params),

      db.prepare(`
        SELECT 
          p.id,
          p.no,
          p.purchase_no as purchaseNo,
          COALESCE(NULLIF(p.voucher_no, ''), p.purchase_no) as voucherNo,
          p.date,
          p.item_barcode as barcode,
          COALESCE(NULLIF(p.category, ''), m.category, 'Snack') as category,
          COALESCE(NULLIF(p.item_name, ''), m.item_name, 'Unknown Item') as itemName,
          COALESCE(NULLIF(p.method, ''), 'Cash') as method,
          p.qty,
          p.cost_price as costPrice,
          p.total_cost as totalCost,
          p.markup_percent as markupPercent,
          p.selling_price as sellingPrice,
          COALESCE(p.wholesale_markup, m.wholesale_markup, 5) as wholesaleMarkup,
          COALESCE(p.wholesale_price, m.wholesale_price, p.selling_price, 0) as wholesalePrice,
          p.supplier_id as supplierId,
          COALESCE(NULLIF(p.supplier_name, ''), s.contact_person, s.supplier_name, '-') as supplierName,
          COALESCE(NULLIF(p.shop_name, ''), s.shop_name, s.supplier_name, '-') as shopName,
          COALESCE(NULLIF(p.phone_no, ''), s.phone_no, '-') as supplierPhone,
          COALESCE(NULLIF(p.address, ''), s.address, '-') as supplierAddress,
          COALESCE(p.ref, '') as ref,
          COALESCE(p.remark, '') as remark,
          COALESCE(p.voucher_amount, p.total_cost) as voucherAmount,
          COALESCE(p.surplus_deficit, 0) as surplusDeficit,
          p.created_by as createdBy,
          p.created_at as createdAt
        FROM pos_purchases p 
        LEFT JOIN pos_items_master m ON p.item_barcode = m.barcode 
        LEFT JOIN pos_suppliers s ON p.supplier_id = s.id 
        ${whereSql} 
        ORDER BY p.id DESC 
        LIMIT ? OFFSET ?
      `).bind(...params, limit, offset),

      db.prepare(`
        SELECT 
          COALESCE(SUM(CASE WHEN date = ? THEN total_cost ELSE 0 END), 0) as todayPurchasesTotal,
          COALESCE(SUM(CASE WHEN date >= ? AND date <= ? THEN total_cost ELSE 0 END), 0) as thisMonthPurchasesTotal,
          COALESCE(SUM(total_cost), 0) as allTimePurchasesTotal,
          COUNT(CASE WHEN date = ? THEN 1 END) as todayPurchasesCount,
          COUNT(CASE WHEN date >= ? AND date <= ? THEN 1 END) as thisMonthPurchasesCount,
          COUNT(id) as allTimePurchasesCount
        FROM pos_purchases
      `).bind(todayStr, monthStart, monthEnd, todayStr, monthStart, monthEnd),

      db.prepare(`
        SELECT COALESCE(SUM(
          CASE 
            WHEN (current_stock - COALESCE(surplus_stock, 0)) > 0 
            THEN (cost_price * (current_stock - COALESCE(surplus_stock, 0))) 
            ELSE 0 
          END
        ), 0) as stocksBalanceTotal
        FROM pos_items_master
        WHERE is_active = 1
      `)
    ]);

    const totalRows = countRes.results[0]?.totalRows || 0;
    const totalPurchasesAmount = parseFloat(countRes.results[0]?.totalPurchasesAmount || 0);
    const kpiStats = kpiRes?.results?.[0] || {};
    const stocksBalanceTotal = parseFloat(stockBalRes?.results?.[0]?.stocksBalanceTotal || 0);

    return {
      success: true,
      data: rowsRes.results || [],
      totalRows,
      totalPurchasesAmount,
      todayPurchasesTotal: parseFloat(kpiStats.todayPurchasesTotal || 0),
      thisMonthPurchasesTotal: parseFloat(kpiStats.thisMonthPurchasesTotal || 0),
      allTimePurchasesTotal: parseFloat(kpiStats.allTimePurchasesTotal || 0),
      stocksBalanceTotal,
      todayPurchasesCount: Number(kpiStats.todayPurchasesCount || 0),
      thisMonthPurchasesCount: Number(kpiStats.thisMonthPurchasesCount || 0),
      allTimePurchasesCount: Number(kpiStats.allTimePurchasesCount || 0),
      page,
      limit
    };
  } catch (err) {
    return { success: false, message: "Failed to load purchases history: " + err.message };
  }
}

export async function savePosPurchase(db, session, body) {
  try {
    await ensureCanteenSchema(db);
    const entryDate = getMyanmarDateString(body.date);
    const d = new Date(entryDate);
    const my = `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]}-${d.getFullYear()}`;
    const fy = normalizeFyStr(body.fy || computeAcademicFy(entryDate));

    const method = (String(body.method || 'Cash').trim() === 'Bank') ? 'Bank' : 'Cash';
    const supplierId = body.supplierId ? parseInt(body.supplierId, 10) : null;
    const supplierName = String(body.supplierName || '').trim();
    const shopName = String(body.shopName || supplierName || '').trim();
    const phoneNo = String(body.phoneNo || '').trim();
    const address = String(body.address || '').trim();
    const ref = String(body.ref || '').trim();
    const remark = String(body.remark || '').trim();

    let rawItems = Array.isArray(body.items) && body.items.length > 0
      ? body.items
      : [{
          barcode: body.barcode || body.item_barcode,
          category: body.category || 'Snack',
          itemName: body.itemName || body.item_name,
          qty: body.qty,
          costPrice: body.costPrice || body.cost_price,
          markupPercent: body.markupPercent !== undefined ? body.markupPercent : 8,
          sellingPrice: body.sellingPrice || body.selling_price,
          wholesaleMarkup: body.wholesaleMarkup !== undefined ? body.wholesaleMarkup : 5,
          wholesalePrice: body.wholesalePrice || body.wholesale_price
        }];

    const validItems = [];
    let calculatedTotal = 0;
    const summaryParts = [];

    for (const it of rawItems) {
      const barcode = String(it.barcode || "").trim();
      const itemName = String(it.itemName || it.name || "New Item").trim();
      const category = String(it.category || "Snack").trim();
      const qty = safeAmount(it.qty);
      const costPrice = safeAmount(it.costPrice || it.cost);

      if (!barcode || qty <= 0 || costPrice <= 0) continue;

      const markupPercent = Math.max(0, Number(it.markupPercent !== undefined ? it.markupPercent : 8));
      let sellingPrice = safeAmount(it.sellingPrice || it.retailPrice);
      if (sellingPrice <= 0) sellingPrice = calculateSmartPrice(costPrice, markupPercent, 50);

      const wholesaleMarkup = Math.max(0, Number(it.wholesaleMarkup !== undefined ? it.wholesaleMarkup : 5));
      let wholesalePrice = safeAmount(it.wholesalePrice);
      if (wholesalePrice <= 0) wholesalePrice = calculateSmartPrice(costPrice, wholesaleMarkup, 50);

      const totalCost = Math.round(qty * costPrice * 100) / 100;
      calculatedTotal += totalCost;
      summaryParts.push(`${itemName} x ${qty}`);

      validItems.push({
        barcode, itemName, category, qty, costPrice, totalCost,
        markupPercent, sellingPrice, wholesaleMarkup, wholesalePrice
      });
    }

    if (validItems.length === 0) {
      return { success: false, message: "Please provide at least 1 valid item with Barcode, Qty > 0, and Buy Price > 0." };
    }

    calculatedTotal = Math.round(calculatedTotal * 100) / 100;
    const voucherAmount = (body.voucherAmount !== undefined && body.voucherAmount !== '')
      ? safeAmount(body.voucherAmount)
      : calculatedTotal;

    const surplusDeficit = (body.surplusDeficit !== undefined && body.surplusDeficit !== '')
      ? safeSignedAmount(body.surplusDeficit)
      : Math.round((calculatedTotal - voucherAmount) * 100) / 100;

    const rawCore = body.uniqueId ? String(body.uniqueId).trim().replace(/^(PO_|PUR_|PCB_)+/i, '') : generateUniqueId('').replace(/^_/, '');
    const voucherNo = body.voucherNo || await generateVoucherNo(db, 'pos_purchases', 'PUR', entryDate);

    // Idempotency Guard
    const existingVoucher = await db.prepare("SELECT id, voucher_no FROM pos_purchases WHERE voucher_no = ? LIMIT 1").bind(voucherNo).first();
    if (existingVoucher && !body.isUpdate) {
      return {
        success: true,
        voucherNo: existingVoucher.voucher_no,
        message: "Purchase voucher already recorded (Duplicate prevented)."
      };
    }

    const batchStatements = [];

    if (shopName || supplierName) {
      const supKey = shopName || supplierName;
      batchStatements.push(
        db.prepare(`
          INSERT INTO pos_suppliers (supplier_name, contact_person, shop_name, phone_no, address)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(supplier_name) DO UPDATE SET
            contact_person = COALESCE(NULLIF(excluded.contact_person, ''), pos_suppliers.contact_person),
            shop_name = COALESCE(NULLIF(excluded.shop_name, ''), pos_suppliers.shop_name),
            phone_no = COALESCE(NULLIF(excluded.phone_no, ''), pos_suppliers.phone_no),
            address = COALESCE(NULLIF(excluded.address, ''), pos_suppliers.address)
        `).bind(supKey, supplierName || supKey, shopName || supKey, phoneNo, address)
      );
    }

    const lastPurRow = await db.prepare("SELECT MAX(CAST(no AS INTEGER)) as maxNo, COUNT(id) as cnt FROM pos_purchases").first();
    let nextPurNo = Math.max(parseInt(lastPurRow?.maxNo || 0, 10), parseInt(lastPurRow?.cnt || 0, 10));

    for (let i = 0; i < validItems.length; i++) {
      const it = validItems[i];
      nextPurNo += 1;
      const linePurchaseNo = `${voucherNo}-${String(i + 1).padStart(2, '0')}`;
      const lineUid = `PUR_${rawCore}_${i + 1}`;

      // 1. Upsert Master Item & Increment Stock
      batchStatements.push(
        db.prepare(`
          INSERT INTO pos_items_master (
            barcode, item_name, category, cost_price, markup_percent, selling_price,
            wholesale_markup, wholesale_price, current_stock, is_active, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
          ON CONFLICT(barcode) DO UPDATE SET
            item_name = COALESCE(NULLIF(excluded.item_name, ''), pos_items_master.item_name),
            category = COALESCE(NULLIF(excluded.category, ''), pos_items_master.category),
            cost_price = excluded.cost_price,
            markup_percent = excluded.markup_percent,
            selling_price = excluded.selling_price,
            wholesale_markup = excluded.wholesale_markup,
            wholesale_price = excluded.wholesale_price,
            current_stock = pos_items_master.current_stock + excluded.current_stock,
            is_active = 1,
            updated_at = datetime('now')
        `).bind(
          it.barcode, it.itemName, it.category, it.costPrice,
          it.markupPercent, it.sellingPrice, it.wholesaleMarkup, it.wholesalePrice, it.qty
        )
      );

      // 2. Insert Purchase Line Record
      batchStatements.push(
        db.prepare(`
          INSERT INTO pos_purchases (
            no, purchase_no, voucher_no, vr_no, date, item_barcode, category, item_name, method,
            qty, cost_price, total_cost, markup_percent, selling_price, wholesale_markup, wholesale_price,
            supplier_id, supplier_name, shop_name, phone_no, address, ref, ref_no, remark,
            voucher_amount, surplus_deficit, created_by, uniqueid
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          nextPurNo, linePurchaseNo, voucherNo, voucherNo, entryDate, it.barcode, it.category, it.itemName, method,
          it.qty, it.costPrice, it.totalCost, it.markupPercent, it.sellingPrice, it.wholesaleMarkup, it.wholesalePrice,
          supplierId, supplierName, shopName, phoneNo, address, ref, ref, remark,
          voucherAmount, surplusDeficit, session?.name || 'Admin', lineUid
        )
      );
    }

    // 3. Auto-post to POS Cash Book
    const noPcb = await generateFyNo(db, 'pos_cash_book', fy);
    const pcbUid = `PCB_PUR_${rawCore}`;
    const pcbDesc = `[${voucherNo}] ${shopName || supplierName || 'Purchase'}: ${summaryParts.join(', ')}`.slice(0, 500);

    batchStatements.push(
      db.prepare(`
        INSERT INTO pos_cash_book (
          no, date, category, description, method, debit, credit, balances,
          ref, surplus_deficit, vr_no, my, fy, created_by, uniqueid
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        noPcb, entryDate, 'Purchase', pcbDesc, method, 0, voucherAmount, 0,
        ref || voucherNo, surplusDeficit, voucherNo, my, fy,
        session?.name || 'Admin', pcbUid
      )
    );

    await db.batch(batchStatements);
    await recalculateLedgerBalances(db, 'pos_cash_book', fy, entryDate);

    return {
      success: true,
      voucherNo,
      calculatedTotal,
      voucherAmount,
      surplusDeficit,
      itemsCount: validItems.length,
      message: `Purchase Voucher (${voucherNo}) saved and posted to POS Cash Book.`
    };
  } catch (err) {
    return { success: false, message: "Failed to save purchase voucher: " + err.message };
  }
}

export async function updatePosPurchase(db, session, body) {
  try {
    await ensureCanteenSchema(db);
    const id = parseInt(body.id, 10);
    const purchaseNo = String(body.purchaseNo || "").trim();
    if (!id && !purchaseNo) return { success: false, message: "Purchase ID or Number is required." };

    const existing = await db.prepare("SELECT id, purchase_no, item_barcode, qty, date FROM pos_purchases WHERE id = ? OR purchase_no = ?").bind(id || 0, purchaseNo || "").first();
    if (!existing) return { success: false, message: "Purchase record not found." };

    const policy = verifyRecordMutationPolicy(session, existing.date);
    if (!policy.allowed) return { success: false, message: policy.message };

    const entryDate = getMyanmarDateString(body.date);
    const supplierId = body.supplierId ? parseInt(body.supplierId, 10) : null;
    const newQty = safeAmount(body.qty);
    const newCostPrice = safeAmount(body.costPrice || body.cost_price);
    const markupPercent = Math.max(0, Number(body.markupPercent !== undefined ? body.markupPercent : 8));
    let newSellingPrice = safeAmount(body.sellingPrice || body.selling_price);
    const wholesaleMarkup = Math.max(0, Number(body.wholesaleMarkup !== undefined ? body.wholesaleMarkup : 5));
    let newWholesalePrice = safeAmount(body.wholesalePrice || body.wholesale_price);

    if (newQty <= 0 || newCostPrice <= 0) {
      return { success: false, message: "Qty and Cost Price must be greater than 0." };
    }

    if (newSellingPrice <= 0) newSellingPrice = calculateSmartPrice(newCostPrice, markupPercent, 50);
    if (newWholesalePrice <= 0) newWholesalePrice = calculateSmartPrice(newCostPrice, wholesaleMarkup, 50);

    const totalCost = Math.round(newQty * newCostPrice * 100) / 100;
    const deltaQty = newQty - Number(existing.qty || 0);

    await db.batch([
      db.prepare(`
        UPDATE pos_purchases 
        SET date = ?, supplier_id = ?, qty = ?, cost_price = ?, markup_percent = ?, 
            selling_price = ?, wholesale_markup = ?, wholesale_price = ?, total_cost = ?, remark = ? 
        WHERE id = ?
      `).bind(entryDate, supplierId, newQty, newCostPrice, markupPercent, newSellingPrice, wholesaleMarkup, newWholesalePrice, totalCost, body.remark || '', existing.id),

      db.prepare(`
        UPDATE pos_items_master 
        SET current_stock = current_stock + ?, 
            cost_price = ?, 
            markup_percent = ?, 
            selling_price = ?, 
            wholesale_markup = ?,
            wholesale_price = ?,
            updated_at = datetime('now') 
        WHERE barcode = ?
      `).bind(deltaQty, newCostPrice, markupPercent, newSellingPrice, wholesaleMarkup, newWholesalePrice, existing.item_barcode)
    ]);

    return { success: true, message: "Purchase entry and inventory updated successfully." };
  } catch (err) {
    return { success: false, message: "Failed to update purchase entry: " + err.message };
  }
}

export async function deletePosPurchase(db, session, body) {
  try {
    await ensureCanteenSchema(db);
    const id = parseInt(body.id, 10);
    const purchaseNo = String(body.purchaseNo || "").trim();
    if (!id && !purchaseNo) return { success: false, message: "Purchase ID or Number is required." };

    const existing = await db.prepare("SELECT id, purchase_no, voucher_no, item_barcode, qty, date FROM pos_purchases WHERE id = ? OR purchase_no = ?").bind(id || 0, purchaseNo || "").first();
    if (!existing) return { success: false, message: "Purchase record not found." };

    const policy = verifyRecordMutationPolicy(session, existing.date);
    if (!policy.allowed) return { success: false, message: policy.message };

    const rollbackQty = safeAmount(existing.qty);
    const batchStatements = [
      db.prepare("DELETE FROM pos_purchases WHERE id = ?").bind(existing.id),
      db.prepare(`
        UPDATE pos_items_master 
        SET current_stock = MAX(0, current_stock - ?), 
            updated_at = datetime('now') 
        WHERE barcode = ?
      `).bind(rollbackQty, existing.item_barcode)
    ];

    await db.batch(batchStatements);

    if (existing.voucher_no) {
      const rem = await db.prepare("SELECT COUNT(id) as cnt FROM pos_purchases WHERE voucher_no = ?").bind(existing.voucher_no).first();
      if (!rem || Number(rem.cnt) === 0) {
        await db.prepare("DELETE FROM pos_cash_book WHERE vr_no = ?").bind(existing.voucher_no).run();
        const fy = normalizeFyStr(computeAcademicFy(existing.date));
        await recalculateLedgerBalances(db, 'pos_cash_book', fy, existing.date);
      }
    }

    return { success: true, message: `Purchase entry (${existing.purchase_no}) deleted and stock rolled back.` };
  } catch (err) {
    return { success: false, message: "Failed to delete purchase entry: " + err.message };
  }
}

// ==============================================================================
// 💡 4. REAL-TIME STOCK INVENTORY AUDITOR & ITEMS CATALOG
// ==============================================================================
export async function getPosStockInventory(db, body) {
  try {
    await ensureCanteenSchema(db);
    const category = String(body.category || "").trim();
    const stockStatus = String(body.stockStatus || "all").trim();
    const searchVal = String(body.searchVal || "").trim();

    const page = Math.max(1, parseInt(body.page || 1, 10));
    const limit = Math.min(100, Math.max(1, parseInt(body.limit || 20, 10)));
    const offset = (page - 1) * limit;

    let whereClauses = [];
    let params = [];

    if (category) { whereClauses.push(`category = ?`); params.push(category); }
    if (stockStatus === 'low_stock') { whereClauses.push(`current_stock > 0 AND current_stock <= 10`); }
    else if (stockStatus === 'out_of_stock') { whereClauses.push(`current_stock <= 0`); }

    if (searchVal) {
      whereClauses.push(`(item_name LIKE ? OR barcode LIKE ?)`);
      const p = `%${searchVal}%`;
      params.push(p, p);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const [summaryRes, rowsRes] = await db.batch([
      db.prepare(`
        SELECT 
          COUNT(id) as totalRows, 
          COALESCE(SUM(current_stock), 0) as totalStockQty,
          COALESCE(SUM(cost_price * CASE WHEN (current_stock - COALESCE(surplus_stock, 0)) > 0 THEN (current_stock - COALESCE(surplus_stock, 0)) ELSE 0 END), 0) as totalStockValue,
          COALESCE(SUM(CASE WHEN current_stock <= 0 THEN 1 ELSE 0 END), 0) as outOfStockCount,
          COALESCE(SUM(CASE WHEN current_stock > 0 AND current_stock <= 10 THEN 1 ELSE 0 END), 0) as lowStockCount
        FROM pos_items_master 
        ${whereSql}
      `).bind(...params),

      db.prepare(`
        SELECT 
          id, barcode, item_name as itemName, category, 
          cost_price as costPrice, markup_percent as markupPercent, 
          selling_price as sellingPrice,
          COALESCE(wholesale_markup, 5) as wholesaleMarkup,
          COALESCE(wholesale_price, selling_price, 0) as wholesalePrice,
          current_stock as currentStock, 
          COALESCE(surplus_stock, 0) as surplusStock,
          is_active as isActive, updated_at as updatedAt,
          (cost_price * CASE WHEN (current_stock - COALESCE(surplus_stock, 0)) > 0 THEN (current_stock - COALESCE(surplus_stock, 0)) ELSE 0 END) as stockValue
        FROM pos_items_master 
        ${whereSql}
        ORDER BY id DESC LIMIT ? OFFSET ?
      `).bind(...params, limit, offset)
    ]);

    const summaryData = summaryRes.results[0] || {};
    return {
      success: true,
      data: rowsRes.results || [],
      totalRows: summaryData.totalRows || 0,
      page,
      limit,
      summary: {
        totalItems: summaryData.totalRows || 0,
        totalStockQty: Number(summaryData.totalStockQty || 0),
        totalStockValue: parseFloat(summaryData.totalStockValue || 0),
        outOfStockCount: Number(summaryData.outOfStockCount || 0),
        lowStockCount: Number(summaryData.lowStockCount || 0)
      }
    };
  } catch (err) {
    return { success: false, message: "Failed to load stock inventory: " + err.message };
  }
}

export async function updatePosItemQuick(db, session, body) {
  try {
    const barcode = String(body.barcode || "").trim();
    if (!barcode) return { success: false, message: "Barcode is required." };

    const updates = [];
    const params = [];

    if (body.sellingPrice !== undefined) {
      updates.push(`selling_price = ?`);
      params.push(safeAmount(body.sellingPrice));
    }
    if (body.wholesalePrice !== undefined) {
      updates.push(`wholesale_price = ?`);
      params.push(safeAmount(body.wholesalePrice));
    }
    if (body.costPrice !== undefined) {
      updates.push(`cost_price = ?`);
      params.push(safeAmount(body.costPrice));
    }
    if (body.currentStock !== undefined) {
      const newStock = Math.max(0, Number(body.currentStock) || 0);
      updates.push(`current_stock = ?`);
      params.push(newStock);
      updates.push(`surplus_stock = MIN(COALESCE(surplus_stock, 0), ?)`);
      params.push(newStock);
    }
    if (body.isActive !== undefined) {
      updates.push(`is_active = ?`);
      params.push(body.isActive ? 1 : 0);
    }

    if (updates.length === 0) return { success: false, message: "No fields to update." };

    updates.push(`updated_at = datetime('now')`);
    params.push(barcode);

    await db.prepare(`UPDATE pos_items_master SET ${updates.join(', ')} WHERE barcode = ?`).bind(...params).run();
    return { success: true, message: "Item updated successfully." };
  } catch (err) {
    return { success: false, message: "Failed to update item: " + err.message };
  }
}

export async function getPosItems(db, body) {
  try {
    await ensureCanteenSchema(db);
    const searchVal = String(body.searchVal || "").trim();
    const barcode = String(body.barcode || "").trim();
    const category = String(body.category || "").trim();
    const onlyActive = body.onlyActive !== false;

    let whereClauses = [];
    let params = [];

    if (barcode) { whereClauses.push(`barcode = ?`); params.push(barcode); }
    if (category) { whereClauses.push(`category = ?`); params.push(category); }
    if (onlyActive) { whereClauses.push(`is_active = 1`); }
    if (searchVal) {
      whereClauses.push(`(item_name LIKE ? OR barcode LIKE ?)`);
      const p = `%${searchVal}%`;
      params.push(p, p);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const res = await db.prepare(`
      SELECT 
        id, barcode, item_name as itemName, category, 
        cost_price as costPrice, markup_percent as markupPercent, 
        selling_price as sellingPrice,
        COALESCE(wholesale_markup, 5) as wholesaleMarkup,
        COALESCE(wholesale_price, selling_price, 0) as wholesalePrice,
        current_stock as currentStock, 
        COALESCE(surplus_stock, 0) as surplusStock, is_active as isActive, updated_at as updatedAt
      FROM pos_items_master 
      ${whereSql}
      ORDER BY item_name ASC 
      LIMIT 500
    `).bind(...params).all();

    return { success: true, data: res.results || [] };
  } catch (err) {
    return { success: false, message: "Failed to load POS items: " + err.message };
  }
}

export async function savePosItem(db, session, body) {
  try {
    await ensureCanteenSchema(db);
    const barcode = String(body.barcode || "").trim();
    const itemName = String(body.itemName || body.item_name || "").trim();
    if (!barcode || !itemName) return { success: false, message: "Barcode and Item Name are required." };

    const category = String(body.category || 'Snack').trim();
    const costPrice = safeAmount(body.costPrice || body.cost_price);
    const markupPercent = Math.max(0, Number(body.markupPercent !== undefined ? body.markupPercent : 8));
    let sellingPrice = safeAmount(body.sellingPrice || body.selling_price);
    if (sellingPrice <= 0 && costPrice > 0) sellingPrice = calculateSmartPrice(costPrice, markupPercent, 50);

    const wholesaleMarkup = Math.max(0, Number(body.wholesaleMarkup !== undefined ? body.wholesaleMarkup : 5));
    let wholesalePrice = safeAmount(body.wholesalePrice || body.wholesale_price);
    if (wholesalePrice <= 0 && costPrice > 0) wholesalePrice = calculateSmartPrice(costPrice, wholesaleMarkup, 50);

    const currentStock = Number(body.currentStock || body.current_stock) || 0;
    const isActive = body.isActive === 0 ? 0 : 1;

    await db.prepare(`
      INSERT INTO pos_items_master (
        barcode, item_name, category, cost_price, markup_percent, selling_price,
        wholesale_markup, wholesale_price, current_stock, is_active, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(barcode) DO UPDATE SET
        item_name = excluded.item_name, 
        category = excluded.category, 
        cost_price = excluded.cost_price,
        markup_percent = excluded.markup_percent, 
        selling_price = excluded.selling_price,
        wholesale_markup = excluded.wholesale_markup,
        wholesale_price = excluded.wholesale_price,
        current_stock = excluded.current_stock, 
        is_active = excluded.is_active, 
        updated_at = datetime('now')
    `).bind(
      barcode, itemName, category, costPrice,
      markupPercent, sellingPrice, wholesaleMarkup, wholesalePrice,
      currentStock, isActive
    ).run();

    return {
      success: true,
      data: {
        barcode, itemName, category, costPrice,
        markupPercent, sellingPrice, wholesaleMarkup, wholesalePrice,
        currentStock, isActive
      }
    };
  } catch (err) {
    return { success: false, message: "Failed to save item: " + err.message };
  }
}

// ==============================================================================
// 💡 5. SUPPLIERS MASTER
// ==============================================================================
export async function getPosSuppliers(db) {
  try {
    await ensureCanteenSchema(db);
    const res = await db.prepare(`
      SELECT 
        id, 
        supplier_name as supplierName, 
        COALESCE(NULLIF(shop_name, ''), supplier_name) as shopName,
        contact_person as contactPerson, 
        phone_no as phoneNo, 
        address, 
        is_active as isActive 
      FROM pos_suppliers 
      WHERE is_active = 1 
      ORDER BY supplier_name ASC
    `).all();
    return { success: true, data: res.results || [] };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

export async function savePosSupplier(db, session, body) {
  try {
    await ensureCanteenSchema(db);
    const name = String(body.supplierName || body.shopName || "").trim();
    if (!name) return { success: false, message: "Supplier or Shop Name is required." };

    const shopName = String(body.shopName || name).trim();
    const contactPerson = String(body.contactPerson || body.supplierName || "").trim();
    const phoneNo = String(body.phoneNo || "").trim();
    const address = String(body.address || "").trim();

    await db.prepare(`
      INSERT INTO pos_suppliers (supplier_name, shop_name, contact_person, phone_no, address)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(supplier_name) DO UPDATE SET
        shop_name = excluded.shop_name,
        contact_person = excluded.contact_person, 
        phone_no = excluded.phone_no, 
        address = excluded.address
    `).bind(name, shopName, contactPerson, phoneNo, address).run();

    return { success: true, message: "Supplier saved successfully." };
  } catch (err) {
    return { success: false, message: err.message };
  }
}