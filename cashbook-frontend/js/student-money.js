/**
 * ==============================================================================
 * GOLDEN ERP SYSTEM - SPMMS FRONTEND CONTROLLER (ENTERPRISE EDITION)
 * File: js/student-money.js
 * 
 * 💡 Features:
 *   1. ⚡ QUOTA-SHIELD: True Server-Side 20-Row Pagination for Both Main & Statement Views
 *   2. 🛡️ ZERO-FREEZE VALIDATION: Form validation completes before loading/closing modals
 *   3. 🎯 HIGH-CONTRAST CENTER TOAST: Dead-center Z-index 999999 alert notifications
 *   4. 📄 DUAL-SLIP A4 TRANSFER VOUCHER: Clean printable vouchers with cut markers
 *   5. 🔄 INSTANT CACHE & LOOKUP: Client-side student directory cache
 * ==============================================================================
 */

var gCurrentStudentMoneyTab = 'main'; // 'main', 'canteen', 'cashier', 'reconcile'

// Main Student Money State
var gStudentMoneyHistoryData = [];
var gStudentMoneyPage = 1, gStudentMoneyLimit = 20, gStudentMoneyTotalRows = 0;

// Canteen Book State
var gCanteenBookData = [];
var gCanteenBookFilteredData = [];
var gCanteenPage = 1, gCanteenLimit = 20;

// PM Cashier Book State
var gPmCashierBookData = [];
var gPmCashierBookFilteredData = [];
var gPmCashierPage = 1, gPmCashierLimit = 20;

// Student Statement Modal State
var gStmtStudentId = null;
var gStmtPage = 1, gStmtLimit = 20, gStmtTotalRows = 0;

var gStudentCacheForMoney = {};
var isSubmitting = false;
var searchTimeout = null;

// Safe Escape Helpers
const esc = window.escapeHtml || (s => s ? String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) : '');
const escAttr = window.escapeJsAttr || (s => s ? String(s).replace(/'/g, "\\'") : '');

// ==============================================================================
// 💡 1. MAIN TAB SWITCHER
// ==============================================================================
function switchStudentMoneySubTab(tabName) {
  gCurrentStudentMoneyTab = tabName || 'main';
  const tabs = ['main', 'canteen', 'cashier', 'reconcile'];
  
  const activeClass = 'px-4 py-2 rounded-lg text-xs font-black transition-all flex items-center gap-2 bg-indigo-600 text-white shadow-lg shadow-indigo-600/20';
  const inactiveClass = 'px-4 py-2 rounded-lg text-xs font-black transition-all flex items-center gap-2 bg-slate-800 text-slate-400 hover:text-white border border-slate-700/50';

  tabs.forEach(t => {
    const btn = document.getElementById(`stm-tab-${t}`);
    const view = document.getElementById(`stm-${t}-view`);
    if (btn) btn.className = (t === gCurrentStudentMoneyTab) ? activeClass : inactiveClass;
    if (view) view.classList.toggle('hidden', t !== gCurrentStudentMoneyTab);
  });

  if (gCurrentStudentMoneyTab === 'main') loadStudentMoneyData(false);
  else if (gCurrentStudentMoneyTab === 'canteen') loadCanteenBookData(false);
  else if (gCurrentStudentMoneyTab === 'cashier') loadPmCashierBookData(false);
  else if (gCurrentStudentMoneyTab === 'reconcile') loadSpmmsReconciliationData();
}

function renderTopKPIs(inc, exp, bal, count, vaultCash, pmCash) {
  const elInc = document.getElementById('stm-total-income');
  const elExp = document.getElementById('stm-total-expense');
  const elBal = document.getElementById('stm-balance');
  const elVault = document.getElementById('stm-vault-cash');
  const elPmCash = document.getElementById('stm-pm-cashier-cash');
  const elCount = document.getElementById('stm-entries-count');

  if (elInc) elInc.textContent = `${Number(inc || 0).toLocaleString('en-US')} MMK`;
  if (elExp) elExp.textContent = `${Number(exp || 0).toLocaleString('en-US')} MMK`;
  if (elBal) elBal.textContent = `${Number(bal || 0).toLocaleString('en-US')} MMK`;
  if (elVault) elVault.textContent = `${Number(vaultCash || 0).toLocaleString('en-US')} MMK`;
  if (elPmCash) elPmCash.textContent = `${Number(pmCash || 0).toLocaleString('en-US')} MMK`;
  if (elCount) elCount.textContent = Number(count || 0).toLocaleString('en-US');
}

// ==============================================================================
// 💡 2. STUDENT MONEY BOOK (SERVER-SIDE PAGINATION - 20 ROWS PER READ)
// ==============================================================================
async function loadStudentMoneyData(isSilent) {
  try {
    if (!isSilent && typeof toggleLoading === 'function') toggleLoading(true);

    const searchVal = (document.getElementById('stm-search')?.value || '').trim();
    const dateFrom = document.getElementById('stm-date-from')?.value || '';
    const dateTo = document.getElementById('stm-date-to')?.value || '';

    // 🚀 D1 QUOTA SHIELD: Fetch exactly 20 rows per page
    const res = await callApi('getStudentMoneyData', { 
      page: gStudentMoneyPage, 
      limit: gStudentMoneyLimit, 
      searchVal,
      dateFrom,
      dateTo,
      forceRefresh: true 
    }, 'GET');

    if (res && res.success) {
      gStudentMoneyHistoryData = res.data || [];
      gStudentMoneyTotalRows = res.totalRows || 0;
      const st = res.stats || {};
      
      renderTopKPIs(st.totalIncome, st.totalExpense, st.balance, gStudentMoneyTotalRows, st.financeVaultCash, st.pmCashierCash);
      renderStudentMoneyTable();
    }
  } catch (err) {
    console.error("Student Money Load Error:", err);
  } finally {
    if (!isSilent && typeof toggleLoading === 'function') toggleLoading(false);
  }
}

function renderStudentMoneyTable() {
  const tbody = document.getElementById('stm-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (gStudentMoneyHistoryData.length === 0) {
    tbody.innerHTML = `<tr><td colspan="13" class="text-center py-8 text-slate-500 font-bold">စာရင်း မရှိပါ။</td></tr>`;
    const info = document.getElementById('stm-pagination-info');
    if (info) info.textContent = "Showing 0 entries";
    return;
  }

  gStudentMoneyHistoryData.forEach((row, idx) => {
    // 🎯 အသစ်ဆုံးစာရင်းကို အကြီးဆုံးနံပါတ်ဖြင့် ပြသခြင်း
    const displayNo = gStudentMoneyTotalRows - ((gStudentMoneyPage - 1) * gStudentMoneyLimit + idx);
    const isTransfer = row.studentId === null || row.studentId === 0 || row.fyid === 'TRANSFER' || row.fyid === 'RETURN';
    const cleanFyid = typeof window.sanitizeFyidStr === 'function' ? window.sanitizeFyidStr(row.fyid) : (row.fyid || '');

    const balStr = isTransfer 
      ? '<span class="text-slate-500 font-mono">-</span>' 
      : Number(row.balances || 0).toLocaleString('en-US', {minimumFractionDigits: 2});
    
    tbody.innerHTML += `
      <tr class="hover:bg-slate-800/30 text-slate-300 text-xs border-b border-slate-800/40">
        <td class="text-center font-mono py-3 px-2 font-bold text-slate-400">${displayNo}</td>
        <td class="font-mono text-xs py-3 px-2">${esc(row.date)}</td>
        <td class="font-mono font-bold text-indigo-300 py-3 px-2">${esc(row.fy)}</td>
        <td class="font-mono font-bold py-3 px-2">
          ${isTransfer 
            ? '<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">XFER</span>' 
            : (row.studentId || '-')}
        </td>
        <td class="font-mono font-bold ${isTransfer ? 'text-amber-400' : 'text-indigo-400'} py-3 px-2">${esc(cleanFyid)}</td>
        <td class="font-bold ${isTransfer ? 'text-amber-300' : 'text-slate-100'} py-3 px-2">${esc(row.fyidName)}</td>
        <td class="py-3 px-2">${esc(row.class)}</td>
        <td class="font-semibold py-3 px-2">${esc(row.method)}</td>
        <td class="text-right text-emerald-400 font-mono font-bold py-3 px-2">${row.debit > 0 ? Number(row.debit).toLocaleString('en-US') : '-'}</td>
        <td class="text-right text-rose-400 font-mono font-bold py-3 px-2">${row.credit > 0 ? Number(row.credit).toLocaleString('en-US') : '-'}</td>
        <td class="text-right text-indigo-400 font-mono font-bold py-3 px-2">${balStr}</td>
        <td class="max-w-xs truncate text-[11px] text-slate-400 py-3 px-2" title="${esc(row.remark)}">${esc(row.remark || '-')}</td>
        <td class="right-0 sticky bg-[#0c1322] border-l border-slate-800 text-center py-3 px-2">
          <div class="flex justify-center items-center gap-2">
            ${isTransfer 
              ? `<button onclick="printRowTransferVoucher('${escAttr(row.uniqueId)}', 'main')" class="p-1 text-sky-400 hover:text-sky-300 transition" title="Print Transfer Slip"><i class="fa-solid fa-print"></i></button>`
              : `<button onclick="openStudentStatementModal(${row.studentId})" class="p-1 text-amber-400 hover:text-amber-300 transition" title="Statement"><i class="fa-solid fa-file-invoice"></i></button>`}
            <button onclick="deleteStudentMoneyEntry('${escAttr(row.uniqueId)}')" class="p-1 text-rose-400 hover:text-rose-300 transition" title="Delete"><i class="fa-solid fa-trash"></i></button>
          </div>
        </td>
      </tr>
    `;
  });
  
  const start = (gStudentMoneyPage - 1) * gStudentMoneyLimit + 1;
  const end = Math.min(start + gStudentMoneyLimit - 1, gStudentMoneyTotalRows);
  const info = document.getElementById('stm-pagination-info');
  if (info) info.textContent = gStudentMoneyTotalRows === 0 ? "Showing 0 entries" : `Showing ${start} to ${end} of ${gStudentMoneyTotalRows} entries`;
  
  const prevBtn = document.getElementById('stm-btn-prev');
  const nextBtn = document.getElementById('stm-btn-next');
  if (prevBtn) prevBtn.disabled = (gStudentMoneyPage <= 1);
  if (nextBtn) nextBtn.disabled = (end >= gStudentMoneyTotalRows);
}

function onSearchInputStudentMoney() { 
  clearTimeout(searchTimeout); 
  searchTimeout = setTimeout(() => { gStudentMoneyPage = 1; loadStudentMoneyData(true); }, 250); 
}

function clearDateFilterStudentMoney() { 
  document.getElementById('stm-date-from').value = ''; 
  document.getElementById('stm-date-to').value = ''; 
  gStudentMoneyPage = 1;
  loadStudentMoneyData(false); 
}

function changePageStudentMoney(delta) { 
  gStudentMoneyPage += delta; 
  loadStudentMoneyData(false); 
}

function populateFYDropdownMoney() {
  const select = document.getElementById('stm-fy');
  if (!select) return;
  const currentFY = (typeof window.getCurrentAcademicYear === 'function') ? window.getCurrentAcademicYear() : '2026-2027';
  const startYear = parseInt(currentFY.split('-')[0], 10) || 2026;
  const prevFY = `${startYear - 1}-${startYear}`;
  const nextFY = `${startYear + 1}-${startYear + 2}`;
  const currentVal = select.value || currentFY;

  select.innerHTML = `
    <option value="${prevFY}" ${prevFY === currentVal ? 'selected' : ''}>${prevFY}</option>
    <option value="${currentFY}" ${currentFY === currentVal ? 'selected' : ''}>${currentFY}</option>
    <option value="${nextFY}" ${nextFY === currentVal ? 'selected' : ''}>${nextFY}</option>
  `;
}

function openAddModalStudentMoney() {
  const form = document.getElementById('student-money-form');
  if (form) form.reset();

  const uid = document.getElementById('stm-uniqueId');
  if (uid) uid.value = '';

  const dateEl = document.getElementById('stm-date');
  if (dateEl) dateEl.value = new Date().toISOString().slice(0, 10);

  const deb = document.getElementById('stm-debit');
  const cred = document.getElementById('stm-credit');
  if (deb) { deb.disabled = false; deb.value = 0; }
  if (cred) { cred.disabled = false; cred.value = 0; }

  populateFYDropdownMoney();
  onStudentMoneyEntryTypeChange();

  const liveBadge = document.getElementById('stm-wallet-live-badge');
  if (liveBadge) liveBadge.classList.add('hidden');

  document.getElementById('student-money-modal')?.classList.remove('hidden');
}

function closeStudentMoneyModal() { 
  document.getElementById('student-money-modal')?.classList.add('hidden'); 
}

function onStudentMoneyEntryTypeChange() {
  const type = document.getElementById('stm-entry-type')?.value || 'Deposit';
  const stuBox = document.getElementById('stm-student-fields');
  const respBox = document.getElementById('stm-resp-person-box');
  const deb = document.getElementById('stm-debit');
  const cred = document.getElementById('stm-credit');
  const desc = document.getElementById('stm-remark');

  if (type === 'Transfer to PM Cashier') {
    if (stuBox) stuBox.classList.add('hidden');
    if (respBox) respBox.classList.remove('hidden');
    if (deb) { deb.disabled = true; deb.value = 0; }
    if (cred) cred.disabled = false;
    if (desc) desc.value = "Finance မှ PM Cashier သို့ အရင်းငွေလွှဲပေးခြင်း";
  } else {
    if (stuBox) stuBox.classList.remove('hidden');
    if (respBox) respBox.classList.add('hidden');
    if (deb) deb.disabled = false;
    if (cred) cred.disabled = false;

    if (type === 'Deposit') {
      if (cred) cred.value = 0;
      if (desc && (!desc.value || desc.value.includes('ငွေပြန်ထုတ်'))) desc.value = "ကျောင်းသား မုန့်ဖိုးအပ်ငွေ";
    } else if (type === 'Withdraw') {
      if (deb) deb.value = 0;
      if (desc && (!desc.value || desc.value.includes('မုန့်ဖိုးအပ်ငွေ'))) desc.value = "ကျောင်းသားအား ငွေသားပြန်ထုတ်ပေးခြင်း";
    }
  }
}

function onDebitInputStudentMoney() {
  const debVal = parseFloat(document.getElementById('stm-debit')?.value || 0);
  if (debVal > 0) {
    const cred = document.getElementById('stm-credit');
    if (cred) cred.value = 0;
  }
}

function onCreditInputStudentMoney() {
  const credVal = parseFloat(document.getElementById('stm-credit')?.value || 0);
  if (credVal > 0) {
    const deb = document.getElementById('stm-debit');
    if (deb) deb.value = 0;
  }
}

async function onStudentIdOrFYChangeMoney() {
  const fyVal = document.getElementById('stm-fy')?.value || (typeof window.getCurrentAcademicYear === 'function' ? window.getCurrentAcademicYear() : '2026-2027');
  const idVal = document.getElementById('stm-id-search')?.value.trim();

  const fyidShow = document.getElementById('stm-fyid-show');
  const fyidNameShow = document.getElementById('stm-fyidname-show');
  const classEl = document.getElementById('stm-class');
  const liveBadge = document.getElementById('stm-wallet-live-badge');
  const liveAmountEl = document.getElementById('stm-wallet-live-amount');

  if (!idVal) {
    if (fyidShow) fyidShow.value = "";
    if (fyidNameShow) fyidNameShow.value = "";
    if (classEl) classEl.value = "";
    if (liveBadge) liveBadge.classList.add('hidden');
    return;
  }

  const targetIdNum = parseInt(idVal, 10);

  if (!gStudentCacheForMoney[fyVal]) {
    try {
      const res = await callApi('getStudentData', { fy: fyVal, limit: 5000 }, 'GET');
      if (res && res.success) gStudentCacheForMoney[fyVal] = res.data || [];
    } catch (e) {}
  }

  const list = gStudentCacheForMoney[fyVal] || [];
  let matched = list.find(s => parseInt(s.studentId || s.student_id || s.id, 10) === targetIdNum);

  if (!matched) {
    try {
      const singleRes = await callApi('lookupStudentById', { studentId: targetIdNum, fy: fyVal }, 'GET');
      if (singleRes && singleRes.success && singleRes.data) matched = singleRes.data;
    } catch (e) {}
  }

  if (matched) {
    const actualFyid = typeof window.sanitizeFyidStr === 'function' ? window.sanitizeFyidStr(matched.fyid || '') : (matched.fyid || '');
    const actualName = matched.name || matched.fyidName || '';

    if (fyidShow) fyidShow.value = actualFyid;
    if (fyidNameShow) fyidNameShow.value = `[${actualFyid}] ${actualName}`;
    if (classEl) classEl.value = matched.class || '';

    try {
      const sumRes = await callApi('getStudentMoneySummary', { fy: fyVal, searchVal: actualFyid }, 'GET');
      if (sumRes && sumRes.success && sumRes.data && sumRes.data.length > 0) {
        const studentSum = sumRes.data.find(r => r.studentId === targetIdNum);
        if (studentSum && liveBadge && liveAmountEl) {
          liveAmountEl.textContent = `${Number(studentSum.netBalance || 0).toLocaleString('en-US')} MMK`;
          liveBadge.classList.remove('hidden');
        }
      } else {
        if (liveBadge && liveAmountEl) {
          liveAmountEl.textContent = "0 MMK";
          liveBadge.classList.remove('hidden');
        }
      }
    } catch (err) {}
  } else {
    if (fyidShow) fyidShow.value = "Not Found";
    if (fyidNameShow) fyidNameShow.value = "ကျောင်းသား ရှာမတွေ့ပါ";
    if (classEl) classEl.value = "";
    if (liveBadge) liveBadge.classList.add('hidden');
  }
}

// 🎯 ZERO-FREEZE FORM SUBMISSION
async function saveStudentMoneyForm(e) {
  if (e && e.preventDefault) e.preventDefault();
  if (isSubmitting) return;

  const entryTypeSelect = document.getElementById('stm-entry-type');
  const entryType = (entryTypeSelect?.value || 'Deposit').trim();
  const credit = parseFloat(document.getElementById('stm-credit')?.value || 0);
  const debit = parseFloat(document.getElementById('stm-debit')?.value || 0);
  const studentId = parseInt(document.getElementById('stm-id-search')?.value, 10) || 0;

  const isTransfer = entryType.toLowerCase().includes('transfer') || entryType.toLowerCase().includes('အရင်းလွှဲ');

  // 1. Validation Before Closing Modal
  if (isTransfer) {
    if (credit <= 0) return showToast("ERROR", "PM Cashier သို့ လွှဲမည့် Credit ငွေပမာဏ ထည့်သွင်းပါ။");

    const trustBalText = document.getElementById('stm-balance')?.textContent || '0';
    const trustBal = parseFloat(trustBalText.replace(/[^0-9.-]+/g, "")) || 0;
    const cashierCashText = document.getElementById('stm-pm-cashier-cash')?.textContent || '0';
    const cashierCash = parseFloat(cashierCashText.replace(/[^0-9.-]+/g, "")) || 0;
    const availableFinanceCash = trustBal - cashierCash;

    if (credit > availableFinanceCash) {
      return showToast("ERROR", `Finance Vault တွင် လက်ကျန်ငွေသား (${availableFinanceCash.toLocaleString()} MMK) သာ ရှိသဖြင့် (${credit.toLocaleString()} MMK) ပိုမိုလွှဲပြောင်း၍ မရပါ!`);
    }
  } else {
    if (!studentId || (debit <= 0 && credit <= 0)) return showToast("ERROR", "ကျောင်းသား ID နှင့် ငွေပမာဏ အတိအကျ ထည့်ပါ။");

    if (entryType === 'Withdraw' && credit > 0) {
      const liveBalText = document.getElementById('stm-wallet-live-amount')?.textContent || '0';
      const liveBal = parseFloat(liveBalText.replace(/[^0-9.-]+/g, "")) || 0;
      if (credit > liveBal) {
        return showToast("ERROR", `ကျောင်းသားတွင် လက်ရှိမုန့်ဖိုးလက်ကျန် (${liveBal.toLocaleString()} MMK) သာ ရှိသဖြင့် (${credit.toLocaleString()} MMK) ထုတ်ယူခွင့် မပြုပါ!`);
      }
    }
  }

  // 2. Passed Validations: Safely Lock & Show Loading
  isSubmitting = true;
  closeStudentMoneyModal();
  if (typeof toggleLoading === 'function') toggleLoading(true);

  const payload = {
    uniqueId: document.getElementById('stm-uniqueId')?.value || '',
    date: document.getElementById('stm-date')?.value || new Date().toISOString().slice(0, 10),
    fy: document.getElementById('stm-fy')?.value || (typeof window.getCurrentAcademicYear === 'function' ? window.getCurrentAcademicYear() : '2026-2027'),
    entryType: isTransfer ? 'Transfer to PM Cashier' : entryType,
    method: document.getElementById('stm-method')?.value || 'Cash',
    debit: debit,
    credit: credit,
    remark: document.getElementById('stm-remark')?.value || '',
    studentId: isTransfer ? null : studentId,
    fyid: document.getElementById('stm-fyid-show')?.value || '',
    name: document.getElementById('stm-fyidname-show')?.value || '',
    class: document.getElementById('stm-class')?.value || '',
    responsibilityPerson: document.getElementById('stm-responsibility-person')?.value || 'Cashier 1'
  };

  try {
    const res = await callApi('saveStudentMoneyEntry', payload);
    if (res && res.success) {
      showToast('SUCCESS', isTransfer ? 'PM Cashier သို့ အရင်းငွေလွှဲပြောင်းပြီးပါပြီ။' : 'ကျောင်းသားငွေစာရင်း မှတ်တမ်းတင်ပြီးပါပြီ။');
      loadStudentMoneyData(false);
      loadPmCashierBookData(false);
    } else { 
      showToast('ERROR', res?.message || 'သိမ်းဆည်းမှု မအောင်မြင်ပါ။'); 
    }
  } catch (err) { 
    showToast('ERROR', err.message); 
  } finally { 
    isSubmitting = false; 
    if (typeof toggleLoading === 'function') toggleLoading(false); 
  }
}

async function deleteStudentMoneyEntry(uniqueId) {
  if (!confirm("ဤစာရင်းအား ဖျက်ပါက ဆက်စပ်နေသော Cashier / Canteen စာရင်းများပါ အလိုအလျောက် ပယ်ဖျက်သွားပါမည်။ သေချာပါသလား?")) return;
  if (typeof toggleLoading === 'function') toggleLoading(true);
  try {
    const res = await callApi('deleteStudentMoneyEntry', { uniqueId });
    if (res && res.success) {
      showToast('SUCCESS', 'စာရင်းအားလုံးမှ ချိတ်ဆက်ဖျက်သိမ်းပြီးပါပြီ။');
      loadStudentMoneyData(false);
      loadPmCashierBookData(false);
    } else {
      showToast('ERROR', res?.message || 'ဖျက်သိမ်းမှု မအောင်မြင်ပါ။');
    }
  } catch (err) {
    showToast('ERROR', err.message);
  } finally { 
    if (typeof toggleLoading === 'function') toggleLoading(false); 
  }
}

async function exportToCSVStudentMoney() {
  try {
    if (typeof toggleLoading === 'function') toggleLoading(true);
    // Export ချိန်တွင်သာ အချက်အလက်အပြည့်အစုံကို လှမ်းခေါ်ယူခြင်း
    const res = await callApi('getStudentMoneyData', { page: 1, limit: 10000, forceRefresh: true }, 'GET');
    const records = res?.data || gStudentMoneyHistoryData;
    if (!records || records.length === 0) return showToast("ERROR", "ထုတ်ယူရန် စာရင်း မရှိပါ။");

    let csv = "NO,DATE,FY,ID,FYID,NAME,CLASS,METHOD,DEBIT,CREDIT,BALANCES,REMARK\n";
    const safeCell = window.safeCsvCell || (s => `"${String(s || '').replace(/"/g, '""')}"`);
    records.forEach((r, idx) => {
      const cleanId = typeof window.sanitizeFyidStr === 'function' ? window.sanitizeFyidStr(r.fyid) : (r.fyid || '');
      csv += `${idx + 1},${safeCell(r.date || '')},${safeCell(r.fy || '')},${r.studentId || ''},${safeCell(cleanId)},${safeCell(r.fyidName || '')},${safeCell(r.class || '')},${safeCell(r.method || '')},${r.debit || 0},${r.credit || 0},${r.balances || 0},${safeCell(r.remark || '')}\n`;
    });
    const blob = new Blob(["\uFEFF" + csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Student_Money_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  } catch (e) {
    showToast("ERROR", "CSV Export မအောင်မြင်ပါ။");
  } finally {
    if (typeof toggleLoading === 'function') toggleLoading(false);
  }
}

// ==============================================================================
// 💡 3. CANTEEN BOOK
// ==============================================================================
async function loadCanteenBookData(isSilent) {
  try {
    if (!isSilent && typeof toggleLoading === 'function') toggleLoading(true);
    const res = await callApi('getCanteenBookData', { forceRefresh: true }, 'GET');
    if (res && res.success) {
      gCanteenBookData = res.data || [];
      applyCanteenBookSearchAndRender();
    }
  } catch (err) {
    console.error("Canteen Load Error:", err);
  } finally { 
    if (!isSilent && typeof toggleLoading === 'function') toggleLoading(false); 
  }
}

function applyCanteenBookSearchAndRender() {
  const query = (document.getElementById('canteen-search')?.value || '').trim().toLowerCase();
  const fDate = document.getElementById('canteen-date-from')?.value || '';
  const tDate = document.getElementById('canteen-date-to')?.value || '';

  let todaySales = 0;
  const todayStr = new Date().toISOString().slice(0, 10);

  gCanteenBookFilteredData = gCanteenBookData.filter(row => {
    if (row.date === todayStr && row.category === 'POS Sales') todaySales += Number(row.debit || 0);
    if (typeof window.isDateInRange === 'function' && !window.isDateInRange(row.date, fDate, tDate)) return false;
    if (!query) return true;
    return String(row.description || '').toLowerCase().includes(query) || String(row.vrNo || '').toLowerCase().includes(query);
  });

  let filteredSales = 0;
  gCanteenBookFilteredData.forEach(r => { if (r.category === 'POS Sales') filteredSales += Number(r.debit || 0); });

  const todayEl = document.getElementById('canteen-today-sales');
  const filteredEl = document.getElementById('canteen-filtered-sales');
  const countEl = document.getElementById('canteen-filtered-count');

  if (todayEl) todayEl.textContent = `${todaySales.toLocaleString('en-US')} MMK`;
  if (filteredEl) filteredEl.textContent = `${filteredSales.toLocaleString('en-US')} MMK`;
  if (countEl) countEl.textContent = gCanteenBookFilteredData.length;

  gCanteenPage = 1;
  renderCanteenBookTable();
}

function setFilterCanteenToday() {
  const t = new Date().toISOString().slice(0, 10);
  document.getElementById('canteen-date-from').value = t;
  document.getElementById('canteen-date-to').value = t;
  applyCanteenBookSearchAndRender();
}

function renderCanteenBookTable() {
  const tbody = document.getElementById('canteen-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  
  const total = gCanteenBookFilteredData.length;
  const start = (gCanteenPage - 1) * gCanteenLimit;
  const items = gCanteenBookFilteredData.slice(start, start + gCanteenLimit);

  if (items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" class="text-center py-8 text-slate-500 font-bold">စာရင်း မရှိပါ။</td></tr>`;
    document.getElementById('canteen-pagination-info').textContent = "Showing 0 entries";
    return;
  }

  items.forEach((row, idx) => {
    const displayNo = total - (start + idx);
    const balStr = Number(row.balances || 0).toLocaleString('en-US', {minimumFractionDigits: 2});

    tbody.innerHTML += `
      <tr class="hover:bg-slate-800/30 text-slate-300 text-xs border-b border-slate-800/40">
        <td class="text-center font-mono py-3 px-2 font-bold text-slate-400">${displayNo}</td>
        <td class="font-mono text-xs py-3 px-2">${esc(row.date)}</td>
        <td class="py-3 px-2 font-bold text-emerald-400">${esc(row.category)}</td>
        <td class="py-3 px-2 truncate max-w-xs" title="${esc(row.description)}">${esc(row.description || '')}</td>
        <td class="py-3 px-2">${esc(row.method)}</td>
        <td class="text-right font-mono text-emerald-400 py-3 px-2">${row.debit > 0 ? Number(row.debit).toLocaleString('en-US') : '-'}</td>
        <td class="text-right font-mono text-rose-400 py-3 px-2">${row.credit > 0 ? Number(row.credit).toLocaleString('en-US') : '-'}</td>
        <td class="text-right font-mono text-indigo-400 font-bold py-3 px-2">${balStr}</td>
        <td class="font-mono text-slate-500 py-3 px-2">${esc(row.vrNo || '-')}</td>
        <td class="font-mono text-slate-500 py-3 px-2">${esc(row.fy)}</td>
        <td class="text-center right-0 sticky bg-[#0c1322] py-3 px-2">
          <button onclick="deleteCanteenBookEntry('${escAttr(row.uniqueId)}')" class="text-rose-400 hover:text-rose-300"><i class="fa-solid fa-trash"></i></button>
        </td>
      </tr>
    `;
  });
  document.getElementById('canteen-pagination-info').textContent = `Showing ${start + 1} to ${Math.min(start + gCanteenLimit, total)} of ${total} entries`;
  
  const prevBtn = document.getElementById('canteen-btn-prev');
  const nextBtn = document.getElementById('canteen-btn-next');
  if (prevBtn) prevBtn.disabled = (gCanteenPage <= 1);
  if (nextBtn) nextBtn.disabled = (start + gCanteenLimit >= total);
}

function onSearchInputCanteenBook() { clearTimeout(searchTimeout); searchTimeout = setTimeout(applyCanteenBookSearchAndRender, 150); }
function clearDateFilterCanteenBook() { document.getElementById('canteen-date-from').value = ''; document.getElementById('canteen-date-to').value = ''; applyCanteenBookSearchAndRender(); }
function changePageCanteenBook(delta) { gCanteenPage += delta; renderCanteenBookTable(); }

async function deleteCanteenBookEntry(uniqueId) {
  if (!confirm("ဖျက်မည်မှာ သေချာပါသလား?")) return;
  if (typeof toggleLoading === 'function') toggleLoading(true);
  try {
    const res = await callApi('deleteCanteenBookEntry', { uniqueId });
    if (res && res.success) loadCanteenBookData(false);
  } catch (err) {} finally { if (typeof toggleLoading === 'function') toggleLoading(false); }
}

function exportToCSVCanteenBook() {
  if (!gCanteenBookData || gCanteenBookData.length === 0) return showToast("ERROR", "ထုတ်ယူရန် စာရင်း မရှိပါ။");
  let csv = "NO,DATE,CATEGORY,DESCRIPTION,METHOD,DEBIT,CREDIT,BALANCES,VR_NO,FY\n";
  const safeCell = window.safeCsvCell || (s => `"${String(s || '').replace(/"/g, '""')}"`);
  gCanteenBookData.forEach((r, idx) => {
    csv += `${idx + 1},${safeCell(r.date || '')},${safeCell(r.category || '')},${safeCell(r.description || '')},${safeCell(r.method || '')},${r.debit || 0},${r.credit || 0},${r.balances || 0},${safeCell(r.vrNo || '')},${safeCell(r.fy || '')}\n`;
  });
  const blob = new Blob(["\uFEFF" + csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `Canteen_Book_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

// ==============================================================================
// 💡 4. PM CASHIER BOOK
// ==============================================================================
async function loadPmCashierBookData(isSilent) {
  try {
    if (!isSilent && typeof toggleLoading === 'function') toggleLoading(true);
    const res = await callApi('getPmCashierBookData', { forceRefresh: true }, 'GET');
    if (res && res.success) {
      gPmCashierBookData = res.data || [];

      let totDeb = 0, totCred = 0;
      let c1Deb = 0, c1Cred = 0;
      let c2Deb = 0, c2Cred = 0;

      gPmCashierBookData.forEach(r => {
        const d = Number(r.debit || 0);
        const c = Number(r.credit || 0);
        totDeb += d;
        totCred += c;

        const resp = String(r.responsibility_person || '').trim().toLowerCase();
        if (resp.includes('1') || resp.includes('၁')) {
          c1Deb += d;
          c1Cred += c;
        } else if (resp.includes('2') || resp.includes('၂')) {
          c2Deb += d;
          c2Cred += c;
        }
      });

      const totBal = totDeb - totCred;
      const c1Bal = c1Deb - c1Cred;
      const c2Bal = c2Deb - c2Cred;

      const c1BalEl = document.getElementById('pm-c1-balance');
      const c1InEl = document.getElementById('pm-c1-in');
      const c1OutEl = document.getElementById('pm-c1-out');
      if (c1BalEl) c1BalEl.textContent = `${c1Bal.toLocaleString('en-US')} MMK`;
      if (c1InEl) c1InEl.textContent = c1Deb.toLocaleString('en-US');
      if (c1OutEl) c1OutEl.textContent = c1Cred.toLocaleString('en-US');

      const c2BalEl = document.getElementById('pm-c2-balance');
      const c2InEl = document.getElementById('pm-c2-in');
      const c2OutEl = document.getElementById('pm-c2-out');
      if (c2BalEl) c2BalEl.textContent = `${c2Bal.toLocaleString('en-US')} MMK`;
      if (c2InEl) c2InEl.textContent = c2Deb.toLocaleString('en-US');
      if (c2OutEl) c2OutEl.textContent = c2Cred.toLocaleString('en-US');

      const totHandCashEl = document.getElementById('pm-total-hand-cash');
      const totInEl = document.getElementById('pm-total-in');
      const totOutEl = document.getElementById('pm-total-out');
      if (totHandCashEl) totHandCashEl.textContent = `${totBal.toLocaleString('en-US')} MMK`;
      if (totInEl) totInEl.textContent = totDeb.toLocaleString('en-US');
      if (totOutEl) totOutEl.textContent = totCred.toLocaleString('en-US');

      const entriesEl = document.getElementById('pm-cashier-entries-count');
      if (entriesEl) entriesEl.textContent = Number(gPmCashierBookData.length).toLocaleString('en-US');

      applyPmCashierBookSearchAndRender();
    }
  } catch (err) {
    console.error("PM Cashier Load Error:", err);
  } finally { 
    if (!isSilent && typeof toggleLoading === 'function') toggleLoading(false); 
  }
}

function applyPmCashierBookSearchAndRender() {
  const query = (document.getElementById('pm-cashier-search')?.value || '').trim().toLowerCase();
  const fDate = document.getElementById('pm-cashier-date-from')?.value || '';
  const tDate = document.getElementById('pm-cashier-date-to')?.value || '';
  const respFilter = document.getElementById('pm-cashier-resp-filter')?.value || '';

  gPmCashierBookFilteredData = gPmCashierBookData.filter(row => {
    if (typeof window.isDateInRange === 'function' && !window.isDateInRange(row.date, fDate, tDate)) return false;
    if (respFilter && row.responsibility_person !== respFilter) return false;
    if (!query) return true;
    return String(row.description || '').toLowerCase().includes(query) || 
           String(row.vrNo || '').toLowerCase().includes(query) ||
           String(row.responsibility_person || '').toLowerCase().includes(query);
  });

  gPmCashierPage = 1;
  renderPmCashierBookTable();
}

function renderPmCashierBookTable() {
  const tbody = document.getElementById('pm-cashier-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  
  const total = gPmCashierBookFilteredData.length;
  const start = (gPmCashierPage - 1) * gPmCashierLimit;
  const items = gPmCashierBookFilteredData.slice(start, start + gPmCashierLimit);

  if (items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="12" class="text-center py-8 text-slate-500 font-bold">စာရင်း မရှိပါ။</td></tr>`;
    const info = document.getElementById('pm-cashier-pagination-info');
    if (info) info.textContent = "Showing 0 entries";
    return;
  }

  items.forEach((row, idx) => {
    const displayNo = total - (start + idx);
    const balStr = Number(row.balances || 0).toLocaleString('en-US', {minimumFractionDigits: 2});
    const isXfer = row.category === 'Float Receive' || row.category === 'Return to Finance';

    tbody.innerHTML += `
      <tr class="hover:bg-slate-800/30 text-slate-300 text-xs border-b border-slate-800/40">
        <td class="text-center font-mono py-3 px-2 font-bold text-slate-400">${displayNo}</td>
        <td class="font-mono text-xs py-3 px-2">${esc(row.date)}</td>
        <td class="font-bold text-sky-400 py-3 px-2">${esc(row.responsibility_person || '-')}</td>
        <td class="py-3 px-2 font-semibold">${esc(row.category)}</td>
        <td class="py-3 px-2 truncate max-w-xs" title="${esc(row.description)}">${esc(row.description || '')}</td>
        <td class="py-3 px-2">${esc(row.method)}</td>
        <td class="text-right font-mono text-emerald-400 py-3 px-2">${row.debit > 0 ? Number(row.debit).toLocaleString('en-US') : '-'}</td>
        <td class="text-right font-mono text-rose-400 py-3 px-2">${row.credit > 0 ? Number(row.credit).toLocaleString('en-US') : '-'}</td>
        <td class="text-right font-mono text-indigo-400 font-bold py-3 px-2">${balStr}</td>
        <td class="font-mono text-slate-500 py-3 px-2">${esc(row.vrNo || '-')}</td>
        <td class="font-mono text-slate-500 py-3 px-2">${esc(row.fy)}</td>
        <td class="text-center right-0 sticky bg-[#0c1322] border-l border-slate-800 py-3 px-2">
          <div class="flex justify-center items-center gap-2">
            ${isXfer 
              ? `<button onclick="printRowTransferVoucher('${escAttr(row.uniqueId)}', 'cashier')" class="p-1 text-sky-400 hover:text-sky-300 transition" title="Print Voucher"><i class="fa-solid fa-print"></i></button>`
              : ''}
            <button onclick="deletePmCashierBookEntry('${escAttr(row.uniqueId)}')" class="p-1 text-rose-400 hover:text-rose-300 transition" title="Delete"><i class="fa-solid fa-trash"></i></button>
          </div>
        </td>
      </tr>
    `;
  });
  
  const info = document.getElementById('pm-cashier-pagination-info');
  if (info) info.textContent = `Showing ${start + 1} to ${Math.min(start + gPmCashierLimit, total)} of ${total} entries`;
  
  const prevBtn = document.getElementById('pm-cashier-btn-prev');
  const nextBtn = document.getElementById('pm-cashier-btn-next');
  if (prevBtn) prevBtn.disabled = (gPmCashierPage <= 1);
  if (nextBtn) nextBtn.disabled = (start + gPmCashierLimit >= total);
}

function onSearchInputPmCashierBook() { clearTimeout(searchTimeout); searchTimeout = setTimeout(applyPmCashierBookSearchAndRender, 150); }
function onPmCashierFilterChange() { applyPmCashierBookSearchAndRender(); }
function clearDateFilterPmCashierBook() { document.getElementById('pm-cashier-date-from').value = ''; document.getElementById('pm-cashier-date-to').value = ''; applyPmCashierBookSearchAndRender(); }
function changePagePmCashierBook(delta) { gPmCashierPage += delta; renderPmCashierBookTable(); }

function openAddModalPmCashierBook() {
  const form = document.getElementById('pm-cashier-form');
  if (form) form.reset();

  const uid = document.getElementById('pm-cashier-uniqueId');
  if (uid) uid.value = '';

  const dateEl = document.getElementById('pm-cashier-date');
  if (dateEl) dateEl.value = new Date().toISOString().slice(0, 10);

  const badge = document.getElementById('pm-student-wallet-badge');
  if (badge) badge.classList.add('hidden');

  onPmCashierCategoryChange();
  document.getElementById('pm-cashier-modal')?.classList.remove('hidden');
}

function closePmCashierBookModal() { 
  document.getElementById('pm-cashier-modal')?.classList.add('hidden'); 
}

function onPmCashierCategoryChange() {
  const cat = document.getElementById('pm-cashier-category')?.value || 'PM Withdraw';
  const stuBox = document.getElementById('pm-student-lookup-container');
  const desc = document.getElementById('pm-cashier-description');

  if (cat === 'Return to Finance') {
    if (stuBox) stuBox.classList.add('hidden');
    if (desc) desc.value = "PM Cashier မှ Finance သို့ လက်ကျန်ငွေ ပြန်လည်အပ်နှံခြင်း";
  } else {
    if (stuBox) stuBox.classList.remove('hidden');
    if (desc) desc.value = "";
  }
}

async function onPmStudentLookup() {
  const idVal = document.getElementById('pm-student-id-search')?.value.trim();
  const fyidShow = document.getElementById('pm-student-fyid');
  const nameShow = document.getElementById('pm-student-name');
  const classShow = document.getElementById('pm-student-class');
  const badge = document.getElementById('pm-student-wallet-badge');
  const balEl = document.getElementById('pm-student-wallet-bal');
  const desc = document.getElementById('pm-cashier-description');

  if (!idVal) {
    if (fyidShow) fyidShow.value = '';
    if (nameShow) nameShow.value = '';
    if (classShow) classShow.value = '';
    if (badge) badge.classList.add('hidden');
    return;
  }

  const targetId = parseInt(idVal, 10);
  const fyVal = typeof window.getCurrentAcademicYear === 'function' ? window.getCurrentAcademicYear() : '2026-2027';

  if (!gStudentCacheForMoney[fyVal]) {
    try {
      const res = await callApi('getStudentData', { fy: fyVal, limit: 5000 }, 'GET');
      if (res && res.success) gStudentCacheForMoney[fyVal] = res.data || [];
    } catch (e) {}
  }

  const list = gStudentCacheForMoney[fyVal] || [];
  let matched = list.find(s => parseInt(s.studentId || s.student_id || s.id, 10) === targetId);

  if (!matched) {
    try {
      const singleRes = await callApi('lookupStudentById', { studentId: targetId, fy: fyVal }, 'GET');
      if (singleRes && singleRes.success && singleRes.data) matched = singleRes.data;
    } catch (e) {}
  }

  if (matched) {
    const cleanFyid = typeof window.sanitizeFyidStr === 'function' ? window.sanitizeFyidStr(matched.fyid || '') : (matched.fyid || '');
    const actualName = matched.name || matched.fyidName || '';

    if (fyidShow) fyidShow.value = cleanFyid;
    if (nameShow) nameShow.value = actualName;
    if (classShow) classShow.value = matched.class || '';
    if (desc && !desc.value) desc.value = `[${cleanFyid}] ${actualName} - မုန့်ဖိုးထုတ်ပေးငွေ`;

    try {
      const sumRes = await callApi('getStudentMoneySummary', { fy: fyVal, searchVal: cleanFyid }, 'GET');
      if (sumRes && sumRes.success && sumRes.data && sumRes.data.length > 0) {
        const stu = sumRes.data.find(r => r.studentId === targetId);
        if (stu && balEl && badge) {
          balEl.textContent = `${Number(stu.netBalance || 0).toLocaleString('en-US')} MMK`;
          badge.classList.remove('hidden');
        }
      } else {
        if (balEl && badge) {
          balEl.textContent = "0 MMK";
          badge.classList.remove('hidden');
        }
      }
    } catch (e) {}
  } else {
    if (fyidShow) fyidShow.value = "Not Found";
    if (nameShow) nameShow.value = "ကျောင်းသား ရှာမတွေ့ပါ";
    if (classShow) classShow.value = "";
    if (badge) badge.classList.add('hidden');
  }
}

// 🎯 ZERO-FREEZE PM CASHIER FORM SUBMISSION
async function savePmCashierBookForm(e) {
  if (e && e.preventDefault) e.preventDefault();
  if (isSubmitting) return;

  const category = document.getElementById('pm-cashier-category')?.value || 'PM Withdraw';
  const credit = parseFloat(document.getElementById('pm-cashier-credit')?.value || 0);
  const studentId = parseInt(document.getElementById('pm-student-id-search')?.value, 10) || 0;
  const respPerson = document.getElementById('pm-cashier-responsibility-person')?.value || 'Cashier 1';

  // 1. Basic Field Validations (Before Closing Modal)
  if (category === 'PM Withdraw' && (!studentId || credit <= 0)) {
    return showToast("ERROR", "ကျောင်းသား ID နှင့် ထုတ်ပေးငွေ ထည့်ပါ။");
  }

  if (category === 'Return to Finance' && credit <= 0) {
    return showToast("ERROR", "Finance သို့ ပြန်လွှဲမည့် ငွေပမာဏ ထည့်သွင်းပါ။");
  }

  // 2. Cashier Float Balance Guard
  const c1Text = document.getElementById('pm-c1-balance')?.textContent || '0';
  const c2Text = document.getElementById('pm-c2-balance')?.textContent || '0';
  const c1Bal = parseFloat(c1Text.replace(/[^0-9.-]+/g, "")) || 0;
  const c2Bal = parseFloat(c2Text.replace(/[^0-9.-]+/g, "")) || 0;
  const targetBal = (respPerson === 'Cashier 1') ? c1Bal : c2Bal;

  if (credit > targetBal) {
    return showToast("ERROR", `${respPerson} တွင် လက်ကျန်ငွေ (${targetBal.toLocaleString()} MMK) သာ ရှိသဖြင့် (${credit.toLocaleString()} MMK) ထုတ်ယူ/ပြန်လွှဲခွင့် မပြုပါ!`);
  }

  // 3. Student Overdraft Guard
  if (category === 'PM Withdraw') {
    const stuBalText = document.getElementById('pm-student-wallet-bal')?.textContent || '0';
    const stuBal = parseFloat(stuBalText.replace(/[^0-9.-]+/g, "")) || 0;
    if (credit > stuBal) {
      return showToast("ERROR", `ကျောင်းသားတွင် လက်ရှိမုန့်ဖိုးလက်ကျန် (${stuBal.toLocaleString()} MMK) သာ ရှိသဖြင့် (${credit.toLocaleString()} MMK) ထုတ်ပေးခွင့် မပြုပါ!`);
    }
  }

  // 4. Validations Passed: Safely Lock & Proceed
  isSubmitting = true;
  closePmCashierBookModal();
  if (typeof toggleLoading === 'function') toggleLoading(true);

  const payload = {
    date: document.getElementById('pm-cashier-date')?.value || new Date().toISOString().slice(0, 10),
    category: category,
    studentId: category === 'PM Withdraw' ? studentId : null,
    studentName: document.getElementById('pm-student-name')?.value || '',
    fyid: document.getElementById('pm-student-fyid')?.value || '',
    studentClass: document.getElementById('pm-student-class')?.value || '',
    responsibilityPerson: respPerson,
    method: document.getElementById('pm-cashier-method')?.value || 'Cash',
    debit: 0,
    credit: credit,
    description: document.getElementById('pm-cashier-description')?.value || ''
  };

  try {
    const res = await callApi('savePmCashierBookEntry', payload);
    if (res && res.success) {
      showToast('SUCCESS', category === 'Return to Finance' 
        ? 'Finance သို့ လက်ကျန်ငွေ ပြန်လည်အပ်နှံပြီးပါပြီ။' 
        : 'မုန့်ဖိုးထုတ်ပေးပြီးပါပြီ။');
      loadPmCashierBookData(false);
      loadStudentMoneyData(false);
    } else { 
      showToast('ERROR', res?.message || 'သိမ်းဆည်းမှု မအောင်မြင်ပါ။'); 
    }
  } catch (err) { 
    showToast('ERROR', err.message); 
  } finally { 
    isSubmitting = false; 
    if (typeof toggleLoading === 'function') toggleLoading(false); 
  }
}

async function deletePmCashierBookEntry(uniqueId) {
  if (!confirm("ဤစာရင်းအား ဖျက်ပါက Student Money စာအုပ်ရှိ ကျောင်းသားလက်ကျန်ပါ အလိုအလျောက် ပြန်လည်ညှိသွားပါမည်။ သေချာပါသလား?")) return;
  if (typeof toggleLoading === 'function') toggleLoading(true);
  try {
    const res = await callApi('deletePmCashierBookEntry', { uniqueId });
    if (res && res.success) {
      showToast('SUCCESS', 'စာရင်းအားလုံးမှ ချိတ်ဆက်ဖျက်သိမ်းပြီးပါပြီ။');
      loadPmCashierBookData(false);
      loadStudentMoneyData(false);
    } else {
      showToast('ERROR', res?.message || 'ဖျက်သိမ်းမှု မအောင်မြင်ပါ။');
    }
  } catch (err) {
    showToast('ERROR', err.message);
  } finally { 
    if (typeof toggleLoading === 'function') toggleLoading(false); 
  }
}

function exportToCSVPmCashierBook() {
  if (!gPmCashierBookData || gPmCashierBookData.length === 0) return showToast("ERROR", "ထုတ်ယူရန် စာရင်း မရှိပါ။");
  let csv = "NO,DATE,RESPONSIBILITY_PERSON,CATEGORY,DESCRIPTION,METHOD,DEBIT,CREDIT,BALANCES,VR_NO,FY\n";
  const safeCell = window.safeCsvCell || (s => `"${String(s || '').replace(/"/g, '""')}"`);
  gPmCashierBookData.forEach((r, idx) => {
    csv += `${idx + 1},${safeCell(r.date || '')},${safeCell(r.responsibility_person || '')},${safeCell(r.category || '')},${safeCell(r.description || '')},${safeCell(r.method || '')},${r.debit || 0},${r.credit || 0},${r.balances || 0},${safeCell(r.vrNo || '')},${safeCell(r.fy || '')}\n`;
  });
  const blob = new Blob(["\uFEFF" + csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `PM_Cashier_Book_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}

// ==============================================================================
// 💡 5. RECONCILIATION AUDIT CONTROLLER
// ==============================================================================
async function loadSpmmsReconciliationData() {
  try {
    if (typeof toggleLoading === 'function') toggleLoading(true);
    const res = await callApi('getSpmmsReconciliation', { forceRefresh: true }, 'GET');
    if (res && res.success) {
      const data = res.data;
      
      document.getElementById('rec-total-virtual').textContent = `${Number(data.totalVirtual).toLocaleString('en-US', {minimumFractionDigits:2})} MMK`;
      document.getElementById('rec-total-physical').textContent = `${Number(data.totalPhysicalCash).toLocaleString('en-US', {minimumFractionDigits:2})} MMK`;
      document.getElementById('rec-finance-cash').textContent = `${Number(data.totalFinance).toLocaleString('en-US')} MMK`;
      document.getElementById('rec-cashier-cash').textContent = `${Number(data.totalCashier).toLocaleString('en-US')} MMK`;
      document.getElementById('rec-variance').textContent = `${Number(Math.abs(data.variance)).toLocaleString('en-US', {minimumFractionDigits:2})} MMK`;
      
      document.getElementById('rec-eq-virtual').textContent = `${Number(data.totalVirtual).toLocaleString('en-US')} MMK`;
      document.getElementById('rec-eq-finance').textContent = `${Number(data.totalFinance).toLocaleString('en-US')} MMK`;
      document.getElementById('rec-eq-cashier').textContent = `${Number(data.totalCashier).toLocaleString('en-US')} MMK`;

      const badge = document.getElementById('rec-status-badge');
      const verdict = document.getElementById('rec-eq-verdict');
      const desc = document.getElementById('rec-status-desc');

      if (data.isMatched) {
        badge.className = "px-2 py-0.5 rounded text-[10px] font-black bg-emerald-500/10 text-emerald-400 border border-emerald-500/20";
        badge.textContent = "MATCHED";
        verdict.className = "text-xs font-mono font-black text-emerald-400 uppercase";
        verdict.textContent = "100% Balanced";
        desc.className = "text-[11px] text-emerald-400";
        desc.textContent = "စာရင်းနှင့် လက်ကျန်ငွေသား အတိအကျ ကိုက်ညီနေပါသည်။";
      } else {
        badge.className = "px-2 py-0.5 rounded text-[10px] font-black bg-rose-500/10 text-rose-400 border border-rose-500/20 animate-pulse";
        badge.textContent = "UNMATCHED";
        verdict.className = "text-xs font-mono font-black text-rose-400 uppercase";
        verdict.textContent = "Imbalanced!";
        desc.className = "text-[11px] text-rose-400";
        desc.textContent = "သတိပြုရန်! စာရင်းနှင့် ငွေသား ကိုက်ညီမှု မရှိပါ။";
      }
    }
  } catch (err) {
    console.error("Reconciliation Error:", err);
  } finally { 
    if (typeof toggleLoading === 'function') toggleLoading(false); 
  }
}

// ==============================================================================
// 💡 6. STATEMENT TIMELINE MODAL (SERVER-SIDE PAGINATION)
// ==============================================================================
async function openStudentStatementModal(studentId) {
  if (!studentId) return;
  gStmtStudentId = studentId;
  gStmtPage = 1;

  const fromEl = document.getElementById('stm-stmt-date-from');
  const toEl = document.getElementById('stm-stmt-date-to');
  if (fromEl) fromEl.value = '';
  if (toEl) toEl.value = '';

  document.getElementById('stm-statement-modal')?.classList.remove('hidden');
  await loadStudentStatementData();
}

// ==============================================================================
// 💡 STATEMENT DATA LOADER (ENTERPRISE EDITION WITH ZERO-RECORD HEADER GUARD)
// ==============================================================================
async function loadStudentStatementData() {
  if (!gStmtStudentId) return;

  const dateFrom = document.getElementById('stm-stmt-date-from')?.value || '';
  const dateTo = document.getElementById('stm-stmt-date-to')?.value || '';
  const nameEl = document.getElementById('stm-stmt-student-name');
  const infoEl = document.getElementById('stm-stmt-student-info');

  try {
    if (typeof toggleLoading === 'function') toggleLoading(true);

    // 🚀 D1 Quota Optimized: Read strictly 20 rows per page
    const res = await callApi('getStudentMoneyData', {
      studentId: gStmtStudentId,
      page: gStmtPage,
      limit: gStmtLimit,
      dateFrom,
      dateTo,
      forceRefresh: true
    }, 'GET');

    if (res && res.success) {
      const records = res.data || [];
      gStmtTotalRows = res.totalRows || 0;

      // 🎯 1. HEADER PRESERVATION GUARD: Record မရှိသည့် ရက်စွဲစစ်ချိန်တွင်လည်း ကျောင်းသားအမည် မပျောက်စေရန် စီမံခြင်း
      if (records.length > 0) {
        const firstRow = records[0];
        if (nameEl) nameEl.textContent = `${firstRow.fyidName || firstRow.fyid || 'Student'} - Pocket Money Statement`;
        if (infoEl) infoEl.textContent = `FY: ${firstRow.fy || '-'} | Class: ${firstRow.class || '-'} | ID: ${firstRow.studentId || gStmtStudentId}`;
      } else {
        // စာရင်းမရှိပါက Cache သို့မဟုတ် Single Lookup မှတစ်ဆင့် ကျောင်းသားအချက်အလက်ကို ဆွဲတင်ထိန်းသိမ်းခြင်း
        const currentFy = (typeof window.getCurrentAcademicYear === 'function') ? window.getCurrentAcademicYear() : '2026-2027';
        const cacheList = gStudentCacheForMoney[currentFy] || [];
        const cachedStu = cacheList.find(s => parseInt(s.studentId || s.student_id || s.id, 10) === parseInt(gStmtStudentId, 10));

        if (cachedStu) {
          const cleanFyid = typeof window.sanitizeFyidStr === 'function' ? window.sanitizeFyidStr(cachedStu.fyid) : (cachedStu.fyid || '');
          if (nameEl) nameEl.textContent = `[${cleanFyid}] ${cachedStu.name || 'Student'} - Pocket Money Statement`;
          if (infoEl) infoEl.textContent = `FY: ${currentFy} | Class: ${cachedStu.class || '-'} | ID: ${gStmtStudentId}`;
        } else if (nameEl && !nameEl.textContent.includes('Statement')) {
          if (nameEl) nameEl.textContent = `Student ID: ${gStmtStudentId} - Pocket Money Statement`;
          if (infoEl) infoEl.textContent = `FY: ${currentFy} | ID: ${gStmtStudentId}`;
        }
      }

      // 🎯 2. PLAN 3 ACCOUNTING STATS MAPPING
      const stats = res.stats || {};
      const depEl = document.getElementById('stm-stmt-total-deposit');
      const withEl = document.getElementById('stm-stmt-total-withdraw');
      const balEl = document.getElementById('stm-stmt-current-balance');

      const periodIncome = Number(stats.totalIncome || 0);
      const periodExpense = Number(stats.totalExpense || 0);
      const allTimeBal = Number(stats.balance || 0);

      if (depEl) depEl.textContent = `${periodIncome.toLocaleString('en-US')} MMK`;
      if (withEl) withEl.textContent = `${periodExpense.toLocaleString('en-US')} MMK`;
      if (balEl) balEl.textContent = `${allTimeBal.toLocaleString('en-US')} MMK`;

      // 🎯 3. TABLE BODY RENDERING (WITH EXACT ESCAPING & ROW NUMBERING)
      const tbody = document.getElementById('stm-stmt-table-body');
      if (tbody) {
        tbody.innerHTML = '';
        if (records.length === 0) {
          tbody.innerHTML = `
            <tr>
              <td colspan="7" class="text-center py-8 text-slate-500 font-bold">
                <i class="fa-solid fa-calendar-xmark text-slate-600 text-base mb-1 block"></i>
                ရွေးချယ်ထားသော ရက်အတွင်း မှတ်တမ်း မရှိပါ။
              </td>
            </tr>
          `;
        } else {
          const safeEsc = window.escapeHtml || (s => s ? String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) : '');

          records.forEach((r, idx) => {
            // အသစ်ဆုံးစာရင်းအား နံပါတ်အကြီးဆုံးဖြင့် စဉ်ပြသခြင်း
            const displayNo = gStmtTotalRows - ((gStmtPage - 1) * gStmtLimit + idx);
            const balStr = Number(r.balances || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });
            const deb = Number(r.debit || 0);
            const cred = Number(r.credit || 0);

            tbody.innerHTML += `
              <tr class="hover:bg-slate-800/30 text-xs border-b border-slate-800/30 transition-colors">
                <td class="text-center font-mono py-2.5 px-3 font-bold text-slate-400">${displayNo}</td>
                <td class="font-mono py-2.5 px-3 text-slate-300">${safeEsc(r.date)}</td>
                <td class="py-2.5 px-3 font-semibold text-slate-300">${safeEsc(r.method || 'Cash')}</td>
                <td class="text-right font-mono font-bold text-emerald-400 py-2.5 px-3">${deb > 0 ? deb.toLocaleString('en-US') : '-'}</td>
                <td class="text-right font-mono font-bold text-rose-400 py-2.5 px-3">${cred > 0 ? cred.toLocaleString('en-US') : '-'}</td>
                <td class="text-right font-mono font-bold text-indigo-400 py-2.5 px-3">${balStr}</td>
                <td class="py-2.5 px-3 text-slate-400 truncate max-w-xs" title="${safeEsc(r.remark)}">${safeEsc(r.remark || '-')}</td>
              </tr>
            `;
          });
        }
      }

      // 🎯 4. PAGINATION CONTROLS SYNC
      updateStmtPaginationControls();
    }
  } catch (err) {
    console.error("Statement Load Error:", err);
    if (typeof showToast === 'function') {
      showToast("ERROR", "Statement စာရင်း ဆွဲယူရာတွင် အမှားဖြစ်ပေါ်ခဲ့သည်: " + err.message);
    }
  } finally {
    if (typeof toggleLoading === 'function') toggleLoading(false);
  }
}

function updateStmtPaginationControls() {
  const start = (gStmtPage - 1) * gStmtLimit + 1;
  const end = Math.min(start + gStmtLimit - 1, gStmtTotalRows);
  const infoEl = document.getElementById('stm-stmt-pagination-info');
  if (infoEl) infoEl.textContent = gStmtTotalRows === 0 ? "Showing 0 entries" : `Showing ${start} to ${end} of ${gStmtTotalRows} entries`;

  const prevBtn = document.getElementById('stm-stmt-btn-prev');
  const nextBtn = document.getElementById('stm-stmt-btn-next');
  if (prevBtn) prevBtn.disabled = (gStmtPage <= 1);
  if (nextBtn) nextBtn.disabled = (end >= gStmtTotalRows);
}

function changeStmtPage(delta) { gStmtPage += delta; loadStudentStatementData(); }
function onStmtDateFilterChange() { gStmtPage = 1; loadStudentStatementData(); }
function clearStmtDateFilter() {
  document.getElementById('stm-stmt-date-from').value = '';
  document.getElementById('stm-stmt-date-to').value = '';
  gStmtPage = 1;
  loadStudentStatementData();
}
function closeStudentStatementModal() { document.getElementById('stm-statement-modal')?.classList.add('hidden'); }

// ==============================================================================
// 💡 7. PRINT VOUCHER ENGINE (A4 DUAL COPIES WITH CUT LINE)
// ==============================================================================
function printRowTransferVoucher(uniqueId, source) {
  let row = null;
  let isFromFinance = false;

  if (source === 'main') {
    row = gStudentMoneyHistoryData.find(r => r.uniqueId === uniqueId);
    isFromFinance = row?.fyid === 'TRANSFER';
  } else {
    row = gPmCashierBookData.find(r => r.uniqueId === uniqueId);
    isFromFinance = row?.category === 'Float Receive';
  }

  if (!row) return showToast("ERROR", "ပြေစာထုတ်ရန် အချက်အလက် မတွေ့ပါ။");

  const amount = (row.credit > 0 ? row.credit : row.debit) || 0;
  const vrNo = row.vrNo || 'TRF-' + String(row.date || '').replace(/-/g, '') + '-' + (row.no || '01');
  const dateStr = row.date || new Date().toISOString().slice(0, 10);
  const respPerson = row.responsibility_person || (row.remark?.includes('Cashier 2') ? 'Cashier 2' : 'Cashier 1');
  const method = row.method || 'Cash';
  const remark = row.remark || row.description || 'Internal Cash Transfer';
  const fyStr = row.fy || window.getCurrentAcademicYear();

  let topCopyTitle = isFromFinance ? "FINANCE COPY (ဗဟိုဘဏ္ဍာသိမ်းဆည်းရန်ပြေစာ)" : "FINANCE COPY (ဗဟိုဘဏ္ဍာလက်ခံပြေစာ)";
  let btmCopyTitle = isFromFinance ? "CASHIER COPY (ငွေကိုင်လက်ခံပြေစာ)" : "CASHIER COPY (ငွေကိုင်သိမ်းဆည်းရန်ပြေစာ)";
  let senderRole = isFromFinance ? "Finance Vault (ဗဟိုဘဏ္ဍာ)" : `${respPerson} (မုန့်ဖိုးငွေကိုင်)`;
  let receiverRole = isFromFinance ? `${respPerson} (မုန့်ဖိုးငွေကိုင်)` : "Finance Vault (ဗဟိုဘဏ္ဍာ)";

  const renderSingleSlip = (copyTitle) => `
    <div style="border: 1.5px solid #1e293b; border-radius: 6px; padding: 18px 24px; background: #fff; color: #0f172a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; box-sizing: border-box;">
      <div style="text-align: center; border-bottom: 1.5px solid #0f172a; padding-bottom: 6px; margin-bottom: 12px;">
        <h2 style="margin: 0; font-size: 15px; font-weight: 900; letter-spacing: 0.5px; text-transform: uppercase;">GOLDEN ERP FINANCIAL MANAGEMENT SYSTEM</h2>
        <p style="margin: 3px 0 0 0; font-size: 11px; font-weight: 800; color: #334155; text-decoration: underline;">${copyTitle}</p>
      </div>

      <table style="width: 100%; font-size: 11px; margin-bottom: 10px; border-collapse: collapse;">
        <tr>
          <td style="padding: 2px 0; width: 60%;"><strong>လွှဲပြောင်းပေးသူ :</strong> ${senderRole}</td>
          <td style="padding: 2px 0; text-align: right;"><strong>Date :</strong> ${dateStr}</td>
        </tr>
        <tr>
          <td style="padding: 2px 0;"><strong>လက်ခံရရှိသူ :</strong> ${receiverRole}</td>
          <td style="padding: 2px 0; text-align: right;"><strong>Voucher No :</strong> ${vrNo}</td>
        </tr>
        <tr>
          <td style="padding: 2px 0;"><strong>အမျိုးအစား :</strong> ${isFromFinance ? 'အရင်းငွေလွှဲပြောင်းခြင်း (Float Receive)' : 'လက်ကျန်ငွေပြန်အပ်နှံခြင်း (Return Cash)'}</td>
          <td style="padding: 2px 0; text-align: right;"><strong>FY :</strong> ${fyStr}</td>
        </tr>
      </table>

      <table style="width: 100%; border-collapse: collapse; font-size: 11px; margin-bottom: 10px; border: 1px solid #334155;">
        <thead>
          <tr style="background-color: #f1f5f9; text-align: center; font-weight: 800; border-bottom: 1px solid #334155;">
            <th style="border: 1px solid #334155; padding: 6px; width: 40px;">NO</th>
            <th style="border: 1px solid #334155; padding: 6px; text-align: left;">DESCRIPTION (အကြောင်းအရာ)</th>
            <th style="border: 1px solid #334155; padding: 6px; width: 90px;">METHOD</th>
            <th style="border: 1px solid #334155; padding: 6px; width: 130px; text-align: right;">AMOUNT (ကျပ်)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="border: 1px solid #334155; padding: 8px 6px; text-align: center; font-family: monospace;">1</td>
            <td style="border: 1px solid #334155; padding: 8px 6px;">${remark}</td>
            <td style="border: 1px solid #334155; padding: 8px 6px; text-align: center;">${method}</td>
            <td style="border: 1px solid #334155; padding: 8px 6px; text-align: right; font-family: monospace; font-weight: 800;">${Number(amount).toLocaleString('en-US')} MMK</td>
          </tr>
          <tr style="font-weight: 900; background: #fafafa;">
            <td colspan="3" style="border: 1px solid #334155; padding: 6px; text-align: right;">Total (စုစုပေါင်း) :</td>
            <td style="border: 1px solid #334155; padding: 6px; text-align: right; font-family: monospace; font-size: 12px;">${Number(amount).toLocaleString('en-US')} MMK</td>
          </tr>
        </tbody>
      </table>

      <table style="width: 100%; font-size: 10px; font-weight: 800; margin-top: 35px; text-align: center;">
        <tr>
          <td style="width: 45%;">
            <div style="border-top: 1.5px dashed #475569; width: 85%; margin: 0 auto 4px auto;"></div>
            Received By (ငွေလက်ခံသူ)
          </td>
          <td style="width: 10%;"></td>
          <td style="width: 45%;">
            <div style="border-top: 1.5px dashed #475569; width: 85%; margin: 0 auto 4px auto;"></div>
            Handed Over By (ငွေလွှဲပေးသူ)
          </td>
        </tr>
      </table>
    </div>
  `;

  const fullPrintHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Print Transfer Voucher - ${vrNo}</title>
      <style>
        @page { size: A4 portrait; margin: 10mm 12mm; }
        body { margin: 0; padding: 0; font-family: sans-serif; background: #fff; }
        .cut-line { text-align: center; font-size: 10px; color: #64748b; font-family: monospace; margin: 12px 0; letter-spacing: 2px; }
      </style>
    </head>
    <body>
      ${renderSingleSlip(topCopyTitle)}
      <div class="cut-line">✂ - - - - - - - - - - - - - - - - - - - - - Cut Here - - - - - - - - - - - - - - - - - - - - - ✂</div>
      ${renderSingleSlip(btmCopyTitle)}
    </body>
    </html>
  `;

  const printWindow = window.open('', '_blank', 'width=850,height=950');
  if (!printWindow) return showToast("ERROR", "Browser မှ Pop-up ပိတ်ထားသဖြင့် Print Window မဖွင့်နိုင်ပါ။");
  
  printWindow.document.write(fullPrintHtml);
  printWindow.document.close();
  setTimeout(() => { printWindow.focus(); printWindow.print(); printWindow.close(); }, 400);
}

// ==============================================================================
// 💡 8. HIGH-CONTRAST TOAST NOTIFICATION (SCREEN CENTER)
// ==============================================================================
window.showToast = function(type, message) {
  const oldToast = document.getElementById('global-center-toast-wrapper');
  if (oldToast) oldToast.remove();

  const wrapper = document.createElement('div');
  wrapper.id = 'global-center-toast-wrapper';
  wrapper.className = 'fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[999999] pointer-events-none flex flex-col items-center justify-center w-full max-w-md px-4';

  const isSuccess = (String(type).toUpperCase() === 'SUCCESS');
  const toast = document.createElement('div');
  toast.className = `pointer-events-auto flex items-center gap-4 px-6 py-4 rounded-2xl shadow-2xl border-2 backdrop-blur-xl transition-all duration-300 transform scale-90 opacity-0 ${
    isSuccess
      ? 'bg-[#061e18]/95 border-emerald-400 text-white shadow-[0_0_50px_rgba(16,185,129,0.4)] ring-4 ring-emerald-500/20'
      : 'bg-[#2a080c]/95 border-rose-500 text-white shadow-[0_0_50px_rgba(244,63,94,0.4)] ring-4 ring-rose-500/20'
  }`;

  const iconHtml = isSuccess
    ? '<div class="p-3 rounded-xl bg-emerald-500/20 text-emerald-400 border border-emerald-400/30 text-2xl shrink-0"><i class="fa-solid fa-circle-check"></i></div>'
    : '<div class="p-3 rounded-xl bg-rose-500/20 text-rose-400 border border-rose-500/30 text-2xl shrink-0 animate-bounce"><i class="fa-solid fa-triangle-exclamation"></i></div>';

  const titleText = isSuccess ? 'ACTION SUCCESSFUL' : 'ACTION DENIED / ERROR';
  const titleColor = isSuccess ? 'text-emerald-400' : 'text-rose-400';

  toast.innerHTML = `
    ${iconHtml}
    <div class="flex-1 min-w-0 pr-2">
      <span class="block uppercase text-[10px] tracking-widest font-black ${titleColor} mb-0.5">${titleText}</span>
      <p class="text-xs font-bold text-slate-100 leading-snug break-words">${message}</p>
    </div>
    <button onclick="dismissCenterToast()" class="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-white/10 transition shrink-0">
      <i class="fa-solid fa-xmark text-sm"></i>
    </button>
  `;

  wrapper.appendChild(toast);
  document.body.appendChild(wrapper);

  requestAnimationFrame(() => {
    toast.classList.remove('scale-90', 'opacity-0');
    toast.classList.add('scale-100', 'opacity-100');
  });

  window.toastDismissTimer = setTimeout(dismissCenterToast, 3500);
};

window.dismissCenterToast = function() {
  clearTimeout(window.toastDismissTimer);
  const wrapper = document.getElementById('global-center-toast-wrapper');
  if (!wrapper) return;
  const toast = wrapper.firstElementChild;
  if (toast) {
    toast.classList.remove('scale-100', 'opacity-100');
    toast.classList.add('scale-90', 'opacity-0');
  }
  setTimeout(() => wrapper.remove(), 250);
};

// ==============================================================================
// 💡 GLOBAL EXPORTS (CLEAN & NON-DUPLICATE)
// ==============================================================================
window.switchStudentMoneySubTab = switchStudentMoneySubTab;
window.loadStudentMoneyData = loadStudentMoneyData;
window.onSearchInputStudentMoney = onSearchInputStudentMoney;
window.clearDateFilterStudentMoney = clearDateFilterStudentMoney;
window.changePageStudentMoney = changePageStudentMoney;
window.openAddModalStudentMoney = openAddModalStudentMoney;
window.closeStudentMoneyModal = closeStudentMoneyModal;
window.onStudentMoneyEntryTypeChange = onStudentMoneyEntryTypeChange;
window.onStudentIdOrFYChangeMoney = onStudentIdOrFYChangeMoney;
window.saveStudentMoneyForm = saveStudentMoneyForm;
window.deleteStudentMoneyEntry = deleteStudentMoneyEntry;
window.exportToCSVStudentMoney = exportToCSVStudentMoney;

window.loadCanteenBookData = loadCanteenBookData;
window.onSearchInputCanteenBook = onSearchInputCanteenBook;
window.clearDateFilterCanteenBook = clearDateFilterCanteenBook;
window.changePageCanteenBook = changePageCanteenBook;
window.setFilterCanteenToday = setFilterCanteenToday;
window.deleteCanteenBookEntry = deleteCanteenBookEntry;
window.exportToCSVCanteenBook = exportToCSVCanteenBook;

window.loadPmCashierBookData = loadPmCashierBookData;
window.onSearchInputPmCashierBook = onSearchInputPmCashierBook;
window.clearDateFilterPmCashierBook = clearDateFilterPmCashierBook;
window.changePagePmCashierBook = changePagePmCashierBook;
window.onPmCashierFilterChange = onPmCashierFilterChange;
window.openAddModalPmCashierBook = openAddModalPmCashierBook;
window.closePmCashierBookModal = closePmCashierBookModal;
window.onPmCashierCategoryChange = onPmCashierCategoryChange;
window.onPmStudentLookup = onPmStudentLookup;
window.savePmCashierBookForm = savePmCashierBookForm;
window.deletePmCashierBookEntry = deletePmCashierBookEntry;
window.exportToCSVPmCashierBook = exportToCSVPmCashierBook;

window.loadSpmmsReconciliationData = loadSpmmsReconciliationData;
window.openStudentStatementModal = openStudentStatementModal;
window.closeStudentStatementModal = closeStudentStatementModal;
window.changeStmtPage = changeStmtPage;
window.onStmtDateFilterChange = onStmtDateFilterChange;
window.clearStmtDateFilter = clearStmtDateFilter;

window.onDebitInputStudentMoney = onDebitInputStudentMoney;
window.onCreditInputStudentMoney = onCreditInputStudentMoney;

window.printRowTransferVoucher = printRowTransferVoucher;