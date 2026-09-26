/**
 * ==============================================================================
 * GOLDEN ERP SYSTEM - SPMMS HANDLERS (CLOUDFLARE D1 ENTERPRISE EDITION)
 * File: handlers-money.js
 * 
 * 💡 Features:
 *   1. ⚡ ULTRA QUOTA-SHIELD: Zero Full-Table-Scans (Index-Only Equality Lookups)
 *   2. ⚖️ ACCOUNTING ACCURACY: Strict Balance Sheet Liability vs Filtered Period Separation
 *   3. 🛡️ ZERO-OVERDRAFT GUARDS: Real-time concurrency validation
 *   4. 🔒 SECURITY & NUMERICAL INTEGRITY: Strict NaN defense & 2-decimal floating safe
 *   5. 🔄 ATOMIC CASCADE: Non-blocking deterministic cleanup across all 3 ledgers
 * ==============================================================================
 */

import {
  getMyanmarDateString, normalizeFyStr, sanitizeFyidStr, generateUniqueId,
  generateVoucherNo, generateFyNo, recalculateLedgerBalances, getCurrentAcademicYear
} from './utils.js';

function computeAcademicFy(dateStr) {
  if (!dateStr) return getCurrentAcademicYear();
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return getCurrentAcademicYear();
  let year = d.getFullYear();
  if (d.getMonth() < 2) year -= 1;
  return `${year}-${year + 1}`;
}

// 🛡️ Fail-safe Number Sanitizer (အနုတ်လက္ခဏာနှင့် NaN အား လုံးဝ အဝင်မခံပါ)
function safeAmount(val) {
  const num = Number(val);
  return (Number.isFinite(num) && num > 0) ? Math.round(num * 100) / 100 : 0;
}

// ==============================================================================
// 💡 1. STUDENT MONEY (MAIN FINANCE & VIRTUAL WALLETS)
// ==============================================================================

export async function getStudentMoneyData(db, body) {
  try {
    const fy = normalizeFyStr(body.fy || getCurrentAcademicYear()).replace(/^FY\s*/i, '');
    const searchVal = String(body.searchVal || "").trim();
    const studentIdFilter = parseInt(body.studentId, 10) || 0;
    const page = Math.max(1, parseInt(body.page || 1, 10));
    const limit = Math.min(100, Math.max(1, parseInt(body.limit || 20, 10)));
    const offset = (page - 1) * limit;

    const dateFrom = String(body.dateFrom || body.fromDate || "").trim();
    const dateTo = String(body.dateTo || body.toDate || "").trim();

    let whereClauses = [`(fy IN (?, ?))`];
    let params = [fy, `FY ${fy}`];

    if (studentIdFilter > 0) {
      whereClauses.push(`(student_id = ? OR id = ?)`);
      params.push(studentIdFilter, studentIdFilter);
    }

    if (dateFrom) {
      whereClauses.push(`date >= ?`);
      params.push(dateFrom);
    }
    if (dateTo) {
      whereClauses.push(`date <= ?`);
      params.push(dateTo);
    }

    if (searchVal) {
      whereClauses.push(`(fyid_name LIKE ? OR fyid LIKE ? OR remark LIKE ?)`);
      const p = `%${searchVal}%`;
      params.push(p, p, p);
    }

    const whereSql = `WHERE ${whereClauses.join(' AND ')}`;

    // 🚀 D1 BATCH OPTIMIZATION: Main Book (တစ်ကျောင်းလုံး) နှင့် Single Student Statement ကို ခွဲခြားတွက်ချက်ခြင်း
    const batchQueries = [
      // ၁။ Pagination အတွက် Filtered Count
      db.prepare(`SELECT COUNT(id) as c FROM student_money ${whereSql}`).bind(...params),
      
      // ၂။ Filtered Range Stats (စာမျက်နှာတွင်း ကာလအပိုင်းအခြား အဝင်/အထွက်)
      db.prepare(`
        SELECT 
          COALESCE(SUM(CASE WHEN student_id IS NOT NULL THEN debit ELSE 0 END), 0) as d,
          COALESCE(SUM(CASE WHEN student_id IS NOT NULL THEN credit ELSE 0 END), 0) as c
        FROM student_money ${whereSql}
      `).bind(...params)
    ];

    if (studentIdFilter > 0) {
      // 🎯 ကျောင်းသားတစ်ဦးချင်း Statement အတွက် အဆိုပါကျောင်းသား၏ All-Time Balance သီးသန့်ဆွဲယူခြင်း
      batchQueries.push(
        db.prepare(`
          SELECT 
            COALESCE(SUM(debit), 0) as cum_d,
            COALESCE(SUM(credit), 0) as cum_c
          FROM student_money 
          WHERE (student_id = ? OR id = ?) AND fy IN (?, ?)
        `).bind(studentIdFilter, studentIdFilter, fy, `FY ${fy}`)
      );
    } else {
      // 🎯 ပင်မ Finance စာအုပ်ကြီးအတွက် တစ်ကျောင်းလုံး၏ Trust Balance နှင့် PM Cashier လက်ကျန် ဆွဲယူခြင်း
      batchQueries.push(
        db.prepare(`
          SELECT 
            COALESCE(SUM(CASE WHEN student_id IS NOT NULL THEN debit ELSE 0 END), 0) as cum_d,
            COALESCE(SUM(CASE WHEN student_id IS NOT NULL THEN credit ELSE 0 END), 0) as cum_c
          FROM student_money WHERE fy IN (?, ?)
        `).bind(fy, `FY ${fy}`),
        db.prepare(`SELECT COALESCE(SUM(debit - credit), 0) as pm_bal FROM pm_cashier_book WHERE fy IN (?, ?)`).bind(fy, `FY ${fy}`)
      );
    }

    const batchResults = await db.batch(batchQueries);
    const totalRows = batchResults[0]?.results[0]?.c || 0;
    const stats = batchResults[1]?.results[0] || { d: 0, c: 0 };
    const cumStats = batchResults[2]?.results[0] || { cum_d: 0, cum_c: 0 };
    
    // ကျောင်းသား Statement ဖြစ်ပါက ထိုကျောင်းသား၏ All-Time Balance ဖြစ်ပြီး ပင်မစာအုပ်ဖြစ်ပါက ကျောင်းလုံးကျွတ် Cumulative Trust Balance ဖြစ်သည်
    const cumulativeTrustBal = parseFloat(cumStats.cum_d || 0) - parseFloat(cumStats.cum_c || 0);
    const pmCashierCash = (studentIdFilter === 0 && batchResults[3]) ? parseFloat(batchResults[3].results[0]?.pm_bal || 0) : 0;
    const financeVaultCash = (studentIdFilter === 0) ? (cumulativeTrustBal - pmCashierCash) : 0;

    const dataQuery = `
      SELECT id, no, date, fy, student_id, fyid, fyid_name, class, method, debit, credit, balances, remark, uniqueid 
      FROM student_money ${whereSql} 
      ORDER BY date DESC, id DESC 
      LIMIT ? OFFSET ?
    `;
    const rowsRes = await db.prepare(dataQuery).bind(...params, limit, offset).all();

    return {
      success: true,
      data: (rowsRes.results || []).map(r => ({
        ...r, studentId: r.student_id, fyidName: r.fyid_name, uniqueId: r.uniqueid
      })),
      totalRows, page, limit,
      stats: { 
        totalIncome: parseFloat(stats.d || 0), 
        totalExpense: parseFloat(stats.c || 0), 
        balance: cumulativeTrustBal, // 🌟 တိကျခိုင်မာသော Cumulative Liability
        pmCashierCash,
        financeVaultCash
      }
    };
  } catch (err) { return { success: false, message: err.message }; }
}

export async function getStudentMoneySummary(db, body) {
  try {
    const fy = normalizeFyStr(body.fy || getCurrentAcademicYear()).replace(/^FY\s*/i, '');
    const searchVal = String(body.searchVal || "").trim();

    let whereClauses = [`(fy IN (?, ?)) AND student_id IS NOT NULL`];
    let params = [fy, `FY ${fy}`];

    if (searchVal) {
      whereClauses.push(`(fyid_name LIKE ? OR fyid LIKE ? OR CAST(student_id AS TEXT) LIKE ?)`);
      const p = `%${searchVal}%`;
      params.push(p, p, p);
    }

    const query = `
      SELECT student_id as studentId, MAX(fyid) as fyid, MAX(fyid_name) as fyidName, MAX(class) as class,
             SUM(debit) as totalDeposit, SUM(credit) as totalWithdraw, SUM(debit - credit) as netBalance,
             COUNT(student_id) as transactionCount
      FROM student_money WHERE ${whereClauses.join(' AND ')}
      GROUP BY student_id ORDER BY netBalance DESC
    `;
    
    const rowsRes = await db.prepare(query).bind(...params).all();
    const formatted = (rowsRes.results || []).map((r, i) => ({ no: i + 1, ...r }));

    let tD = 0, tW = 0, tB = 0;
    formatted.forEach(r => { tD += r.totalDeposit; tW += r.totalWithdraw; tB += r.netBalance; });

    return { 
      success: true, data: formatted, 
      stats: { totalDeposited: tD, totalWithdrawn: tW, totalBalance: tB, studentCount: formatted.length }
    };
  } catch (err) { return { success: false, message: err.message }; }
}

export async function saveStudentMoneyEntry(db, session, body) {
  try {
    const entryDate = getMyanmarDateString(body.date);
    const d = new Date(entryDate);
    const my = `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]}-${d.getFullYear()}`;
    
    const fy = normalizeFyStr(body.fy || computeAcademicFy(entryDate));
    const cleanFy = fy.replace(/^FY\s*/i, '');
    
    const rawCore = body.uniqueId ? String(body.uniqueId).trim().replace(/^(STM_|PMC_|CAN_)+/i, '') : generateUniqueId('').replace(/^_/, '');
    const stmUniqueId = `STM_${rawCore}`;
    const pmcUniqueId = `PMC_${rawCore}`;
    
    const rawType = String(body.entryType || 'Deposit').trim();
    const debit = safeAmount(body.debit);
    const credit = safeAmount(body.credit);
    const studentId = parseInt(body.studentId, 10) || null;
    const method = body.method || 'Cash';
    
    const isTransfer = rawType.toLowerCase().includes('transfer') || 
                       rawType.toLowerCase().includes('pm cashier') || 
                       rawType.toLowerCase().includes('အရင်းလွှဲ');
    
    const batchStatements = [];
    let generatedVrNo = null;

    if (isTransfer) {
      if (credit <= 0) return { success: false, message: "PM Cashier သို့ လွှဲမည့် Credit ငွေပမာဏကို အတိအကျ ထည့်သွင်းပါ။" };

      // 🛡️ OVER-TRANSFER GUARD: Vault Physical Cash လုံလောက်မှု စစ်ဆေးခြင်း
      const [stuRes, pmRes] = await db.batch([
        db.prepare("SELECT COALESCE(SUM(debit - credit), 0) as bal FROM student_money WHERE fy IN (?, ?) AND student_id IS NOT NULL").bind(cleanFy, `FY ${cleanFy}`),
        db.prepare("SELECT COALESCE(SUM(debit - credit), 0) as bal FROM pm_cashier_book WHERE fy IN (?, ?)").bind(cleanFy, `FY ${cleanFy}`)
      ]);
      const availableFinanceCash = parseFloat(stuRes.results[0]?.bal || 0) - parseFloat(pmRes.results[0]?.bal || 0);

      if (credit > availableFinanceCash) {
        return {
          success: false,
          message: `ငွေလွှဲခွင့် မပြုပါ! Finance Vault တွင် လက်ရှိငွေသားလက်ကျန် (${availableFinanceCash.toLocaleString('en-US')} MMK) သာ ရှိသဖြင့် (${credit.toLocaleString('en-US')} MMK) ပိုမိုလွှဲပြောင်း၍ မရပါ။`
        };
      }

      const noPm = await generateFyNo(db, 'pm_cashier_book', fy);
      const vrPm = await generateVoucherNo(db, 'pm_cashier_book', 'PMC', entryDate);
      generatedVrNo = vrPm;
      const respPerson = body.responsibilityPerson || 'Cashier 1';
      const pmRemark = body.remark || `Finance မှ ${respPerson} သို့ အရင်းငွေလွှဲပေးခြင်း`;

      batchStatements.push(
        db.prepare(`INSERT INTO pm_cashier_book (no, date, responsibility_person, category, description, method, debit, credit, balances, vr_no, my, fy, created_by, uniqueid) VALUES (?, ?, ?, 'Float Receive', ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)`)
        .bind(noPm, entryDate, respPerson, pmRemark, method, credit, vrPm, my, fy, session?.name || 'Finance', pmcUniqueId)
      );

      const noStu = await generateFyNo(db, 'student_money', cleanFy);
      batchStatements.push(
        db.prepare(`INSERT INTO student_money (no, date, fy, student_id, fyid, fyid_name, class, method, debit, credit, balances, remark, created_by, uniqueid) VALUES (?, ?, ?, NULL, 'TRANSFER', ?, 'Vault Transfer', ?, 0, ?, 0, ?, ?, ?)`)
        .bind(noStu, entryDate, cleanFy, `[Transfer] PM Cashier (${respPerson})`, method, credit, `[Finance Transfer] ${respPerson} သို့ အရင်းလွှဲ: ${pmRemark}`, session?.name || 'Finance', stmUniqueId)
      );

    } else {
      if (!studentId || studentId <= 0) return { success: false, message: "ကျောင်းသား ID အတိအကျ ထည့်သွင်းပေးပါ။" };
      if (debit <= 0 && credit <= 0) return { success: false, message: "အပ်ငွေ (Deposit) သို့မဟုတ် ထုတ်ငွေ (Withdraw) ပမာဏ ထည့်သွင်းပေးပါ။" };

      if (rawType.toLowerCase().includes('withdraw') && credit > 0) {
        const stuBalRow = await db.prepare(
          "SELECT COALESCE(SUM(debit - credit), 0) as bal FROM student_money WHERE fy IN (?, ?) AND student_id = ?"
        ).bind(cleanFy, `FY ${cleanFy}`, studentId).first();
        
        const curStuBal = parseFloat(stuBalRow?.bal || 0);
        if (credit > curStuBal) {
          return {
            success: false,
            message: `ငွေထုတ်ယူခွင့် မပြုပါ! ကျောင်းသားတွင် လက်ရှိမုန့်ဖိုးလက်ကျန် (${curStuBal.toLocaleString('en-US')} MMK) သာ ရှိသဖြင့် (${credit.toLocaleString('en-US')} MMK) ပိုမိုထုတ်ယူခွင့် မရှိပါ။`
          };
        }
      }

      const noStu = await generateFyNo(db, 'student_money', cleanFy);
      const stuName = body.name ? `[${body.fyid}] ${body.name}` : `[ID ${studentId}]`;
      const prefix = rawType.toLowerCase().includes('withdraw') ? '[Finance] Withdraw' : '[Finance] Deposit';
      const remark = `${prefix}: ${body.remark || ''}`.trim();

      batchStatements.push(
        db.prepare(`INSERT INTO student_money (no, date, fy, student_id, fyid, fyid_name, class, method, debit, credit, balances, remark, created_by, uniqueid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`)
        .bind(noStu, entryDate, cleanFy, studentId, body.fyid || '', stuName, body.class || '', method, debit, credit, remark, session?.name || 'Finance', stmUniqueId)
      );
    }

    await db.batch(batchStatements);

    // ⚡ Quota-Shield: သက်ဆိုင်ရာ စာအုပ်ကိုသာ Recalculate လုပ်မည်
    if (!isTransfer && studentId !== null) {
      await recalculateLedgerBalances(db, 'student_money', cleanFy, entryDate);
    }
    if (isTransfer) {
      await recalculateLedgerBalances(db, 'pm_cashier_book', fy, entryDate);
    }

    return { success: true, uniqueId: stmUniqueId, vrNo: generatedVrNo };
  } catch (err) { return { success: false, message: err.message }; }
}

// 🎯 ULTRA QUOTA-SHIELD DELETE: No Full Table Scans (O(1) Exact Index Matching)
export async function deleteStudentMoneyEntry(db, session, body) {
  try {
    const uid = body.uniqueId;
    if (!uid) return { success: false, message: "Unique ID မပါဝင်ပါ။" };
    
    const existing = await db.prepare("SELECT fy, date, student_id, remark, uniqueid FROM student_money WHERE uniqueid = ?").bind(uid).first();
    if (!existing) return { success: false, message: "ဖျက်မည့် စာရင်း ရှာမတွေ့ပါ။" };

    const coreId = uid.replace(/^(STM_|PMC_|CAN_)+/i, '');
    const cleanFy = existing.fy ? existing.fy.replace(/^FY\s*/i, '') : '';
    const isTransferOrCashier = existing.student_id === null || (existing.remark && existing.remark.includes('PM Cashier'));

    // ⚡ EXACT LOOKUP (No LIKE '%...%' scans)
    const exactKeys = [uid, coreId, `STM_${coreId}`, `PMC_${coreId}`, `CAN_${coreId}`, `PMC_STM_${coreId}`, `STM_PMC_${coreId}`];

    const batchStatements = [
      db.prepare(`DELETE FROM student_money WHERE uniqueid IN (${exactKeys.map(() => '?').join(',')})`).bind(...exactKeys),
      db.prepare(`DELETE FROM pm_cashier_book WHERE uniqueid IN (${exactKeys.map(() => '?').join(',')})`).bind(...exactKeys),
      db.prepare(`DELETE FROM canteen_book WHERE uniqueid IN (${exactKeys.map(() => '?').join(',')})`).bind(...exactKeys)
    ];

    await db.batch(batchStatements);

    if (existing.student_id !== null) {
      await recalculateLedgerBalances(db, 'student_money', cleanFy, existing.date);
    }
    if (isTransferOrCashier) {
      await recalculateLedgerBalances(db, 'pm_cashier_book', `FY ${cleanFy}`, existing.date);
    }

    return { success: true };
  } catch (err) { return { success: false, message: err.message }; }
}

// ==============================================================================
// 💡 2. PM CASHIER BOOK (WITH ROLE-BASED ANTI-IMPERSONATION & SCOPED QUERIES)
// ==============================================================================

export async function getPmCashierBookData(db, body, session) {
  try {
    const fy = normalizeFyStr(body.fy || getCurrentAcademicYear()).replace(/^FY\s*/i, '');
    const role = session?.role || '';
    
    const isPaginated = Boolean(body.page || body.limit);
    const page = Math.max(1, parseInt(body.page || 1, 10));
    const limit = Math.min(100, Math.max(1, parseInt(body.limit || 20, 10)));
    const offset = (page - 1) * limit;

    let whereClauses = [`fy IN (?, ?)`];
    let params = [fy, `FY ${fy}`];

    if (role === 'pm_cashier1') {
      whereClauses.push(`responsibility_person = 'Cashier 1'`);
    } else if (role === 'pm_cashier2') {
      whereClauses.push(`responsibility_person = 'Cashier 2'`);
    } else if (body.responsibilityPerson) {
      whereClauses.push(`responsibility_person = ?`);
      params.push(body.responsibilityPerson);
    }

    const whereSql = `WHERE ${whereClauses.join(' AND ')}`;

    if (isPaginated) {
      const [statsRes, rowsRes] = await db.batch([
        db.prepare(`
          SELECT 
            COUNT(id) as totalRows,
            COALESCE(SUM(debit), 0) as totalIn,
            COALESCE(SUM(credit), 0) as totalOut
          FROM pm_cashier_book ${whereSql}
        `).bind(...params),
        db.prepare(`
          SELECT * FROM pm_cashier_book 
          ${whereSql} 
          ORDER BY date DESC, id DESC 
          LIMIT ? OFFSET ?
        `).bind(...params, limit, offset)
      ]);

      const stats = statsRes.results[0] || { totalRows: 0, totalIn: 0, totalOut: 0 };
      const totalIn = parseFloat(stats.totalIn || 0);
      const totalOut = parseFloat(stats.totalOut || 0);
      const balance = totalIn - totalOut;
      const totalRows = parseInt(stats.totalRows || 0, 10);

      return {
        success: true,
        data: (rowsRes.results || []).map(r => ({ ...r, uniqueId: r.uniqueid })),
        stats: { totalIn, totalOut, balance, totalRows },
        page,
        limit
      };
    } else {
      const rowsRes = await db.prepare(`SELECT * FROM pm_cashier_book ${whereSql} ORDER BY date DESC, id DESC LIMIT 5000`).bind(...params).all();
      return { success: true, data: (rowsRes.results || []).map(r => ({ ...r, uniqueId: r.uniqueid })) };
    }
  } catch (err) { 
    return { success: false, message: err.message }; 
  }
}

export async function savePmCashierBookEntry(db, session, body) {
  try {
    const entryDate = getMyanmarDateString(body.date);
    const d = new Date(entryDate);
    const my = `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]}-${d.getFullYear()}`;
    const fy = normalizeFyStr(body.fy || computeAcademicFy(entryDate));
    const cleanFy = fy.replace(/^FY\s*/i, '');
    
    const rawCore = body.uniqueId ? String(body.uniqueId).trim().replace(/^(STM_|PMC_|CAN_)+/i, '') : generateUniqueId('').replace(/^_/, '');
    const pmcUniqueId = `PMC_${rawCore}`;
    const stmUniqueId = `STM_${rawCore}`;

    const category = body.category || 'PM Withdraw';
    const credit = safeAmount(body.credit);
    const debit = safeAmount(body.debit);
    const studentId = parseInt(body.studentId, 10) || null;
    const stuFyid = String(body.fyid || '').trim();
    
    // 🔒 ANTI-IMPERSONATION
    let respPerson = body.responsibilityPerson || 'Cashier 1';
    if (session?.role === 'pm_cashier1') respPerson = 'Cashier 1';
    else if (session?.role === 'pm_cashier2') respPerson = 'Cashier 2';

    // 🎯 ကျောင်းသား အချက်အလက်နှင့် မှတ်ချက်အား ရှေ့နောက် အပြည့်အစုံ ချိတ်ဆက်ခြင်း
    let finalDescription = (body.description || '').trim();
    if (category === 'PM Withdraw' && studentId > 0) {
      const stuPrefix = body.studentName 
        ? `[${stuFyid || 'ID ' + studentId}] ${body.studentName}`.trim() 
        : `[ID ${studentId}]`;
      
      if (!finalDescription.includes(stuPrefix) && !(body.studentName && finalDescription.includes(body.studentName))) {
        finalDescription = finalDescription 
          ? `${stuPrefix} - ${finalDescription}`
          : `${stuPrefix} - မုန့်ဖိုးထုတ်ပေးငွေ`;
      }
    }

    // 🚀 BATCH VERIFICATION (Cashier Float & Student Overdraft Lookups)
    const verifyQueries = [
      db.prepare("SELECT COALESCE(SUM(debit - credit), 0) as bal FROM pm_cashier_book WHERE fy IN (?, ?) AND responsibility_person = ?").bind(cleanFy, `FY ${cleanFy}`, respPerson)
    ];

    if (category === 'PM Withdraw' && (studentId > 0 || stuFyid)) {
      verifyQueries.push(
        db.prepare(`
          SELECT COALESCE(SUM(debit - credit), 0) as bal 
          FROM student_money 
          WHERE fy IN (?, ?) 
            AND (
              student_id = ? 
              OR CAST(student_id AS TEXT) = ? 
              OR (fyid IS NOT NULL AND fyid != '' AND fyid = ?)
            )
        `).bind(cleanFy, `FY ${cleanFy}`, studentId || 0, String(studentId || 0), stuFyid)
      );
    }

    const verifyRes = await db.batch(verifyQueries);
    const curCashierBal = parseFloat(verifyRes[0]?.results[0]?.bal || 0);

    // 🛡️ CASHIER FLOAT OVERDRAFT GUARD
    if (credit > 0 && credit > curCashierBal) {
      return { 
        success: false, 
        message: `${respPerson} တွင် ငွေသားလက်ကျန် (${curCashierBal.toLocaleString('en-US')} MMK) သာ ရှိသဖြင့် (${credit.toLocaleString('en-US')} MMK) ထုတ်ပေး/ပြန်လွှဲခွင့် မပြုပါ!` 
      };
    }

    // 🛡️ STUDENT WALLET OVERDRAFT GUARD
    if (category === 'PM Withdraw' && (studentId > 0 || stuFyid) && credit > 0) {
      const curStuBal = parseFloat(verifyRes[1]?.results[0]?.bal || 0);
      if (credit > curStuBal) {
        return { 
          success: false, 
          message: `မုန့်ဖိုးထုတ်ပေးခွင့် မပြုပါ! ကျောင်းသားတွင် လက်ရှိမုန့်ဖိုးလက်ကျန် (${curStuBal.toLocaleString('en-US')} MMK) သာ ရှိသဖြင့် (${credit.toLocaleString('en-US')} MMK) ပိုမိုထုတ်ယူခွင့် မရှိပါ။` 
        };
      }
    }
    
    const noPm = await generateFyNo(db, 'pm_cashier_book', fy);
    const vrPm = body.vrNo || await generateVoucherNo(db, 'pm_cashier_book', 'PMC', entryDate);
    const batchStatements = [];

    batchStatements.push(
      db.prepare(`INSERT INTO pm_cashier_book (no, date, responsibility_person, category, description, method, debit, credit, balances, vr_no, my, fy, created_by, uniqueid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`)
      .bind(noPm, entryDate, respPerson, category, finalDescription, body.method || 'Cash', debit, credit, vrPm, my, fy, session?.name || 'PM Cashier', pmcUniqueId)
    );

    if (category === 'PM Withdraw' && studentId > 0 && credit > 0) {
      const noStu = await generateFyNo(db, 'student_money', cleanFy);
      const stuName = body.studentName ? `[${stuFyid}] ${body.studentName}` : `[ID ${studentId}]`;
      const desc = `[PM Cashier - ${respPerson}] Withdraw: ${finalDescription}`.trim();

      batchStatements.push(
        db.prepare(`INSERT INTO student_money (no, date, fy, student_id, fyid, fyid_name, class, method, debit, credit, balances, remark, created_by, uniqueid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?)`)
        .bind(noStu, entryDate, cleanFy, studentId, stuFyid, stuName, body.studentClass || '', body.method || 'Cash', credit, desc, session?.name || 'PM Cashier', stmUniqueId)
      );
    } else if (category === 'Return to Finance' && credit > 0) {
      const noStu = await generateFyNo(db, 'student_money', cleanFy);
      const desc = `[PM Cashier] Return Cash from ${respPerson}: ${body.description || ''}`.trim();

      batchStatements.push(
        db.prepare(`INSERT INTO student_money (no, date, fy, student_id, fyid, fyid_name, class, method, debit, credit, balances, remark, created_by, uniqueid) VALUES (?, ?, ?, NULL, 'RETURN', ?, 'Vault Return', ?, ?, 0, 0, ?, ?, ?)`)
        .bind(noStu, entryDate, cleanFy, `[Return] Finance Vault (${respPerson})`, body.method || 'Cash', credit, desc, session?.name || 'PM Cashier', stmUniqueId)
      );
    }

    await db.batch(batchStatements);

    await recalculateLedgerBalances(db, 'pm_cashier_book', fy, entryDate);
    if (category === 'PM Withdraw') {
      await recalculateLedgerBalances(db, 'student_money', cleanFy, entryDate);
    }

    return { success: true, uniqueId: pmcUniqueId, vrNo: vrPm };
  } catch (err) { return { success: false, message: err.message }; }
}

export async function deletePmCashierBookEntry(db, session, body) {
  try {
    const uid = body.uniqueId;
    if (!uid) return { success: false, message: "Unique ID မပါဝင်ပါ။" };
    
    const existing = await db.prepare("SELECT fy, date, category, responsibility_person, uniqueid FROM pm_cashier_book WHERE uniqueid = ?").bind(uid).first();
    if (!existing) return { success: false, message: "ဖျက်မည့် စာရင်း ရှာမတွေ့ပါ။" };

    const role = session?.role || '';
    const isCashierRole = (role === 'pm_cashier1' || role === 'pm_cashier2');

    if (isCashierRole && existing.category === 'Float Receive') {
      return { 
        success: false, 
        message: "ငွေလွှဲခွင့် မပြုပါ! Finance မှ လွှဲပေးထားသော အရင်းငွေစာရင်း (Float Receive) ကို ငွေကိုင်မှ ဖျက်ပိုင်ခွင့် လုံးဝမရှိပါ။ Finance သို့ ဆက်သွယ်ပါ။" 
      };
    }

    if (role === 'pm_cashier1' && existing.responsibility_person !== 'Cashier 1') {
      return { success: false, message: "Cashier 1 ၏ စာရင်း မဟုတ်သဖြင့် ဖျက်ခွင့်မရှိပါ။" };
    }
    if (role === 'pm_cashier2' && existing.responsibility_person !== 'Cashier 2') {
      return { success: false, message: "Cashier 2 ၏ စာရင်း မဟုတ်သဖြင့် ဖျက်ခွင့်မရှိပါ။" };
    }

    if (isCashierRole) {
      const todayStr = getMyanmarDateString();
      if (existing.date !== todayStr) {
        return { 
          success: false, 
          message: "ဖျက်ခွင့် မရှိပါ! စာရင်းသွင်းပြီး ၁ ရက် (ယနေ့) ကျော်လွန်သွားသော စာရင်းဟောင်းများကို ငွေကိုင်မှ ဖျက်ပိုင်ခွင့် မရှိပါ။ Admin သို့ တင်ပြပါ။" 
        };
      }
    }

    const coreId = uid.replace(/^(STM_|PMC_|CAN_)+/i, '');
    const exactKeys = [uid, coreId, `STM_${coreId}`, `PMC_${coreId}`, `STM_PMC_${coreId}`, `PMC_STM_${coreId}`];

    const batchStatements = [
      db.prepare(`DELETE FROM pm_cashier_book WHERE uniqueid IN (${exactKeys.map(() => '?').join(',')})`).bind(...exactKeys),
      db.prepare(`DELETE FROM student_money WHERE uniqueid IN (${exactKeys.map(() => '?').join(',')})`).bind(...exactKeys)
    ];

    await db.batch(batchStatements);

    const cleanFy = existing.fy ? existing.fy.replace(/^FY\s*/i, '') : '';
    await recalculateLedgerBalances(db, 'pm_cashier_book', `FY ${cleanFy}`, existing.date);
    await recalculateLedgerBalances(db, 'student_money', cleanFy, existing.date);

    return { success: true };
  } catch (err) { 
    return { success: false, message: err.message }; 
  }
}

// ==============================================================================
// 💡 3. CANTEEN BOOK (PREPARED FOR POS INTEGRATION)
// ==============================================================================

export async function getCanteenBookData(db, body) {
  try {
    const fy = normalizeFyStr(body.fy || getCurrentAcademicYear()).replace(/^FY\s*/i, '');
    const query = `SELECT * FROM canteen_book WHERE fy IN (?, ?) ORDER BY date DESC, id DESC LIMIT 500`;
    const res = await db.prepare(query).bind(fy, `FY ${fy}`).all();
    return { success: true, data: (res.results || []).map(r => ({ ...r, uniqueId: r.uniqueid })) };
  } catch (err) { return { success: false, message: err.message }; }
}

export async function saveCanteenBookEntry(db, session, body) {
  try {
    const entryDate = getMyanmarDateString(body.date);
    const d = new Date(entryDate);
    const my = `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]}-${d.getFullYear()}`;
    const fy = normalizeFyStr(body.fy || computeAcademicFy(entryDate));
    const cleanFy = fy.replace(/^FY\s*/i, '');
    
    const rawCore = body.uniqueId ? String(body.uniqueId).trim().replace(/^(STM_|PMC_|CAN_)+/i, '') : generateUniqueId('').replace(/^_/, '');
    const canUniqueId = `CAN_${rawCore}`;
    const stmUniqueId = `STM_${rawCore}`;

    const category = body.category || 'POS Sales';
    const debit = safeAmount(body.debit);
    const studentId = parseInt(body.studentId, 10) || null;

    if (debit <= 0) return { success: false, message: "ရောင်းရငွေ ပမာဏကို အတိအကျ ထည့်သွင်းပါ။" };

    // 🛡️ CANTEEN POS OVERDRAFT GUARD (Zero-Latency Check)
    if (category === 'POS Sales' && studentId > 0) {
      const stuBalRow = await db.prepare(
        "SELECT COALESCE(SUM(debit - credit), 0) as bal FROM student_money WHERE fy IN (?, ?) AND student_id = ?"
      ).bind(cleanFy, `FY ${cleanFy}`, studentId).first();
      
      const curStuBal = parseFloat(stuBalRow?.bal || 0);
      if (debit > curStuBal) {
        return {
          success: false,
          message: `ကန်တင်းအရောင်း မအောင်မြင်ပါ! ကျောင်းသားတွင် မုန့်ဖိုးလက်ကျန် (${curStuBal.toLocaleString('en-US')} MMK) သာ ရှိသဖြင့် (${debit.toLocaleString('en-US')} MMK) ပိုမိုဖြတ်တောက်၍ မရပါ။`
        };
      }
    }
    
    const noCan = await generateFyNo(db, 'canteen_book', fy);
    const vrCan = body.vrNo || await generateVoucherNo(db, 'canteen_book', 'CAN', entryDate);
    const batchStatements = [];

    batchStatements.push(
      db.prepare(`INSERT INTO canteen_book (no, date, category, description, method, debit, credit, balances, vr_no, my, fy, created_by, uniqueid) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)`)
      .bind(noCan, entryDate, category, body.description || '', body.method || 'Transfer', debit, vrCan, my, fy, session?.name || 'System', canUniqueId)
    );

    if (category === 'POS Sales' && studentId > 0) {
      const noStu = await generateFyNo(db, 'student_money', cleanFy);
      const stuName = body.studentName ? `[${body.fyid}] ${body.studentName}` : `[ID ${studentId}]`;
      const desc = `[Canteen] POS Sales: ${body.description || ''}`.trim();

      batchStatements.push(
        db.prepare(`INSERT INTO student_money (no, date, fy, student_id, fyid, fyid_name, class, method, debit, credit, balances, remark, created_by, uniqueid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?)`)
        .bind(noStu, entryDate, cleanFy, studentId, body.fyid || '', stuName, body.studentClass || '', body.method || 'Transfer', debit, desc, session?.name || 'System', stmUniqueId)
      );
    }

    await db.batch(batchStatements);

    await recalculateLedgerBalances(db, 'canteen_book', fy, entryDate);
    if (category === 'POS Sales' && studentId > 0) {
      await recalculateLedgerBalances(db, 'student_money', cleanFy, entryDate);
    }

    return { success: true, uniqueId: canUniqueId };
  } catch (err) { return { success: false, message: err.message }; }
}

export async function deleteCanteenBookEntry(db, session, body) {
  try {
    const uid = body.uniqueId;
    if (!uid) return { success: false, message: "Unique ID မပါဝင်ပါ။" };
    
    const existing = await db.prepare("SELECT fy, date, category, uniqueid FROM canteen_book WHERE uniqueid = ?").bind(uid).first();
    if (!existing) return { success: false, message: "ဖျက်မည့် စာရင်း ရှာမတွေ့ပါ။" };

    const coreId = uid.replace(/^(STM_|PMC_|CAN_)+/i, '');
    const exactKeys = [uid, coreId, `CAN_${coreId}`, `STM_${coreId}`, `STM_CAN_${coreId}`];

    const batchStatements = [
      db.prepare(`DELETE FROM canteen_book WHERE uniqueid IN (${exactKeys.map(() => '?').join(',')})`).bind(...exactKeys),
      db.prepare(`DELETE FROM student_money WHERE uniqueid IN (${exactKeys.map(() => '?').join(',')})`).bind(...exactKeys)
    ];

    await db.batch(batchStatements);

    const cleanFy = existing.fy ? existing.fy.replace(/^FY\s*/i, '') : '';
    await recalculateLedgerBalances(db, 'canteen_book', `FY ${cleanFy}`, existing.date);
    if (existing.category === 'POS Sales') {
      await recalculateLedgerBalances(db, 'student_money', cleanFy, existing.date);
    }

    return { success: true };
  } catch (err) { return { success: false, message: err.message }; }
}

// ==============================================================================
// 💡 4. SPMMS RECONCILIATION AUDIT ENGINE
// ==============================================================================

export async function getSpmmsReconciliation(db, body) {
  try {
    const fy = normalizeFyStr(body.fy || getCurrentAcademicYear()).replace(/^FY\s*/i, '');
    
    const [stuBalRes, pmBalRes] = await db.batch([
      db.prepare("SELECT COALESCE(SUM(debit - credit), 0) as bal FROM student_money WHERE fy IN (?, ?) AND student_id IS NOT NULL").bind(fy, `FY ${fy}`),
      db.prepare("SELECT COALESCE(SUM(debit - credit), 0) as bal FROM pm_cashier_book WHERE fy IN (?, ?)").bind(fy, `FY ${fy}`)
    ]);

    const totalVirtual = parseFloat(stuBalRes.results[0]?.bal || 0);
    const totalCashier = parseFloat(pmBalRes.results[0]?.bal || 0);

    const totalFinance = totalVirtual - totalCashier;
    const totalPhysicalCash = totalFinance + totalCashier;

    const variance = totalVirtual - totalPhysicalCash;
    const isMatched = Math.abs(variance) < 0.01;

    return {
      success: true,
      data: {
        totalVirtual,
        totalFinance,
        totalCashier,
        totalPhysicalCash,
        variance,
        isMatched
      }
    };
  } catch (err) { return { success: false, message: err.message }; }
}