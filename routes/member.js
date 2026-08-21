const express = require('express');
const db = require('../db');
const { requireMember } = require('../middleware/auth');
const router = express.Router();

router.use(requireMember);

router.get('/', async (req, res) => {
  const memberId = req.session.user.memberId;

  const balances = await db.prepare(`
    SELECT f.name, f.id as fund_id, COALESCE(mb.balance, 0) as balance
    FROM fund_types f
    LEFT JOIN member_balances mb ON mb.fund_type_id = f.id AND mb.member_id = ?
    ORDER BY f.id
  `).all(memberId);

  const totalSavingsDev = balances.filter(b => b.name === 'Savings' || b.name === 'Development').reduce((s, b) => s + b.balance, 0);

  const activeLoan = await db.prepare("SELECT * FROM loans WHERE member_id = ? AND status IN ('active', 'defaulted') AND (amount_due - paid_amount) > 0 ORDER BY created_at DESC LIMIT 1").get(memberId);

  const recentContributions = await db.prepare(`
    SELECT c.amount, f.name as fund, cy.start_date, cy.end_date, c.status
    FROM contributions c
    JOIN fund_types f ON c.fund_type_id = f.id
    JOIN cycles cy ON c.cycle_id = cy.id
    WHERE c.member_id = ?
    ORDER BY c.created_at DESC LIMIT 10
  `).all(memberId);

  const currentCycle = await db.prepare('SELECT * FROM cycles WHERE is_open = 1 AND is_processed = 0 ORDER BY start_date DESC LIMIT 1').get();

  let hasContributed = false;
  if (currentCycle) {
    const contrib = await db.prepare('SELECT COUNT(*) as c FROM contributions WHERE member_id = ? AND cycle_id = ?').get(memberId, currentCycle.id);
    hasContributed = contrib.c > 0;
  }

  const pendingContribs = (await db.prepare("SELECT COUNT(*) as c FROM contributions WHERE member_id = ? AND status = 'pending'").get(memberId)).c;
  const pendingLoan = (await db.prepare("SELECT COUNT(*) as c FROM loans WHERE member_id = ? AND status = 'pending'").get(memberId)).c;

  const totalFines = (await db.prepare("SELECT COALESCE(SUM(balance),0) as t FROM fines WHERE member_id = ? AND status = 'pending'").get(memberId)).t;
  const card = await db.prepare("SELECT * FROM member_cards WHERE member_id = ?").get(memberId);
  const cardBalance = card ? card.assigned_amount - card.paid_amount : 0;
  const pendingFinePayments = (await db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM payment_requests WHERE member_id = ? AND payment_type = 'fine' AND status = 'pending'").get(memberId)).t;
  const pendingCardPayments = (await db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM payment_requests WHERE member_id = ? AND payment_type = 'member_card' AND status = 'pending'").get(memberId)).t;
  const pendingLoanPayments = (await db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM payment_requests WHERE member_id = ? AND payment_type = 'loan' AND status = 'pending'").get(memberId)).t;

  const member = await db.prepare('SELECT photo FROM members WHERE id = ?').get(memberId);

  res.renderWithLayout('member/dashboard', { balances, totalSavingsDev, activeLoan, recentContributions, currentCycle, hasContributed, pendingContribs, pendingLoan, totalFines, cardBalance, pendingFinePayments, pendingCardPayments, pendingLoanPayments, memberPhoto: member?.photo || null });
});

router.get('/contribute', async (req, res) => {
  const memberId = req.session.user.memberId;
  const currentCycle = await db.prepare('SELECT * FROM cycles WHERE is_open = 1 AND is_processed = 0 ORDER BY start_date DESC LIMIT 1').get();

  const funds = await db.prepare('SELECT * FROM fund_types').all();

  // Existing cycle contributions
  let existingCycle = {};
  if (currentCycle) {
    const existing = await db.prepare('SELECT * FROM contributions WHERE member_id = ? AND cycle_id = ?').all(memberId, currentCycle.id);
    existing.forEach(e => { existingCycle[e.fund_type_id] = e; });
  }
  funds.forEach(f => {
    f.contributed_amount = existingCycle[f.id] ? existingCycle[f.id].amount : 0;
    f.status = existingCycle[f.id] ? existingCycle[f.id].status : null;
  });

  // Fines data
  const totalFinesBalance = (await db.prepare("SELECT COALESCE(SUM(balance),0) as t FROM fines WHERE member_id = ? AND status = 'pending'").get(memberId)).t;
  const pendingFineRequests = (await db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM payment_requests WHERE member_id = ? AND payment_type = 'fine' AND status = 'pending'").get(memberId)).t;

  // Member card data
  const card = await db.prepare("SELECT * FROM member_cards WHERE member_id = ?").get(memberId);
  const cardBalance = card ? card.assigned_amount - card.paid_amount : 0;
  const pendingCardRequests = (await db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM payment_requests WHERE member_id = ? AND payment_type = 'member_card' AND status = 'pending'").get(memberId)).t;

  // Loan data
  const currentLoan = await db.prepare("SELECT * FROM loans WHERE member_id = ? AND status IN ('active', 'defaulted') AND (amount_due - paid_amount) > 0 ORDER BY created_at DESC LIMIT 1").get(memberId);
  const pendingLoanRequests = (await db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM payment_requests WHERE member_id = ? AND payment_type = 'loan' AND status = 'pending'").get(memberId)).t;

  res.renderWithLayout('member/contribute', {
    cycle: currentCycle, funds,
    totalFinesBalance, pendingFineRequests,
    cardBalance, pendingCardRequests,
    activeLoan: currentLoan, pendingLoanRequests,
    message: null
  });
});

router.post('/contribute', async (req, res) => {
  const memberId = req.session.user.memberId;
  const currentCycle = await db.prepare('SELECT * FROM cycles WHERE is_open = 1 AND is_processed = 0 ORDER BY start_date DESC LIMIT 1').get();
  const funds = await db.prepare('SELECT * FROM fund_types').all();

  const trans = db.transaction(async () => {
    // 1. Cycle contributions (4 funds) — only if cycle is active
    if (currentCycle) {
      const upsert = db.prepare(`
        INSERT INTO contributions (member_id, fund_type_id, cycle_id, amount, status, created_by, created_by_role)
        VALUES (?, ?, ?, ?, 'pending', ?, ?)
        ON CONFLICT(member_id, fund_type_id, cycle_id) DO UPDATE SET amount = excluded.amount, status = 'pending', created_by = excluded.created_by, created_by_role = excluded.created_by_role
      `);
      for (const fund of funds.filter(f => f.name !== 'Loans')) {
        const amount = parseFloat(req.body[`fund_${fund.id}`]) || 0;
        await upsert.run(memberId, fund.id, currentCycle.id, amount, req.session.user.id, req.session.user.admin_role || 'member');
      }
    }

    // 2. Fine repayment
    const fineAmount = parseFloat(req.body.fine_repay) || 0;
    if (fineAmount > 0) {
      const totalFinesBalance = (await db.prepare("SELECT COALESCE(SUM(balance),0) as t FROM fines WHERE member_id = ? AND status = 'pending'").get(memberId)).t;
      const pendingFineRequests = (await db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM payment_requests WHERE member_id = ? AND payment_type = 'fine' AND status = 'pending'").get(memberId)).t;
      const available = totalFinesBalance - pendingFineRequests;
      if (available > 0) {
        const repay = Math.min(fineAmount, available);
        await db.prepare("INSERT INTO payment_requests (member_id, payment_type, amount, created_by, created_by_role) VALUES (?, 'fine', ?, ?, ?)").run(memberId, repay, req.session.user.id, req.session.user.admin_role || 'member');
      }
    }

    // 3. Member card repayment
    const cardAmount = parseFloat(req.body.card_repay) || 0;
    if (cardAmount > 0) {
      const card = await db.prepare("SELECT * FROM member_cards WHERE member_id = ?").get(memberId);
      const cardBalance = card ? card.assigned_amount - card.paid_amount : 0;
      const pendingCardRequests = (await db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM payment_requests WHERE member_id = ? AND payment_type = 'member_card' AND status = 'pending'").get(memberId)).t;
      const available = cardBalance - pendingCardRequests;
      if (available > 0) {
        const repay = Math.min(cardAmount, available);
        await db.prepare("INSERT INTO payment_requests (member_id, payment_type, amount, created_by, created_by_role) VALUES (?, 'member_card', ?, ?, ?)").run(memberId, repay, req.session.user.id, req.session.user.admin_role || 'member');
      }
    }

    // 4. Loan repayment
    const loanAmount = parseFloat(req.body.loan_repay) || 0;
    if (loanAmount > 0) {
      const activeLoan = await db.prepare("SELECT * FROM loans WHERE member_id = ? AND status = 'active'").get(memberId);
      if (activeLoan) {
        const pendingLoanRequests = (await db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM payment_requests WHERE member_id = ? AND payment_type = 'loan' AND status = 'pending'").get(memberId)).t;
        const available = activeLoan.amount_due - pendingLoanRequests;
        if (available > 0) {
          const repay = Math.min(loanAmount, available);
          await db.prepare("INSERT INTO payment_requests (member_id, payment_type, reference_id, amount, created_by, created_by_role) VALUES (?, 'loan', ?, ?, ?, ?)").run(memberId, activeLoan.id, repay, req.session.user.id, req.session.user.admin_role || 'member');
        }
      }
    }
  });

  await trans();
  res.redirect('/member');
});

router.get('/loans', async (req, res) => {
  const memberId = req.session.user.memberId;

  const balances = await db.prepare(`
    SELECT f.name, COALESCE(mb.balance, 0) as balance
    FROM fund_types f
    LEFT JOIN member_balances mb ON mb.fund_type_id = f.id AND mb.member_id = ?
    ORDER BY f.id
  `).all(memberId);

  const savingsBalance = balances.find(b => b.name === 'Savings')?.balance || 0;
  const devBalance = balances.find(b => b.name === 'Development')?.balance || 0;
  const totalQualifying = savingsBalance + devBalance;
  const maxLoan = Math.floor(totalQualifying * 2 / 3);

  const activeLoan = await db.prepare("SELECT * FROM loans WHERE member_id = ? AND status IN ('active', 'defaulted') AND (amount_due - paid_amount) > 0 ORDER BY created_at DESC LIMIT 1").get(memberId);
  const pendingLoan = await db.prepare("SELECT * FROM loans WHERE member_id = ? AND status = 'pending'").get(memberId);
  const pastLoans = await db.prepare("SELECT * FROM loans WHERE member_id = ? AND status NOT IN ('active', 'pending') ORDER BY created_at DESC").all(memberId);
  const defaultedLoans = await db.prepare("SELECT * FROM loans WHERE member_id = ? AND status = 'defaulted' AND (amount_due - paid_amount) > 0 ORDER BY created_at DESC").all(memberId);

  const qualifies = totalQualifying >= 3000 && !activeLoan && !pendingLoan;

  res.renderWithLayout('member/loans', { totalQualifying, maxLoan, qualifies, activeLoan, pendingLoan, pastLoans, defaultedLoans, error: null });
});

router.post('/loans/apply', async (req, res) => {
  const memberId = req.session.user.memberId;
  const amount = parseFloat(req.body.amount);

  const balances = await db.prepare(`
    SELECT f.name, COALESCE(mb.balance, 0) as balance
    FROM fund_types f
    LEFT JOIN member_balances mb ON mb.fund_type_id = f.id AND mb.member_id = ?
    ORDER BY f.id
  `).all(memberId);

  const savingsBalance = balances.find(b => b.name === 'Savings')?.balance || 0;
  const devBalance = balances.find(b => b.name === 'Development')?.balance || 0;
  const totalQualifying = savingsBalance + devBalance;
  const maxLoan = Math.floor(totalQualifying * 2 / 3);
  const pastLoans = await db.prepare("SELECT * FROM loans WHERE member_id = ? AND status NOT IN ('active', 'pending') ORDER BY created_at DESC").all(memberId);

  const activeLoan = await db.prepare("SELECT * FROM loans WHERE member_id = ? AND status IN ('active', 'defaulted') AND (amount_due - paid_amount) > 0").get(memberId);
  const pendingLoan = await db.prepare("SELECT * FROM loans WHERE member_id = ? AND status = 'pending'").get(memberId);

  if (!amount || isNaN(amount) || amount <= 0) return res.renderWithLayout('member/loans', { totalQualifying, maxLoan, qualifies: false, activeLoan, pendingLoan, pastLoans, error: 'Invalid loan amount' });
  if (activeLoan || pendingLoan) return res.renderWithLayout('member/loans', { totalQualifying, maxLoan, qualifies: false, activeLoan, pendingLoan, pastLoans, error: 'You already have an active, defaulted, or pending loan' });
  if (totalQualifying < 3000) return res.renderWithLayout('member/loans', { totalQualifying, maxLoan, qualifies: false, activeLoan: null, pendingLoan: null, pastLoans, error: 'Savings+Development must be >= 3000' });
  if (amount > maxLoan) return res.renderWithLayout('member/loans', { totalQualifying, maxLoan, qualifies: true, activeLoan: null, pendingLoan: null, pastLoans, error: `Maximum loan is KES ${maxLoan.toLocaleString()}` });

  await db.prepare(`
    INSERT INTO loans (member_id, amount, interest_rate, amount_due, status, created_by, created_by_role)
    VALUES (?, ?, 10, ?, 'pending', ?, ?)
  `).run(memberId, amount, amount, req.session.user.id, req.session.user.admin_role || 'member');

  res.redirect('/member/loans');
});

router.post('/loans/repay', async (req, res) => {
  const memberId = req.session.user.memberId;
  const repayAmount = parseFloat(req.body.repay_amount) || 0;

  const activeLoan = await db.prepare("SELECT * FROM loans WHERE member_id = ? AND status IN ('active', 'defaulted') AND (amount_due - paid_amount) > 0 ORDER BY created_at DESC LIMIT 1").get(memberId);
  if (!activeLoan) return res.redirect('/member/loans');
  if (repayAmount <= 0) return res.redirect('/member/loans');

  const remaining = activeLoan.amount_due - activeLoan.paid_amount;
  const actualRepay = Math.min(repayAmount, remaining);
  await db.prepare("INSERT INTO payment_requests (member_id, payment_type, reference_id, amount, created_by, created_by_role) VALUES (?, 'loan', ?, ?, ?, ?)").run(memberId, activeLoan.id, actualRepay, req.session.user.id, req.session.user.admin_role || 'member');
  res.redirect('/member/loans');
});

router.get('/fines', async (req, res) => {
  const memberId = req.session.user.memberId;
  const pendingFines = await db.prepare("SELECT * FROM fines WHERE member_id = ? AND status = 'pending' ORDER BY created_at DESC").all(memberId);
  const paidFines = await db.prepare("SELECT * FROM fines WHERE member_id = ? AND status = 'paid' ORDER BY created_at DESC").all(memberId);
  const totalPending = pendingFines.reduce((s, f) => s + f.balance, 0);
  const totalPaid = paidFines.reduce((s, f) => s + f.amount, 0);
  const pendingRequests = (await db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM payment_requests WHERE member_id = ? AND payment_type = 'fine' AND status = 'pending'").get(memberId)).t;
  res.renderWithLayout('member/fines', { pendingFines, paidFines, totalPending, totalPaid, pendingRequests, error: null });
});

router.post('/fines/pay/:id', async (req, res) => {
  const memberId = req.session.user.memberId;
  const fine = await db.prepare("SELECT * FROM fines WHERE id = ? AND member_id = ? AND status = 'pending'").get(req.params.id, memberId);
  if (!fine) return res.redirect('/member/fines');
  const repayAmount = Math.min(parseFloat(req.body.repay_amount) || fine.balance, fine.balance);
  if (repayAmount <= 0) return res.redirect('/member/fines');
  await db.prepare("INSERT INTO payment_requests (member_id, payment_type, reference_id, amount, created_by, created_by_role) VALUES (?, 'fine', ?, ?, ?, ?)").run(memberId, fine.id, repayAmount, req.session.user.id, req.session.user.admin_role || 'member');
  res.redirect('/member/fines');
});

router.get('/membercard', async (req, res) => {
  const memberId = req.session.user.memberId;
  let card = await db.prepare("SELECT * FROM member_cards WHERE member_id = ?").get(memberId);
  if (!card) { card = { assigned_amount: 0, paid_amount: 0 }; }
  const balance = card.assigned_amount - card.paid_amount;
  const pendingRequests = (await db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM payment_requests WHERE member_id = ? AND payment_type = 'member_card' AND status = 'pending'").get(memberId)).t;
  res.renderWithLayout('member/membercard', { card, balance, pendingRequests, error: null });
});

router.post('/membercard/pay', async (req, res) => {
  const memberId = req.session.user.memberId;
  let card = await db.prepare("SELECT * FROM member_cards WHERE member_id = ?").get(memberId);
  if (!card) return res.redirect('/member/membercard');
  const repayAmount = parseFloat(req.body.repay_amount) || 0;
  const currentBalance = card.assigned_amount - card.paid_amount;
  if (repayAmount <= 0 || repayAmount > currentBalance) return res.redirect('/member/membercard');
  await db.prepare("INSERT INTO payment_requests (member_id, payment_type, reference_id, amount, created_by, created_by_role) VALUES (?, 'member_card', NULL, ?, ?, ?)").run(memberId, repayAmount, req.session.user.id, req.session.user.admin_role || 'member');
  res.redirect('/member/membercard');
});

router.get('/fund/:fundId', async (req, res) => {
  const memberId = req.session.user.memberId;
  const fund = await db.prepare("SELECT * FROM fund_types WHERE id = ?").get(req.params.fundId);
  if (!fund) return res.redirect('/member');

  const balance = (await db.prepare("SELECT COALESCE(balance, 0) as balance FROM member_balances WHERE member_id = ? AND fund_type_id = ?").get(memberId, fund.id)).balance;

  const contributions = await db.prepare(`
    SELECT c.amount, c.status, c.created_at, cy.start_date, cy.end_date
    FROM contributions c
    JOIN cycles cy ON c.cycle_id = cy.id
    WHERE c.member_id = ? AND c.fund_type_id = ?
    ORDER BY cy.start_date DESC
  `).all(memberId, fund.id);

  const totalContributed = contributions.reduce((s, c) => s + (c.status === 'approved' ? c.amount : 0), 0);

  res.renderWithLayout('member/fund_detail', { fund, balance, contributions, totalContributed });
});

router.get('/minutes', async (req, res) => {
  const minutes = await db.prepare("SELECT * FROM meeting_minutes ORDER BY meeting_date DESC").all();
  res.renderWithLayout('member/minutes', { minutes });
});

// --- Welfare Registration ---
router.get('/welfare/register', async (req, res) => {
  const memberId = req.session.user.memberId;
  const existing = await db.prepare("SELECT * FROM welfare_registrations WHERE member_id = ?").get(memberId);
  const formData = existing ? JSON.parse(existing.form_data || '{}') : {};
  res.renderWithLayout('member/welfare_register', { existing, formData, error: req.query.error || null, success: req.query.success || null });
});

router.post('/welfare/register', async (req, res) => {
  const memberId = req.session.user.memberId;
  const existing = await db.prepare("SELECT * FROM welfare_registrations WHERE member_id = ?").get(memberId);
  if (existing && existing.locked) {
    return res.redirect('/member/welfare/register?error=Form is locked. Submit an edit request to make changes.');
  }

  const fields = ['surname','first_name','middle_name','nationality','id_number','permanent_address','contact_number','email','occupation','estate','road','building','house_number','home_county','sub_location','spouse_name','spouse_phone','spouse_id','next_of_kin_name','next_of_kin_phone','next_of_kin_id','next_of_kin_relationship'];
  // Children (1-4)
  for (let i = 1; i <= 4; i++) { fields.push('children_name_'+i, 'children_age_'+i, 'children_cert_'+i); }
  // Parents (1-2)
  for (let i = 1; i <= 2; i++) { fields.push('parent_name_'+i, 'parent_phone_'+i, 'parent_id_'+i); }
  // In-laws (1-2)
  for (let i = 1; i <= 2; i++) { fields.push('inlaw_name_'+i, 'inlaw_phone_'+i, 'inlaw_id_'+i); }
  const formData = {};
  for (const f of fields) formData[f] = req.body[f] || '';

  const json = JSON.stringify(formData);
  if (existing) {
    await db.prepare("UPDATE welfare_registrations SET form_data = ?, status = 'draft', updated_at = datetime('now') WHERE member_id = ?").run(json, memberId);
  } else {
    await db.prepare("INSERT INTO welfare_registrations (member_id, form_data, status) VALUES (?, ?, 'draft')").run(memberId, json);
  }
  res.redirect('/member/welfare/register?success=Draft saved');
});

router.post('/welfare/register/submit', async (req, res) => {
  const memberId = req.session.user.memberId;
  const existing = await db.prepare("SELECT * FROM welfare_registrations WHERE member_id = ?").get(memberId);
  if (!existing) return res.redirect('/member/welfare/register?error=Save a draft first');
  if (existing.locked) return res.redirect('/member/welfare/register?error=Already submitted');
  await db.prepare("UPDATE welfare_registrations SET status = 'submitted', locked = 1, submitted_at = datetime('now'), updated_at = datetime('now') WHERE member_id = ?").run(memberId);
  res.redirect('/member/welfare/register?success=Form submitted successfully');
});

router.post('/welfare/register/request-edit', async (req, res) => {
  const memberId = req.session.user.memberId;
  const existing = await db.prepare("SELECT * FROM welfare_registrations WHERE member_id = ? AND locked = 1").get(memberId);
  if (!existing) return res.redirect('/member/welfare/register');
  await db.prepare("UPDATE welfare_registrations SET edit_requested = 1 WHERE member_id = ?").run(memberId);
  res.redirect('/member/welfare/register?success=Edit request sent to admin');
});

// --- Member Statement ---
router.get('/statement', async (req, res) => {
  const memberId = req.session.user.memberId;
  const member = await db.prepare("SELECT * FROM members WHERE id = ?").get(memberId);
  const balances = await db.prepare("SELECT f.name, COALESCE(mb.balance,0) as balance FROM fund_types f LEFT JOIN member_balances mb ON mb.fund_type_id = f.id AND mb.member_id = ? ORDER BY f.id").all(memberId);
  const contributions = await db.prepare("SELECT c.*, f.name as fund, cy.start_date, cy.end_date FROM contributions c JOIN fund_types f ON c.fund_type_id = f.id JOIN cycles cy ON c.cycle_id = cy.id WHERE c.member_id = ? ORDER BY c.created_at DESC").all(memberId);
  const loans = await db.prepare("SELECT * FROM loans WHERE member_id = ? ORDER BY created_at DESC").all(memberId);
  const fines = await db.prepare("SELECT * FROM fines WHERE member_id = ? ORDER BY created_at DESC").all(memberId);
  const withdrawals = await db.prepare("SELECT w.*, f.name as fund_name FROM withdrawal_requests w JOIN fund_types f ON w.fund_type_id = f.id WHERE w.member_id = ? ORDER BY w.created_at DESC").all(memberId);
  const totalContributions = contributions.reduce(function(s, c) { return s + (c.status === 'approved' ? c.amount : 0); }, 0);
  res.renderWithLayout('member/statement', { member, balances, contributions, loans, fines, withdrawals, totalContributions });
});

module.exports = router;
