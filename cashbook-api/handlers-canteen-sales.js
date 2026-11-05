/**
 * ==============================================================================
 * GOLDEN ERP SYSTEM - POS CHECKOUT, STUDENT RADAR, OFFLINE SYNC & SALES HISTORY
 * File: handlers-canteen-sales.js (Location: cashbook-api/handlers-canteen-sales.js)
 * ==============================================================================
 */

import {
  normalizeFyStr,
  generateUniqueId,
  generateVoucherNo,
  generateFyNo,
  recalculateLedgerBalances
} from './utils.js';

import {
  getMyanmarDateString,
  computeAcademicFy,
  safeAmount,
  ensureCanteenSchema,
  recalculateCanteenBookBalances
} from './handlers-canteen-core.js';

// ==============================================================================
// 🧾 1. SALES ORDERS HISTORY AUDITOR
// ==============================================================================
export async function getPosSalesOrdersHistory(db, body) {
  try {
    const page = Math.max(1, parseInt(body.page || 1, 10));
    const limit = Math.min(100, Math.max(1, parseInt(body.limit || 20, 10)));
    const offset = (page - 1) * limit;

    const searchVal = String(body.searchVal || "").trim();
    const dateFrom = String(body.dateFrom || "").trim();
    const dateTo = String(body.dateTo || "").trim();
    const paymentMethod = String(body.paymentMethod || "").trim();

    let whereClauses = [];
    let params = [];

    if (dateFrom) { whereClauses.push(`date >= ?`); params.push(dateFrom); }
    if (dateTo) { whereClauses.push(`date <= ?`); params.push(dateTo); }
    if (paymentMethod) { whereClauses.push(`payment_method = ?`); params.push(paymentMethod); }
    if (searchVal) {
      whereClauses.push(`(invoice_no LIKE ? OR items_summary LIKE ? OR CAST(student_id AS TEXT) LIKE ? OR created_by LIKE ?)`);
      const p = `%${searchVal}%`;
      params.push(p, p, p, p);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const [countRes, rowsRes] = await db.batch([
      db.prepare(`
        SELECT 
          COUNT(id) as totalRows, 
          COALESCE(SUM(total_amount), 0) as totalSalesAmount, 
          COALESCE(SUM(net_profit), 0) as totalProfitAmount 
        FROM pos_sales_orders 
        ${whereSql}
      `).bind(...params),

      db.prepare(`
        SELECT 
          id, invoice_no as invoiceNo, date, payment_method as paymentMethod, 
          student_id as studentId, total_amount as totalAmount, total_cost as totalCost, 
          net_profit as netProfit, items_summary as itemsSummary, 
          canteen_vr_no as canteenVrNo, uniqueid as uniqueId, 
          created_by as createdBy, created_at as createdAt 
        FROM pos_sales_orders 
        ${whereSql} 
        ORDER BY id DESC LIMIT ? OFFSET ?
      `).bind(...params, limit, offset)
    ]);

    const stats = countRes.results[0] || {};
    return {
      success: true,
      data: rowsRes.results || [],
      totalRows: stats.totalRows || 0,
      totalSalesAmount: parseFloat(stats.totalSalesAmount || 0),
      totalProfitAmount: parseFloat(stats.totalProfitAmount || 0),
      page,
      limit
    };
  } catch (err) {
    return { success: false, message: "Failed to load sales orders history: " + err.message };
  }
}

// ==============================================================================
// 💡 2. STUDENT POCKET MONEY RADAR & OFFLINE SNAPSHOT
// ==============================================================================
export async function lookupStudentForPos(db, body) {
  try {
    const rawInput = String(body.studentId || body.searchVal || "").trim();
    if (!rawInput) return { success: false, message: "Please enter Student ID or Barcode." };

    const todayStr = getMyanmarDateString();
    const fyVal = computeAcademicFy(todayStr);
    const cleanFy = fyVal.replace(/^FY\s*/i, '');
    const stuIdNum = parseInt(rawInput, 10) || 0;

    let student = null;
    try {
      student = await db.prepare(`
        SELECT student_id as studentId, id, name, class, fyid 
        FROM student 
        WHERE (student_id = ? OR id = ? OR fyid = ? OR nfc_tag_id = ?) 
        LIMIT 1
      `).bind(stuIdNum, stuIdNum, rawInput, rawInput).first();
    } catch (e) {
      student = await db.prepare(`
        SELECT student_id as studentId, id, name, class, fyid 
        FROM student 
        WHERE (student_id = ? OR id = ? OR fyid = ?) 
        LIMIT 1
      `).bind(stuIdNum, stuIdNum, rawInput).first();
    }

    if (!student) return { success: false, message: "Student not found." };

    const realStudentId = parseInt(student.studentId || student.id, 10);
    const realFyid = student.fyid || rawInput;

    const balStmt = (realStudentId > 0)
      ? db.prepare(`SELECT COALESCE(SUM(debit - credit), 0) as bal FROM student_money WHERE fy IN (?, ?) AND student_id = ?`).bind(cleanFy, `FY ${cleanFy}`, realStudentId)
      : db.prepare(`SELECT COALESCE(SUM(debit - credit), 0) as bal FROM student_money WHERE fy IN (?, ?) AND fyid = ?`).bind(cleanFy, `FY ${cleanFy}`, realFyid);

    const [balRow, spentRow, capRow] = await db.batch([
      balStmt,
      db.prepare(`
        SELECT COALESCE(SUM(total_amount), 0) as todaySpent 
        FROM pos_sales_orders 
        WHERE student_id = ? AND date = ? AND payment_method = 'Student Pocket Money'
      `).bind(realStudentId, todayStr),
      db.prepare(`SELECT setting_value as capVal FROM pos_settings WHERE setting_key = 'daily_spending_cap' LIMIT 1`)
    ]);

    const currentBalance = parseFloat(balRow.results[0]?.bal || 0);
    const todaySpent = parseFloat(spentRow.results[0]?.todaySpent || 0);
    const dynamicCap = parseFloat(capRow.results[0]?.capVal || 10000);
    const remainingQuota = Math.max(0, dynamicCap - todaySpent);

    return {
      success: true,
      data: {
        studentId: realStudentId,
        name: student.name,
        studentClass: student.class,
        fyid: realFyid,
        currentBalance,
        todaySpent,
        remainingQuota,
        dailyCap: dynamicCap
      }
    };
  } catch (err) {
    return { success: false, message: "Failed to lookup student: " + err.message };
  }
}

export async function getPosStudentsSnapshot(db) {
  try {
    const todayStr = getMyanmarDateString();
    const currentFy = computeAcademicFy(todayStr).replace(/^FY\s*/i, '');

    let query = `
      SELECT 
        s.student_id as studentId, s.id, s.name, s.class as studentClass, 
        s.fyid, s.nfc_tag_id as nfcTagId,
        COALESCE(b.bal, 0) as currentBalance, 
        COALESCE(o.todaySpent, 0) as todaySpent
      FROM student s
      LEFT JOIN (
        SELECT student_id, SUM(debit - credit) as bal 
        FROM student_money WHERE fy IN (?, ?) GROUP BY student_id
      ) b ON b.student_id = COALESCE(s.student_id, s.id)
      LEFT JOIN (
        SELECT student_id, SUM(total_amount) as todaySpent 
        FROM pos_sales_orders WHERE date = ? AND payment_method = 'Student Pocket Money' GROUP BY student_id
      ) o ON o.student_id = COALESCE(s.student_id, s.id)
      ORDER BY s.student_id ASC
    `;

    let res;
    try {
      res = await db.prepare(query).bind(currentFy, `FY ${currentFy}`, todayStr).all();
    } catch (colErr) {
      query = query.replace('s.nfc_tag_id as nfcTagId,', "'' as nfcTagId,");
      res = await db.prepare(query).bind(currentFy, `FY ${currentFy}`, todayStr).all();
    }

    return { success: true, data: res.results || [] };
  } catch (err) {
    return { success: false, message: "Failed to fetch students snapshot: " + err.message };
  }
}

// ==============================================================================
// ⚡ 3. ATOMIC SINGLE BATCH POS CHECKOUT & OFFLINE BATCH SYNC
// ==============================================================================
export async function checkoutPosSale(db, session, body) {
  try {
    await ensureCanteenSchema(db);
    const entryDate = getMyanmarDateString(body.date);
    const d = new Date(entryDate);
    const my = `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]}-${d.getFullYear()}`;
    const fy = normalizeFyStr(body.fy || computeAcademicFy(entryDate));
    const cleanFy = fy.replace(/^FY\s*/i, '');

    try {
      const closureCheck = await db.prepare("SELECT id FROM canteen_day_closures WHERE date = ?").bind(entryDate).first();
      if (closureCheck) {
        return { success: false, message: `Register is already closed for (${entryDate}). Cannot process new sales.` };
      }
    } catch (e) { }

    const paymentMethod = String(body.paymentMethod || 'Student Pocket Money').trim();
    const isWallet = (paymentMethod === 'Student Pocket Money');
    const studentId = parseInt(body.studentId, 10) || null;
    const stockDeductions = Array.isArray(body.stockDeductions) ? body.stockDeductions : [];

    let totalAmount = 0;
    let totalCost = 0;
    const verifiedSummaryParts = [];

    if (stockDeductions.length > 0) {
      const barcodes = stockDeductions.map(i => String(i.barcode || "").trim()).filter(Boolean);
      if (barcodes.length > 0) {
        const placeholders = barcodes.map(() => '?').join(',');
        const dbItemsRes = await db.prepare(
          `SELECT barcode, item_name, selling_price, cost_price, current_stock FROM pos_items_master WHERE barcode IN (${placeholders})`
        ).bind(...barcodes).all();
        const itemMap = new Map((dbItemsRes.results || []).map(r => [r.barcode, r]));

        for (const reqItem of stockDeductions) {
          const bCode = String(reqItem.barcode || "").trim();
          const q = safeAmount(reqItem.qty);
          if (!bCode || q <= 0) continue;

          const dbItem = itemMap.get(bCode);
          if (!dbItem) return { success: false, message: `Item Barcode (${bCode}) not found.` };
          if (Number(dbItem.current_stock || 0) < q) {
            return { success: false, message: `Insufficient stock for "${dbItem.item_name}" (Available: ${dbItem.current_stock})` };
          }
          totalAmount += q * safeAmount(dbItem.selling_price);
          totalCost += q * safeAmount(dbItem.cost_price);
          verifiedSummaryParts.push(`${dbItem.item_name} x ${q}`);
        }
      }
      totalAmount = Math.round(totalAmount * 100) / 100;
      totalCost = Math.round(totalCost * 100) / 100;
    } else {
      totalAmount = safeAmount(body.totalAmount);
      totalCost = safeAmount(body.totalCost);
    }

    const netProfit = Math.round((totalAmount - totalCost) * 100) / 100;
    const itemsSummary = verifiedSummaryParts.length > 0 ? verifiedSummaryParts.join(', ') : String(body.itemsSummary || "").trim();

    if (totalAmount <= 0 || !itemsSummary) {
      return { success: false, message: "Cart is empty or invalid amount." };
    }

    const rawCore = body.uniqueId ? String(body.uniqueId).trim().replace(/^(CAN_|STM_|POS_|OFF_|PCB_)+/i, '') : generateUniqueId('').replace(/^_/, '');
    const posUniqueId = `POS_${rawCore}`;
    const canUniqueId = `CAN_${rawCore}`;
    const stmUniqueId = `STM_${rawCore}`;
    const pcbUniqueId = `PCB_${rawCore}`;

    const duplicateCheck = await db.prepare("SELECT invoice_no FROM pos_sales_orders WHERE uniqueid = ?").bind(posUniqueId).first();
    if (duplicateCheck) {
      return {
        success: true,
        invoiceNo: duplicateCheck.invoice_no,
        uniqueId: posUniqueId,
        message: "Invoice already processed."
      };
    }

    if (isWallet) {
      if (!studentId || studentId <= 0) return { success: false, message: "Student ID is required for Wallet payment." };

      const [balRes, spentRes, capRes] = await db.batch([
        db.prepare(`SELECT COALESCE(SUM(debit - credit), 0) as bal FROM student_money WHERE fy IN (?, ?) AND student_id = ?`).bind(cleanFy, `FY ${cleanFy}`, studentId),
        db.prepare(`SELECT COALESCE(SUM(total_amount), 0) as todaySpent FROM pos_sales_orders WHERE student_id = ? AND date = ? AND payment_method = 'Student Pocket Money'`).bind(studentId, entryDate),
        db.prepare(`SELECT setting_value as capVal FROM pos_settings WHERE setting_key = 'daily_spending_cap' LIMIT 1`)
      ]);

      const curStuBal = parseFloat(balRes.results[0]?.bal || 0);
      const todaySpent = parseFloat(spentRes.results[0]?.todaySpent || 0);
      const dynamicCap = parseFloat(capRes.results[0]?.capVal || 10000);

      if (totalAmount > curStuBal) return { success: false, message: `Insufficient wallet balance! Available: ${curStuBal.toLocaleString()} MMK.` };
      if ((todaySpent + totalAmount) > dynamicCap) {
        const remaining = Math.max(0, dynamicCap - todaySpent);
        return { success: false, message: `Daily spending cap (${dynamicCap.toLocaleString()} MMK) exceeded! Remaining today: ${remaining.toLocaleString()} MMK.` };
      }
    }

    const invoiceNo = `INV-${entryDate.replace(/-/g, '')}-${generateUniqueId('').slice(-4).toUpperCase()}`;
    const vrCan = await generateVoucherNo(db, 'canteen_book', 'CAN', entryDate);
    const noCan = await generateFyNo(db, 'canteen_book', fy);
    const noPcb = await generateFyNo(db, 'pos_cash_book', fy);

    const batchStatements = [
      db.prepare(`
        INSERT INTO pos_sales_orders (invoice_no, date, payment_method, student_id, total_amount, total_cost, net_profit, items_summary, canteen_vr_no, uniqueid, created_by) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(invoiceNo, entryDate, paymentMethod, studentId, totalAmount, totalCost, netProfit, itemsSummary, vrCan, posUniqueId, session?.name || 'Cashier'),

      db.prepare(`
        INSERT INTO canteen_book (no, date, category, description, method, debit, credit, balances, vr_no, my, fy, created_by, uniqueid) 
        VALUES (?, ?, 'POS Sales', ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)
      `).bind(noCan, entryDate, `[${invoiceNo}] ${itemsSummary}`, paymentMethod === 'Cash' ? 'Cash' : 'Transfer', totalAmount, vrCan, my, fy, session?.name || 'Cashier', canUniqueId),

      // Record in POS Cash Book as Debit
      db.prepare(`
        INSERT INTO pos_cash_book (no, date, category, description, method, debit, credit, balances, ref, surplus_deficit, vr_no, my, fy, created_by, uniqueid)
        VALUES (?, ?, 'POS Sales', ?, 'Cash', ?, 0, 0, ?, 0, ?, ?, ?, ?, ?)
      `).bind(noPcb, entryDate, `[${invoiceNo}] ${itemsSummary}`, totalAmount, invoiceNo, vrCan, my, fy, session?.name || 'Cashier', pcbUniqueId)
    ];

    if (isWallet && studentId > 0) {
      const noStu = await generateFyNo(db, 'student_money', cleanFy);
      const stuName = body.studentName ? `[${body.fyid || ''}] ${body.studentName}` : `[ID ${studentId}]`;
      const desc = `[Canteen POS - ${invoiceNo}]: ${itemsSummary}`.trim();
      batchStatements.push(
        db.prepare(`
          INSERT INTO student_money (no, date, fy, student_id, fyid, fyid_name, class, method, debit, credit, balances, remark, created_by, uniqueid) 
          VALUES (?, ?, ?, ?, ?, ?, ?, 'Canteen POS', 0, ?, 0, ?, ?, ?)
        `).bind(noStu, entryDate, cleanFy, studentId, body.fyid || '', stuName, body.studentClass || '', totalAmount, desc, session?.name || 'Cashier', stmUniqueId)
      );
    }

    for (const item of stockDeductions) {
      const bCode = String(item.barcode || "").trim();
      const q = safeAmount(item.qty);
      if (bCode && q > 0) {
        batchStatements.push(
          db.prepare(`
            UPDATE pos_items_master 
            SET current_stock = current_stock - ?,
                surplus_stock = MAX(0, COALESCE(surplus_stock, 0) - ?),
                updated_at = datetime('now')
            WHERE barcode = ? AND current_stock >= ?
          `).bind(q, q, bCode, q)
        );
      }
    }

    await db.batch(batchStatements);

    await recalculateCanteenBookBalances(db, fy, entryDate);
    await recalculateLedgerBalances(db, 'pos_cash_book', fy, entryDate);
    if (isWallet && studentId > 0) {
      await recalculateLedgerBalances(db, 'student_money', cleanFy, entryDate);
    }

    return { success: true, invoiceNo, canteenVrNo: vrCan, uniqueId: posUniqueId, totalAmount, netProfit };
  } catch (err) {
    return { success: false, message: "Checkout failed: " + err.message };
  }
}

export async function syncOfflinePosOrders(db, session, body) {
  try {
    await ensureCanteenSchema(db);
    const orders = Array.isArray(body.orders) ? body.orders : [];
    if (orders.length === 0) return { success: true, syncedCount: 0, skippedCount: 0, message: "No offline orders to sync." };

    let syncedCount = 0, skippedCount = 0;
    const failedOrders = [], affectedLedgers = new Set();

    for (const order of orders) {
      try {
        const entryDate = getMyanmarDateString(order.date);
        const d = new Date(entryDate);
        const my = `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]}-${d.getFullYear()}`;
        const fy = normalizeFyStr(order.fy || computeAcademicFy(entryDate));
        const cleanFy = fy.replace(/^FY\s*/i, '');

        const rawCore = order.uniqueId ? String(order.uniqueId).trim().replace(/^(CAN_|STM_|POS_|OFF_|PCB_)+/i, '') : generateUniqueId('').replace(/^_/, '');
        const posUniqueId = `POS_${rawCore}`;
        const canUniqueId = `CAN_${rawCore}`;
        const stmUniqueId = `STM_${rawCore}`;
        const pcbUniqueId = `PCB_${rawCore}`;

        const dup = await db.prepare("SELECT invoice_no FROM pos_sales_orders WHERE uniqueid = ?").bind(posUniqueId).first();
        if (dup) { skippedCount++; continue; }

        const paymentMethod = String(order.paymentMethod || 'Cash').trim();
        const isWallet = (paymentMethod === 'Student Pocket Money');
        const studentId = parseInt(order.studentId, 10) || null;
        const totalAmount = safeAmount(order.totalAmount);
        const totalCost = safeAmount(order.totalCost);
        const netProfit = Math.round((totalAmount - totalCost) * 100) / 100;
        const itemsSummary = String(order.itemsSummary || "").trim() || "Offline Sales";
        const stockDeductions = Array.isArray(order.stockDeductions) ? order.stockDeductions : [];

        const invoiceNo = order.invoiceNo || `INV-${entryDate.replace(/-/g, '')}-${generateUniqueId('').slice(-4).toUpperCase()}`;
        const vrCan = await generateVoucherNo(db, 'canteen_book', 'CAN', entryDate);
        const noCan = await generateFyNo(db, 'canteen_book', fy);
        const noPcb = await generateFyNo(db, 'pos_cash_book', fy);

        const batchStatements = [
          db.prepare(`
            INSERT INTO pos_sales_orders (invoice_no, date, payment_method, student_id, total_amount, total_cost, net_profit, items_summary, canteen_vr_no, uniqueid, created_by) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(invoiceNo, entryDate, paymentMethod, studentId, totalAmount, totalCost, netProfit, itemsSummary, vrCan, posUniqueId, session?.name || order.createdBy || 'Offline POS'),

          db.prepare(`
            INSERT INTO canteen_book (no, date, category, description, method, debit, credit, balances, vr_no, my, fy, created_by, uniqueid) 
            VALUES (?, ?, 'POS Sales', ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)
          `).bind(noCan, entryDate, `[${invoiceNo}] ${itemsSummary}`, paymentMethod === 'Cash' ? 'Cash' : 'Transfer', totalAmount, vrCan, my, fy, session?.name || 'Offline POS', canUniqueId),

          db.prepare(`
            INSERT INTO pos_cash_book (no, date, category, description, method, debit, credit, balances, ref, surplus_deficit, vr_no, my, fy, created_by, uniqueid)
            VALUES (?, ?, 'POS Sales', ?, 'Cash', ?, 0, 0, ?, 0, ?, ?, ?, ?, ?)
          `).bind(noPcb, entryDate, `[${invoiceNo}] ${itemsSummary}`, totalAmount, invoiceNo, vrCan, my, fy, session?.name || 'Offline POS', pcbUniqueId)
        ];

        if (isWallet && studentId > 0) {
          const noStu = await generateFyNo(db, 'student_money', cleanFy);
          const stuName = order.studentName ? `[${order.fyid || ''}] ${order.studentName}` : `[ID ${studentId}]`;
          const desc = `[Canteen POS - ${invoiceNo}]: ${itemsSummary}`.trim();
          batchStatements.push(
            db.prepare(`
              INSERT INTO student_money (no, date, fy, student_id, fyid, fyid_name, class, method, debit, credit, balances, remark, created_by, uniqueid) 
              VALUES (?, ?, ?, ?, ?, ?, ?, 'Canteen POS', 0, ?, 0, ?, ?, ?)
            `).bind(noStu, entryDate, cleanFy, studentId, order.fyid || '', stuName, order.studentClass || '', totalAmount, desc, session?.name || 'Offline POS', stmUniqueId)
          );
          affectedLedgers.add(`student_money:${cleanFy}:${entryDate}`);
        }

        for (const item of stockDeductions) {
          const bCode = String(item.barcode || "").trim();
          const q = safeAmount(item.qty);
          if (bCode && q > 0) {
            batchStatements.push(
              db.prepare(`
                UPDATE pos_items_master 
                SET current_stock = current_stock - ?, 
                    surplus_stock = MAX(0, COALESCE(surplus_stock, 0) - ?),
                    updated_at = datetime('now') 
                WHERE barcode = ?
              `).bind(q, q, bCode)
            );
          }
        }

        await db.batch(batchStatements);
        affectedLedgers.add(`canteen_book:${fy}:${entryDate}`);
        affectedLedgers.add(`pos_cash_book:${fy}:${entryDate}`);
        syncedCount++;
      } catch (itemErr) {
        failedOrders.push({ uniqueId: order.uniqueId, error: itemErr.message });
      }
    }

    for (const item of affectedLedgers) {
      const [book, academicFy, date] = item.split(':');
      if (book === 'canteen_book') {
        await recalculateCanteenBookBalances(db, academicFy, date);
      } else {
        await recalculateLedgerBalances(db, book, academicFy, date);
      }
    }

    return {
      success: true,
      syncedCount,
      skippedCount,
      failedCount: failedOrders.length,
      failedOrders,
      message: `Synced (${syncedCount}) offline orders to D1. (${skippedCount} duplicates skipped)`
    };
  } catch (err) {
    return { success: false, message: "Offline Sync failed: " + err.message };
  }
}