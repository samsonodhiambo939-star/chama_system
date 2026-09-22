const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { auditLog, notify, checkApprovalRight } = require('../helpers');
const router = express.Router();

router.use(requireAdmin);

router.get('/', async (req, res) => {
  const statsRaw = await db.prepare(`
    SELECT 
      (SELECT COUNT(*) FROM members WHERE is_active = 1) as total_members,
      (SELECT COUNT(*) FROM cycles) as total_cycles,
      (SELECT COUNT(*) FROM loans WHERE status = 'active') as active_loans,
      (SELECT COUNT(*) FROM loans WHERE status = 'defaulted') as defaulted_loans,
      (SELECT COUNT(*) FROM loans) as total_loans,
      (SELECT COALESCE(SUM(amount_due - paid_amount),0) FROM loans WHERE status = 'defaulted') as defaulted_amount,
      (SELECT COALESCE(SUM(amount_due - paid_amount),0) FROM loans WHERE status = 'active') as active_loan_amount,
      (SELECT COALESCE(SUM(paid_amount),0) FROM loans WHERE status = 'active') as active_paid_amount,
      (SELECT COALESCE(SUM(amount),0) FROM loans WHERE status = 'pending') as pending_loan_amount,
      (SELECT COALESCE(SUM(amount_due - paid_amount),0) FROM loans WHERE status IN ('active','defaulted')) as total_outstanding
  `).get();
  const stats = { total_members: Number(statsRaw.total_members) || 0, total_cycles: Number(statsRaw.total_cycles) || 0, active_loans: Number(statsRaw.active_loans) || 0, defaulted_loans: Number(statsRaw.defaulted_loans) || 0, total_loans: Number(statsRaw.total_loans) || 0, defaulted_amount: Number(statsRaw.defaulted_amount) || 0, active_loan_amount: Number(statsRaw.active_loan_amount) || 0, active_paid_amount: Number(statsRaw.active_paid_amount) || 0, pending_loan_amount: Number(statsRaw.pending_loan_amount) || 0, total_outstanding: Number(statsRaw.total_outstanding) || 0 };

  const fundBalancesRaw = await db.prepare(`
    SELECT f.id, f.name, COALESCE(SUM(mb.balance), 0) as total
    FROM fund_types f
    LEFT JOIN member_balances mb ON mb.fund_type_id = f.id
    GROUP BY f.id ORDER BY f.id
  `).all();
  const loanPortfolio = Number((await db.prepare("SELECT COALESCE(SUM(amount_due - paid_amount),0) as t FROM loans WHERE status IN ('active','defaulted')").get()).t) || 0;
  const fundBalances = fundBalancesRaw.map(function(f) {
    if (f.name === 'Loans') return { id: f.id, name: 'Loan Balance', total: loanPortfolio };
    return { id: f.id, name: f.name, total: Number(f.total) || 0 };
  });

  const pendingContribs = Number((await db.prepare("SELECT COUNT(*) as c FROM contributions WHERE status = 'pending' AND amount > 0").get()).c) || 0;
  const pendingLoans = Number((await db.prepare("SELECT COUNT(*) as c FROM loans WHERE status = 'pending'").get()).c) || 0;
  const pendingPayments = Number((await db.prepare("SELECT COUNT(*) as c FROM payment_requests WHERE status = 'pending'").get()).c) || 0;

  const totalFines = Number((await db.prepare("SELECT COALESCE(SUM(balance),0) as t FROM fines WHERE status='pending'").get()).t) || 0;
  const totalMemberCard = Number((await db.prepare("SELECT COALESCE(SUM(assigned_amount - paid_amount),0) as t FROM member_cards").get()).t) || 0;

  const recentContributions = await db.prepare(`
    SELECT c.amount, f.name as fund, m.first_name || ' ' || m.last_name as member, c.created_at, c.status
    FROM contributions c
    JOIN fund_types f ON c.fund_type_id = f.id
    JOIN members m ON c.member_id = m.id
    ORDER BY c.created_at DESC LIMIT 10
  `).all();

  const recentMeetings = await db.prepare("SELECT mm.*, (SELECT COUNT(*) FROM meeting_attendance WHERE meeting_id = mm.id AND status = 'present') as present_count, (SELECT COUNT(*) FROM meeting_attendance WHERE meeting_id = mm.id AND status = 'absent') as absent_count FROM meeting_minutes mm ORDER BY mm.meeting_date DESC LIMIT 5").all();

  res.renderWithLayout('admin/dashboard', { stats, fundBalances, pendingContribs, pendingLoans, pendingPayments, totalFines, totalMemberCard, recentContributions, recentMeetings });
});

router.get('/approvals', async (req, res) => {
  try {
    let pendingContributions;
    try {
      pendingContributions = await db.prepare(`
      SELECT c.id, c.amount, c.created_at, c.created_by, c.created_by_role, f.name as fund, m.first_name, m.last_name, m.member_number, cy.start_date, cy.end_date
      FROM contributions c
      JOIN fund_types f ON c.fund_type_id = f.id
      JOIN members m ON c.member_id = m.id
      JOIN cycles cy ON c.cycle_id = cy.id
      WHERE c.status = 'pending' AND c.amount > 0
      ORDER BY c.created_at ASC
    `).all();
    } catch (e) {
      // Fallback for older chama.db files missing created_by columns (pre maker-checker migration)
      console.error('APPROVALS QUERY FALLBACK (created_by columns missing?):', e.message);
      pendingContributions = await db.prepare(`
      SELECT c.id, c.amount, c.created_at, NULL as created_by, NULL as created_by_role, f.name as fund, m.first_name, m.last_name, m.member_number, cy.start_date, cy.end_date
      FROM contributions c
      JOIN fund_types f ON c.fund_type_id = f.id
      JOIN members m ON c.member_id = m.id
      JOIN cycles cy ON c.cycle_id = cy.id
      WHERE c.status = 'pending' AND c.amount > 0
      ORDER BY c.created_at ASC
    `).all();
    }

  const pendingLoans = await db.prepare(`
    SELECT l.*, m.first_name, m.last_name, m.member_number
    FROM loans l
    JOIN members m ON l.member_id = m.id
    WHERE l.status = 'pending'
    ORDER BY l.created_at ASC
  `).all();

  const pendingPayments = await db.prepare(`
    SELECT pr.*, m.first_name, m.last_name, m.member_number,
      CASE
        WHEN pr.payment_type = 'fine' THEN COALESCE((SELECT reason FROM fines WHERE id = pr.reference_id), 'Fine Repayment')
        WHEN pr.payment_type = 'loan' THEN 'Loan Repayment'
        ELSE 'Member Card Repayment'
      END as description
    FROM payment_requests pr
    JOIN members m ON pr.member_id = m.id
    WHERE pr.status = 'pending'
    ORDER BY pr.created_at ASC
  `).all();

  res.renderWithLayout('admin/approvals', { pendingContributions, pendingLoans, pendingPayments, error: req.query.error || null });
  } catch (e) {
    console.error('LOAD APPROVALS ERROR:', e.message, e.stack);
    res.renderWithLayout('admin/approvals', { pendingContributions: [], pendingLoans: [], pendingPayments: [], error: 'Could not load approvals: ' + e.message });
  }
});

router.post('/contributions/approve/:id', async (req, res) => {
  try {
    const contrib = await db.prepare("SELECT * FROM contributions WHERE id = ? AND status = 'pending'").get(req.params.id);
    if (!contrib) return res.redirect('/admin/approvals');
    const check = checkApprovalRight(req.session.user, contrib);
    if (!check.ok) return res.redirect('/admin/approvals?error=' + encodeURIComponent(check.reason));

    await db.transaction(async () => {
      await db.prepare("UPDATE contributions SET status = 'approved' WHERE id = ?").run(contrib.id);
      const upd = await db.prepare("UPDATE member_balances SET balance = balance + ? WHERE member_id = ? AND fund_type_id = ?").run(contrib.amount, contrib.member_id, contrib.fund_type_id);
      if (upd.changes === 0) {
        await db.prepare("INSERT INTO member_balances (member_id, fund_type_id, balance) VALUES (?, ?, ?)").run(contrib.member_id, contrib.fund_type_id, contrib.amount);
      }
    })();
    auditLog(req.session.user, 'approve', 'contribution', contrib.id, 'KES ' + contrib.amount + ' fund ' + contrib.fund_type_id);
    await notify(contrib.member_id, 'Contribution Approved', 'KES ' + contrib.amount.toLocaleString() + ' contribution approved', 'success', '/member');

    res.redirect('/admin/approvals');
  } catch (e) {
    console.error('APPROVE CONTRIB ERROR:', e.message, e.stack);
    res.redirect('/admin/approvals?error=' + encodeURIComponent('Could not approve: ' + e.message));
  }
});

router.post('/contributions/reject/:id', async (req, res) => {
  try {
    const contrib = await db.prepare("SELECT * FROM contributions WHERE id = ? AND status = 'pending'").get(req.params.id);
    const check = checkApprovalRight(req.session.user, contrib);
    if (!check.ok) return res.redirect('/admin/approvals?error=' + encodeURIComponent(check.reason));
    await db.prepare("UPDATE contributions SET status = 'rejected' WHERE id = ? AND status = 'pending'").run(req.params.id);
    if (contrib) { await notify(contrib.member_id, 'Contribution Rejected', 'KES ' + contrib.amount.toLocaleString() + ' contribution was rejected', 'error', '/member/contribute');
      auditLog(req.session.user, 'reject', 'contribution', contrib.id, 'KES ' + contrib.amount + ' rejected'); }
    res.redirect('/admin/approvals');
  } catch (e) {
    console.error('REJECT CONTRIB ERROR:', e.message, e.stack);
    res.redirect('/admin/approvals?error=' + encodeURIComponent('Could not reject: ' + e.message));
  }
});

router.post('/loans/approve/:id', async (req, res) => {
  try {
    const loan = await db.prepare("SELECT * FROM loans WHERE id = ? AND status = 'pending'").get(req.params.id);
    if (!loan) return res.redirect('/admin/approvals');
    const check = checkApprovalRight(req.session.user, loan);
    if (!check.ok) return res.redirect('/admin/approvals?error=' + encodeURIComponent(check.reason));

    const today = new Date().toISOString().split('T')[0];
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 30);
    const dueDateStr = dueDate.toISOString().split('T')[0];

    const amountDue = loan.amount + (loan.amount * loan.interest_rate / 100);

    await db.prepare(`
      UPDATE loans SET status = 'active', amount_due = ?, issued_date = ?, due_date = ?, approved_date = ?
      WHERE id = ?
    `).run(amountDue, today, dueDateStr, today, loan.id);

    await notify(loan.member_id, 'Loan Approved', 'KES ' + loan.amount.toLocaleString() + ' loan approved at 10% interest. Due: ' + dueDateStr, 'success', '/member/loans');
    auditLog(req.session.user, 'approve', 'loan', loan.id, 'KES ' + loan.amount + ' approved, due ' + dueDateStr);

    res.redirect('/admin/approvals');
  } catch (e) {
    console.error('APPROVE LOAN ERROR:', e.message, e.stack);
    res.redirect('/admin/approvals?error=' + encodeURIComponent('Could not approve: ' + e.message));
  }
});

router.post('/loans/reject/:id', async (req, res) => {
  try {
    const loan = await db.prepare("SELECT * FROM loans WHERE id = ? AND status = 'pending'").get(req.params.id);
    const check = checkApprovalRight(req.session.user, loan);
    if (!check.ok) return res.redirect('/admin/approvals?error=' + encodeURIComponent(check.reason));
    await db.prepare("UPDATE loans SET status = 'rejected' WHERE id = ? AND status = 'pending'").run(req.params.id);
    if (loan) { await notify(loan.member_id, 'Loan Rejected', 'KES ' + loan.amount.toLocaleString() + ' loan application was rejected', 'error', '/member/loans');
      auditLog(req.session.user, 'reject', 'loan', loan.id, 'KES ' + loan.amount + ' rejected'); }
    res.redirect('/admin/approvals');
  } catch (e) {
    console.error('REJECT LOAN ERROR:', e.message, e.stack);
    res.redirect('/admin/approvals?error=' + encodeURIComponent('Could not reject: ' + e.message));
  }
});

router.get('/members', async (req, res) => {
  const members = await db.prepare(`
    SELECT m.*, u.username, u.role,
      (SELECT COALESCE(SUM(balance), 0) FROM member_balances WHERE member_id = m.id) as total_balance
    FROM members m
    LEFT JOIN users u ON u.member_id = m.id
    ORDER BY m.member_number
  `).all();
  res.renderWithLayout('admin/members', { members, message: null, error: null });
});

router.post('/members/add', async (req, res) => {
  const { first_name, last_name, phone, username, password } = req.body;
  if (!first_name || !last_name || !username || !password) {
    const members = await db.prepare('SELECT * FROM members ORDER BY member_number').all();
    return res.renderWithLayout('admin/members', { members, message: null, error: 'All fields required' });
  }
  if (password.length < 6) {
    const members = await db.prepare('SELECT * FROM members ORDER BY member_number').all();
    return res.renderWithLayout('admin/members', { members, message: null, error: 'Password must be at least 6 characters' });
  }

  try {
    await db.transaction(async () => {
      const count = (await db.prepare('SELECT COUNT(*) as c FROM members').get()).c;
      const num = `MEM${String(count + 1).padStart(3, '0')}`;
      const result = await db.prepare('INSERT INTO members (first_name, last_name, phone, member_number) VALUES (?, ?, ?, ?)').run(first_name, last_name, phone || null, num);
      const memberId = result.lastInsertRowid;
      const hash = bcrypt.hashSync(password, 10);
      await db.prepare('INSERT INTO users (username, password_hash, role, member_id) VALUES (?, ?, ?, ?)').run(username, hash, 'member', memberId);
      for (let f = 1; f <= 4; f++) {
        await db.prepare('INSERT INTO member_balances (member_id, fund_type_id, balance) VALUES (?, ?, 0)').run(memberId, f);
      }
    })();
    res.redirect('/admin/members');
  } catch (e) {
    const members = await db.prepare('SELECT * FROM members ORDER BY member_number').all();
    res.renderWithLayout('admin/members', { members, message: null, error: 'Username already exists' });
  }
});

router.post('/members/reset-password/:id', async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.redirect('/admin/members');
  const hash = bcrypt.hashSync(password, 10);
  await db.prepare('UPDATE users SET password_hash = ? WHERE member_id = ?').run(hash, req.params.id);
  auditLog(req.session.user, 'reset_password', 'member', req.params.id, 'Password reset');
  res.redirect('/admin/members');
});

router.post('/members/photo/:id', async (req, res) => {
  const { photo } = req.body;
  if (!photo) return res.redirect('/admin/members');
  await db.prepare('UPDATE members SET photo = ? WHERE id = ?').run(photo, req.params.id);
  auditLog(req.session.user, 'upload_photo', 'member', req.params.id, 'Photo uploaded');
  res.redirect('/admin/members');
});

router.post('/members/photo/remove/:id', async (req, res) => {
  await db.prepare('UPDATE members SET photo = NULL WHERE id = ?').run(req.params.id);
  res.redirect('/admin/members');
});

router.get('/members/outside-nairobi/set/:id', async (req, res) => {
  await db.prepare('UPDATE members SET outside_nairobi = 1 WHERE id = ?').run(req.params.id);
  auditLog(req.session.user, 'update', 'member', req.params.id, 'Marked as outside Nairobi');
  res.redirect('/admin/members');
});

router.get('/members/outside-nairobi/remove/:id', async (req, res) => {
  await db.prepare('UPDATE members SET outside_nairobi = 0 WHERE id = ?').run(req.params.id);
  auditLog(req.session.user, 'update', 'member', req.params.id, 'Removed outside Nairobi mark');
  res.redirect('/admin/members');
});

router.get('/cycles', async (req, res) => {
  const cycles = await db.prepare(`
    SELECT c.*, 
      (SELECT COUNT(*) FROM contributions WHERE cycle_id = c.id) as contrib_count,
      (SELECT COALESCE(SUM(amount),0) FROM contributions WHERE cycle_id = c.id) as contrib_total
    FROM cycles c ORDER BY c.start_date DESC
  `).all();
  const currentCycle = await db.prepare('SELECT * FROM cycles WHERE is_open = 1 AND is_processed = 0 ORDER BY start_date DESC LIMIT 1').get();
  res.renderWithLayout('admin/cycles', { cycles, currentCycle });
});

router.post('/cycles/create', async (req, res) => {
  try {
    const { start_date, end_date } = req.body;
    if (!start_date || !end_date) return res.redirect('/admin/cycles');
    await db.prepare('UPDATE cycles SET is_open = 0 WHERE is_open = 1').run();
    await db.prepare('INSERT INTO cycles (start_date, end_date, is_open, is_processed) VALUES (?, ?, 1, 0)').run(start_date, end_date);
    res.redirect('/admin/cycles');
  } catch(e) {
    console.error('CYCLE CREATE ERROR:', e.message, e.stack);
    res.redirect('/admin/cycles');
  }
});

router.post('/cycles/close', async (req, res) => {
  await db.prepare('UPDATE cycles SET is_open = 0 WHERE is_open = 1').run();
  res.redirect('/admin/cycles');
});

router.get('/loans', async (req, res) => {
  const loans = await db.prepare(`
    SELECT l.*, m.first_name, m.last_name, m.member_number 
    FROM loans l 
    JOIN members m ON l.member_id = m.id 
    ORDER BY l.created_at DESC
  `).all();
  res.renderWithLayout('admin/loans', { loans });
});

router.post('/loans/process-overdue', async (req, res) => {
  const isPg = !!process.env.DATABASE_URL;
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  let overdue;
  if (isPg) {
    overdue = await db.prepare("SELECT * FROM loans WHERE status = 'active' AND due_date < $1 AND due_date <= $1::date - INTERVAL '30 days'").all(todayStr);
  } else {
    overdue = await db.prepare("SELECT * FROM loans WHERE status = 'active' AND due_date < ? AND date(due_date, '+30 days') <= ?").all(todayStr, todayStr);
  }
  const update = db.prepare("UPDATE loans SET amount_due = amount_due + ((amount_due - paid_amount) * interest_rate / 100), status = 'defaulted', defaulted_penalty = (amount_due - paid_amount) * interest_rate / 100 WHERE id = ?");
  let count = 0;
  for (const loan of overdue) {
    await update.run(loan.id);
    count++;
    auditLog(req.session.user, 'default', 'loan', loan.id, 'KES ' + loan.amount + ' defaulted with penalty');
    await notify(loan.member_id, 'Loan Defaulted', 'KES ' + loan.amount.toLocaleString() + ' loan defaulted. 10% penalty applied.', 'error', '/member/loans');
  }
  res.redirect('/admin/loans?message=' + encodeURIComponent(count + ' overdue loans marked as defaulted'));
});

router.post('/loans/mark-defaulted/:id', async (req, res) => {
  const isPg = !!process.env.DATABASE_URL;
  const loan = await db.prepare("SELECT * FROM loans WHERE id = ? AND status = 'active'").get(req.params.id);
  if (!loan) return res.redirect('/admin/loans');
  const updateSql = isPg
    ? "UPDATE loans SET amount_due = amount_due + ((amount_due - paid_amount) * interest_rate / 100), status = 'defaulted', defaulted_penalty = (amount_due - paid_amount) * interest_rate / 100 WHERE id = $1"
    : "UPDATE loans SET amount_due = amount_due + ((amount_due - paid_amount) * interest_rate / 100), status = 'defaulted', defaulted_penalty = (amount_due - paid_amount) * interest_rate / 100 WHERE id = ?";
  await db.prepare(updateSql).run(loan.id);
  auditLog(req.session.user, 'default', 'loan', loan.id, 'KES ' + loan.amount + ' manually defaulted');
  await notify(loan.member_id, 'Loan Defaulted', 'KES ' + loan.amount.toLocaleString() + ' loan marked as defaulted', 'error', '/member/loans');
  res.redirect('/admin/loans');
});

router.get('/fines', async (req, res) => {
  const fines = await db.prepare(`
    SELECT f.*, m.first_name, m.last_name, m.member_number
    FROM fines f
    JOIN members m ON f.member_id = m.id
    ORDER BY f.created_at DESC
  `).all();
  const members = await db.prepare("SELECT id, first_name, last_name, member_number FROM members WHERE is_active = 1").all();
  res.renderWithLayout('admin/fines', { fines, members, message: null });
});

router.post('/fines/add', async (req, res) => {
  const { member_id, amount, reason } = req.body;
  if (!member_id || !amount || amount <= 0) return res.redirect('/admin/fines');
  const r = await db.prepare('INSERT INTO fines (member_id, amount, balance, reason, status, created_by, created_by_role) VALUES (?, ?, ?, ?, ?, ?, ?)').run(member_id, amount, amount, reason || 'Late penalty', 'pending', req.session.user.id, req.session.user.admin_role || 'admin');
  auditLog(req.session.user, 'create', 'fine', r.lastInsertRowid, 'KES ' + amount + ' fine for member ' + member_id);
  res.redirect('/admin/fines');
});

router.get('/membercard', async (req, res) => {
  try {
    const cards = await db.prepare(`
      SELECT mc.*, m.first_name, m.last_name, m.member_number
      FROM member_cards mc
      JOIN members m ON mc.member_id = m.id
      ORDER BY mc.created_at DESC
    `).all();
    const members = await db.prepare(`
      SELECT m.id, m.first_name, m.last_name, m.member_number,
        COALESCE(mc.assigned_amount, 0) as assigned, COALESCE(mc.paid_amount, 0) as paid
      FROM members m
      LEFT JOIN member_cards mc ON mc.member_id = m.id
      WHERE m.is_active = 1 ORDER BY m.member_number
    `).all();
    res.renderWithLayout('admin/membercard', { cards, members, message: req.query.message || null, error: req.query.error || null });
  } catch (e) {
    console.error('MEMBERCARD LOAD ERROR:', e.message, e.stack);
    res.renderWithLayout('admin/membercard', { cards: [], members: [], message: null, error: 'Could not load member cards: ' + e.message });
  }
});

router.post('/membercard/assign', async (req, res) => {
  try {
    const member_id = Number(req.body.member_id);
    const amount = parseFloat(req.body.amount);
    if (!member_id || !amount || amount <= 0 || !isFinite(amount)) {
      return res.redirect('/admin/membercard?error=' + encodeURIComponent('Please select a member and enter a valid amount.'));
    }
    const isPg = !!process.env.DATABASE_URL;
    const existing = isPg
      ? await db.prepare("SELECT id FROM member_cards WHERE member_id = $1").get(member_id)
      : await db.prepare("SELECT id FROM member_cards WHERE member_id = ?").get(member_id);
    if (existing) {
      if (isPg) {
        await db.prepare("UPDATE member_cards SET assigned_amount = assigned_amount + $1 WHERE member_id = $2").run(amount, member_id);
      } else {
        await db.prepare("UPDATE member_cards SET assigned_amount = assigned_amount + ? WHERE member_id = ?").run(amount, member_id);
      }
    } else {
      try {
        if (isPg) {
          await db.prepare("INSERT INTO member_cards (member_id, assigned_amount, paid_amount) VALUES ($1, $2, 0)").run(member_id, amount);
        } else {
          await db.prepare("INSERT INTO member_cards (member_id, assigned_amount, paid_amount) VALUES (?, ?, 0)").run(member_id, amount);
        }
      } catch (insertErr) {
        // Race/duplicate: row already exists, fall back to adding onto it
        if (isPg) {
          await db.prepare("UPDATE member_cards SET assigned_amount = assigned_amount + $1 WHERE member_id = $2").run(amount, member_id);
        } else {
          await db.prepare("UPDATE member_cards SET assigned_amount = assigned_amount + ? WHERE member_id = ?").run(amount, member_id);
        }
      }
    }
    auditLog(req.session.user, 'assign', 'member_card', member_id, 'KES ' + amount + ' assigned');
    res.redirect('/admin/membercard?message=' + encodeURIComponent('KES ' + amount.toLocaleString() + ' card amount assigned.'));
  } catch (e) {
    console.error('MEMBERCARD ASSIGN ERROR:', e.message, e.stack);
    res.redirect('/admin/membercard?error=' + encodeURIComponent('Could not assign card amount: ' + e.message));
  }
});

router.get('/reports', async (req, res) => {
  const fundBalances = await db.prepare(`
    SELECT f.name, COALESCE(SUM(mb.balance), 0) as total
    FROM fund_types f
    LEFT JOIN member_balances mb ON mb.fund_type_id = f.id
    GROUP BY f.id
  `).all();

  const memberBalances = await db.prepare(`
    SELECT m.first_name, m.last_name, m.member_number,
      SUM(CASE WHEN mb.fund_type_id = 1 THEN mb.balance ELSE 0 END) as welfare,
      SUM(CASE WHEN mb.fund_type_id = 2 THEN mb.balance ELSE 0 END) as savings,
      SUM(CASE WHEN mb.fund_type_id = 3 THEN mb.balance ELSE 0 END) as loan_fund,
      SUM(CASE WHEN mb.fund_type_id = 4 THEN mb.balance ELSE 0 END) as development,
      SUM(mb.balance) as total
    FROM members m
    JOIN member_balances mb ON mb.member_id = m.id
    GROUP BY m.id
    ORDER BY m.member_number
  `).all();

  const cycleContributions = await db.prepare(`
    SELECT cy.id as cycle_id, cy.start_date, cy.end_date,
      COUNT(DISTINCT c.member_id) as contributing_members,
      COALESCE(SUM(c.amount), 0) as total_contributions
    FROM cycles cy
    LEFT JOIN contributions c ON c.cycle_id = cy.id AND c.status = 'approved'
    GROUP BY cy.id
    ORDER BY cy.start_date DESC
  `).all();

  res.renderWithLayout('admin/reports', { fundBalances, memberBalances, cycleContributions });
});

router.get('/members/:id/contributions', async (req, res) => {
  const member = await db.prepare("SELECT * FROM members WHERE id = ?").get(req.params.id);
  if (!member) return res.redirect('/admin/members');

  const contributions = await db.prepare(`
    SELECT c.amount, c.status, c.created_at, f.name as fund, cy.start_date, cy.end_date
    FROM contributions c
    JOIN fund_types f ON c.fund_type_id = f.id
    JOIN cycles cy ON c.cycle_id = cy.id
    WHERE c.member_id = ?
    ORDER BY cy.start_date DESC, f.id
  `).all(req.params.id);

  const funds = await db.prepare("SELECT * FROM fund_types").all();
  const cycles = await db.prepare("SELECT * FROM cycles ORDER BY start_date DESC").all();

  const cycleData = {};
  contributions.forEach(c => {
    const key = c.start_date + '|' + c.end_date;
    if (!cycleData[key]) cycleData[key] = { start_date: c.start_date, end_date: c.end_date, funds: {} };
    cycleData[key].funds[c.fund] = { amount: c.amount, status: c.status, created_at: c.created_at };
  });

  res.renderWithLayout('admin/member_contributions', { member, cycleData, funds, contributions });
});

router.get('/payments', async (req, res) => {
  try {
    const requests = await db.prepare(`
    SELECT pr.*, m.first_name, m.last_name, m.member_number,
      CASE
        WHEN pr.payment_type = 'fine' THEN (SELECT reason FROM fines WHERE id = pr.reference_id)
        WHEN pr.payment_type = 'loan' THEN 'Loan Repayment'
        ELSE 'Member Card Repayment'
      END as description
    FROM payment_requests pr
    JOIN members m ON pr.member_id = m.id
    ORDER BY pr.created_at DESC
  `).all();
    res.renderWithLayout('admin/payments', { requests, error: req.query.error || null });
  } catch (e) {
    console.error('LOAD PAYMENTS ERROR:', e.message, e.stack);
    res.renderWithLayout('admin/payments', { requests: [], error: 'Could not load payments: ' + e.message });
  }
});

router.post('/payments/approve/:id', async (req, res) => {
  try {
    const reqData = await db.prepare("SELECT * FROM payment_requests WHERE id = ? AND status = 'pending'").get(req.params.id);
    if (!reqData) return res.redirect('/admin/payments');
    const check = checkApprovalRight(req.session.user, reqData);
    if (!check.ok) return res.redirect('/admin/payments?error=' + encodeURIComponent(check.reason));

    await db.transaction(async () => {
      const now = new Date().toISOString();
      await db.prepare("UPDATE payment_requests SET status = 'approved', approved_at = ? WHERE id = ?").run(now, reqData.id);

      if (reqData.payment_type === 'fine') {
        if (reqData.reference_id) {
          const fine = await db.prepare("SELECT * FROM fines WHERE id = ? AND status = 'pending'").get(reqData.reference_id);
          if (fine) {
            const newBalance = fine.balance - reqData.amount;
            if (newBalance <= 0) {
              await db.prepare("UPDATE fines SET balance = 0, status = 'paid' WHERE id = ?").run(fine.id);
            } else {
              await db.prepare('UPDATE fines SET balance = ? WHERE id = ?').run(newBalance, fine.id);
            }
          }
        } else {
          const pendingFines = await db.prepare("SELECT * FROM fines WHERE member_id = ? AND status = 'pending' ORDER BY created_at ASC").all(reqData.member_id);
          let remaining = reqData.amount;
          for (const fine of pendingFines) {
            if (remaining <= 0) break;
            const pay = Math.min(remaining, fine.balance);
            const newBalance = fine.balance - pay;
            if (newBalance <= 0) {
              await db.prepare("UPDATE fines SET balance = 0, status = 'paid' WHERE id = ?").run(fine.id);
            } else {
              await db.prepare('UPDATE fines SET balance = ? WHERE id = ?').run(newBalance, fine.id);
            }
            remaining -= pay;
          }
        }
      } else if (reqData.payment_type === 'member_card') {
        await db.prepare('UPDATE member_cards SET paid_amount = paid_amount + ? WHERE member_id = ?').run(reqData.amount, reqData.member_id);
      } else if (reqData.payment_type === 'loan') {
        const loan = await db.prepare("SELECT * FROM loans WHERE id = ? AND status IN ('active', 'defaulted')").get(reqData.reference_id);
        if (loan) {
          const newPaid = Math.min(loan.paid_amount + reqData.amount, loan.amount_due);
          if (newPaid >= loan.amount_due) {
            await db.prepare("UPDATE loans SET paid_amount = ?, status = 'paid' WHERE id = ?").run(newPaid, loan.id);
          } else {
            await db.prepare('UPDATE loans SET paid_amount = ? WHERE id = ?').run(newPaid, loan.id);
          }
        }
      }
    })();
    const label = { fine: 'Fine', member_card: 'Card', loan: 'Loan' }[reqData.payment_type] || 'Payment';
    auditLog(req.session.user, 'approve', 'payment_request', reqData.id, label + ' payment KES ' + reqData.amount);
    await notify(reqData.member_id, label + ' Payment Approved', 'KES ' + reqData.amount.toLocaleString() + ' ' + label.toLowerCase() + ' payment approved', 'success', '/member');
    res.redirect('/admin/payments');
  } catch (e) {
    console.error('APPROVE PAYMENT ERROR:', e.message, e.stack);
    res.redirect('/admin/payments?error=' + encodeURIComponent('Could not approve: ' + e.message));
  }
});

router.post('/payments/reject/:id', async (req, res) => {
  try {
    const reqData = await db.prepare("SELECT * FROM payment_requests WHERE id = ? AND status = 'pending'").get(req.params.id);
    const check = checkApprovalRight(req.session.user, reqData);
    if (!check.ok) return res.redirect('/admin/payments?error=' + encodeURIComponent(check.reason));
    await db.prepare("UPDATE payment_requests SET status = 'rejected' WHERE id = ? AND status = 'pending'").run(req.params.id);
    if (reqData) {
      const label = { fine: 'Fine', member_card: 'Card', loan: 'Loan' }[reqData.payment_type] || 'Payment';
      auditLog(req.session.user, 'reject', 'payment_request', reqData.id, label + ' payment KES ' + reqData.amount + ' rejected');
      await notify(reqData.member_id, label + ' Payment Rejected', 'KES ' + reqData.amount.toLocaleString() + ' ' + label.toLowerCase() + ' payment was rejected', 'error', '/member');
    }
    res.redirect('/admin/payments');
  } catch (e) {
    console.error('REJECT PAYMENT ERROR:', e.message, e.stack);
    res.redirect('/admin/payments?error=' + encodeURIComponent('Could not reject: ' + e.message));
  }
});

router.get('/withdrawals', async (req, res) => {
  try {
    const requests = await db.prepare(`
    SELECT wr.*, m.first_name, m.last_name, m.member_number, f.name as fund_name
    FROM withdrawal_requests wr
    JOIN members m ON wr.member_id = m.id
    JOIN fund_types f ON wr.fund_type_id = f.id
    ORDER BY wr.created_at DESC
  `).all();
    res.renderWithLayout('admin/withdrawals', { requests, error: req.query.error || null });
  } catch (e) {
    console.error('LOAD WITHDRAWALS ERROR:', e.message, e.stack);
    res.renderWithLayout('admin/withdrawals', { requests: [], error: 'Could not load withdrawals: ' + e.message });
  }
});

router.post('/withdrawals/approve/:id', async (req, res) => {
  try {
    const wr = await db.prepare("SELECT * FROM withdrawal_requests WHERE id = ? AND status = 'pending'").get(req.params.id);
    if (!wr) return res.redirect('/admin/withdrawals');
    const check = checkApprovalRight(req.session.user, wr);
    if (!check.ok) return res.redirect('/admin/withdrawals?error=' + encodeURIComponent(check.reason));
    await db.transaction(async () => {
      await db.prepare("UPDATE withdrawal_requests SET status = 'approved', approved_at = datetime('now') WHERE id = ?").run(wr.id);
      await db.prepare("UPDATE member_balances SET balance = balance - ? WHERE member_id = ? AND fund_type_id = ?").run(wr.amount, wr.member_id, wr.fund_type_id);
    })();
    auditLog(req.session.user, 'approve', 'withdrawal', wr.id, 'KES ' + wr.amount + ' from fund ' + wr.fund_type_id);
    await notify(wr.member_id, 'Withdrawal Approved', 'KES ' + wr.amount.toLocaleString() + ' withdrawal approved', 'success', '/withdraw');
    res.redirect('/admin/withdrawals');
  } catch (e) {
    console.error('APPROVE WITHDRAWAL ERROR:', e.message, e.stack);
    res.redirect('/admin/withdrawals?error=' + encodeURIComponent('Could not approve: ' + e.message));
  }
});

router.post('/withdrawals/reject/:id', async (req, res) => {
  try {
    const wr = await db.prepare("SELECT * FROM withdrawal_requests WHERE id = ? AND status = 'pending'").get(req.params.id);
    const check = checkApprovalRight(req.session.user, wr);
    if (!check.ok) return res.redirect('/admin/withdrawals?error=' + encodeURIComponent(check.reason));
    await db.prepare("UPDATE withdrawal_requests SET status = 'rejected' WHERE id = ?").run(req.params.id);
    if (wr) { auditLog(req.session.user, 'reject', 'withdrawal', wr.id, 'KES ' + wr.amount + ' rejected');
      await notify(wr.member_id, 'Withdrawal Rejected', 'KES ' + wr.amount.toLocaleString() + ' withdrawal request was rejected', 'error', '/withdraw'); }
    res.redirect('/admin/withdrawals');
  } catch (e) {
    console.error('REJECT WITHDRAWAL ERROR:', e.message, e.stack);
    res.redirect('/admin/withdrawals?error=' + encodeURIComponent('Could not reject: ' + e.message));
  }
});

// --- Meeting Attendance ---
router.get('/attendance', async (req, res) => {
  const meetings = await db.prepare("SELECT * FROM meeting_minutes ORDER BY meeting_date DESC").all();
  for (const m of meetings) {
    const total = await db.prepare("SELECT COUNT(*) as c FROM meeting_attendance WHERE meeting_id = ?").get(m.id);
    const present = await db.prepare("SELECT COUNT(*) as c FROM meeting_attendance WHERE meeting_id = ? AND status = 'present'").get(m.id);
    const absent = await db.prepare("SELECT COUNT(*) as c FROM meeting_attendance WHERE meeting_id = ? AND status = 'absent'").get(m.id);
    m.totalMarked = total.c;
    m.presentCount = present.c;
    m.absentCount = absent.c;
  }
  res.renderWithLayout('admin/attendance_list', { meetings, message: req.query.message, error: req.query.error });
});

router.get('/attendance/:meetingId', async (req, res) => {
  const meeting = await db.prepare('SELECT * FROM meeting_minutes WHERE id = ?').get(req.params.meetingId);
  if (!meeting) return res.redirect('/admin/minutes');
  const isPg = !!process.env.DATABASE_URL;
  const members = await db.prepare("SELECT m.id, m.first_name, m.last_name, m.member_number, COALESCE(m.outside_nairobi,0) as outside_nairobi FROM members m WHERE m.is_active = 1 ORDER BY m.member_number").all();
  for (const m of members) {
    const att = await db.prepare("SELECT status, late, no_card, no_neck_card FROM meeting_attendance WHERE meeting_id = ? AND member_id = ?").get(req.params.meetingId, m.id);
    m.attendance_status = att ? att.status : null;
    m.late = att ? att.late : 0;
    m.no_card = att ? att.no_card : 0;
    m.no_neck_card = att ? att.no_neck_card : 0;
  }
  const counts = await db.prepare("SELECT status, COUNT(*) as count FROM meeting_attendance WHERE meeting_id = ? GROUP BY status").all(req.params.meetingId);
  const presentCount = counts.find(function(c) { return c.status === 'present'; })?.count || 0;
  const absentCount = counts.find(function(c) { return c.status === 'absent'; })?.count || 0;
  const excusedCount = counts.find(function(c) { return c.status === 'excused'; })?.count || 0;
  const lateCount = (await db.prepare("SELECT COUNT(*) as c FROM meeting_attendance WHERE meeting_id = ? AND late = 1").get(req.params.meetingId)).c;
  const noCardCount = (await db.prepare("SELECT COUNT(*) as c FROM meeting_attendance WHERE meeting_id = ? AND no_card = 1").get(req.params.meetingId)).c;
  const today = new Date().toISOString().split('T')[0];
  const finesToday = isPg
    ? await db.prepare("SELECT f.*, m.first_name || ' ' || m.last_name as member_name FROM fines f JOIN members m ON f.member_id = m.id WHERE DATE(f.created_at) = $1 ORDER BY f.created_at DESC LIMIT 50").all(today)
    : await db.prepare("SELECT f.*, m.first_name || ' ' || m.last_name as member_name FROM fines f JOIN members m ON f.member_id = m.id WHERE DATE(f.created_at) = ? ORDER BY f.created_at DESC LIMIT 50").all(today);
  res.renderWithLayout('admin/attendance', { meeting, members, presentCount, absentCount, excusedCount, lateCount, noCardCount, finesToday, message: req.query.message || null, error: null });
});

router.post('/attendance/save/:meetingId', async (req, res) => {
  const isPg = !!process.env.DATABASE_URL;
  const members = await db.prepare("SELECT id FROM members WHERE is_active = 1").all();
  for (const m of members) {
    const status = req.body['status_' + m.id] || 'present';
    const late = req.body['late_' + m.id] ? 1 : 0;
    const no_card = req.body['no_card_' + m.id] ? 1 : 0;
    const no_neck_card = req.body['no_neck_card_' + m.id] ? 1 : 0;
    if (isPg) {
      await db.prepare("INSERT INTO meeting_attendance (meeting_id, member_id, status, late, no_card, no_neck_card) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT(meeting_id, member_id) DO UPDATE SET status = $3, late = $4, no_card = $5, no_neck_card = $6").run(req.params.meetingId, m.id, status, late, no_card, no_neck_card);
    } else {
      const existing = await db.prepare("SELECT id FROM meeting_attendance WHERE meeting_id = ? AND member_id = ?").get(req.params.meetingId, m.id);
      if (existing) {
        await db.prepare("UPDATE meeting_attendance SET status = ?, late = ?, no_card = ?, no_neck_card = ? WHERE meeting_id = ? AND member_id = ?").run(status, late, no_card, no_neck_card, req.params.meetingId, m.id);
      } else {
        await db.prepare("INSERT INTO meeting_attendance (meeting_id, member_id, status, late, no_card, no_neck_card) VALUES (?, ?, ?, ?, ?, ?)").run(req.params.meetingId, m.id, status, late, no_card, no_neck_card);
      }
    }
  }
  res.redirect('/admin/attendance/' + req.params.meetingId);
});

// Generic auto-fine helper
async function applyAutoFine(meetingId, ruleName, reasonPrefix, memberFilter, amount, req, res) {
  const meeting = await db.prepare('SELECT * FROM meeting_minutes WHERE id = ?').get(meetingId);
  if (!meeting) { res.redirect('/admin/minutes'); return; }
  const rule = await db.prepare("SELECT amount FROM fine_rules WHERE rule_name = ? AND is_active = 1").get(ruleName);
  const fineAmount = amount || (rule ? rule.amount : 150);
  const isPg = !!process.env.DATABASE_URL;
  let count = 0;
  const targets = await memberFilter(meetingId);
  for (const t of targets) {
    const reason = reasonPrefix + ': ' + meeting.title + ' (' + meeting.meeting_date + ')';
    const likeSql = isPg ? "SELECT id FROM fines WHERE member_id = $1 AND reason ILIKE $2 AND status = 'pending'" : "SELECT id FROM fines WHERE member_id = ? AND reason LIKE ? AND status = 'pending'";
    const existing = await db.prepare(likeSql).get(t.member_id, '%' + reasonPrefix + '%');
    if (!existing) {
      await db.prepare("INSERT INTO fines (member_id, amount, balance, reason, status, created_by, created_by_role) VALUES (?, ?, ?, ?, 'pending', ?, ?)").run(t.member_id, fineAmount, fineAmount, reason, req.session.user.id, req.session.user.admin_role || 'admin');
      count++;
    }
  }
  auditLog(req.session.user, 'auto_fine', 'meeting', meetingId, count + ' fined ' + ruleName + ' KES ' + fineAmount);
  return count;
}

router.post('/attendance/auto-fine/absentism/:meetingId', async (req, res) => {
  const meeting = await db.prepare('SELECT * FROM meeting_minutes WHERE id = ?').get(req.params.meetingId);
  if (!meeting) return res.redirect('/admin/minutes');
  const absentees = await db.prepare("SELECT member_id FROM meeting_attendance WHERE meeting_id = ? AND status = 'absent'").all(req.params.meetingId);
  const rule = await db.prepare("SELECT amount FROM fine_rules WHERE rule_name = 'absentism' AND is_active = 1").get();
  const amount = rule ? rule.amount : 150;
  const isPg = !!process.env.DATABASE_URL;
  let count = 0;
  for (const a of absentees) {
    const reason = 'Absentism: ' + meeting.title + ' (' + meeting.meeting_date + ')';
    const likeSql = isPg ? "SELECT id FROM fines WHERE member_id = $1 AND reason ILIKE $2 AND status = 'pending'" : "SELECT id FROM fines WHERE member_id = ? AND reason LIKE ? AND status = 'pending'";
    const existing = await db.prepare(likeSql).get(a.member_id, '%Absentism%');
    if (!existing) {
      await db.prepare("INSERT INTO fines (member_id, amount, balance, reason, status, created_by, created_by_role) VALUES (?, ?, ?, ?, 'pending', ?, ?)").run(a.member_id, amount, amount, reason, req.session.user.id, req.session.user.admin_role || 'admin');
      count++;
    }
  }
  auditLog(req.session.user, 'auto_fine', 'meeting', req.params.meetingId, count + ' absentees fined KES ' + amount);
  res.redirect('/admin/attendance/' + req.params.meetingId + '?message=' + encodeURIComponent(count + ' absentees fined KES ' + amount));
});

router.post('/attendance/auto-fine/lateness/:meetingId', async (req, res) => {
  const meeting = await db.prepare('SELECT * FROM meeting_minutes WHERE id = ?').get(req.params.meetingId);
  if (!meeting) return res.redirect('/admin/minutes');
  const lateMembers = await db.prepare("SELECT member_id FROM meeting_attendance WHERE meeting_id = ? AND late = 1").all(req.params.meetingId);
  const rule = await db.prepare("SELECT amount FROM fine_rules WHERE rule_name = 'lateness' AND is_active = 1").get();
  const amount = rule ? rule.amount : 100;
  const isPg = !!process.env.DATABASE_URL;
  let count = 0;
  for (const a of lateMembers) {
    const reason = 'Lateness: ' + meeting.title + ' (' + meeting.meeting_date + ')';
    const likeSql = isPg ? "SELECT id FROM fines WHERE member_id = $1 AND reason ILIKE $2 AND status = 'pending'" : "SELECT id FROM fines WHERE member_id = ? AND reason LIKE ? AND status = 'pending'";
    const existing = await db.prepare(likeSql).get(a.member_id, '%Lateness%');
    if (!existing) {
      await db.prepare("INSERT INTO fines (member_id, amount, balance, reason, status, created_by, created_by_role) VALUES (?, ?, ?, ?, 'pending', ?, ?)").run(a.member_id, amount, amount, reason, req.session.user.id, req.session.user.admin_role || 'admin');
      count++;
    }
  }
  auditLog(req.session.user, 'auto_fine', 'meeting', req.params.meetingId, count + ' late members fined KES ' + amount);
  res.redirect('/admin/attendance/' + req.params.meetingId + '?message=' + encodeURIComponent(count + ' late members fined KES ' + amount));
});

router.post('/attendance/auto-fine/no_card/:meetingId', async (req, res) => {
  const meeting = await db.prepare('SELECT * FROM meeting_minutes WHERE id = ?').get(req.params.meetingId);
  if (!meeting) return res.redirect('/admin/minutes');
  const violators = await db.prepare("SELECT member_id FROM meeting_attendance WHERE meeting_id = ? AND no_card = 1").all(req.params.meetingId);
  const rule = await db.prepare("SELECT amount FROM fine_rules WHERE rule_name = 'no_member_card' AND is_active = 1").get();
  const amount = rule ? rule.amount : 300;
  const isPg = !!process.env.DATABASE_URL;
  let count = 0;
  for (const a of violators) {
    const reason = 'No member card: ' + meeting.title + ' (' + meeting.meeting_date + ')';
    const likeSql = isPg ? "SELECT id FROM fines WHERE member_id = $1 AND reason ILIKE $2 AND status = 'pending'" : "SELECT id FROM fines WHERE member_id = ? AND reason LIKE ? AND status = 'pending'";
    const existing = await db.prepare(likeSql).get(a.member_id, '%No member card%');
    if (!existing) {
      await db.prepare("INSERT INTO fines (member_id, amount, balance, reason, status, created_by, created_by_role) VALUES (?, ?, ?, ?, 'pending', ?, ?)").run(a.member_id, amount, amount, reason, req.session.user.id, req.session.user.admin_role || 'admin');
      count++;
    }
  }
  auditLog(req.session.user, 'auto_fine', 'meeting', req.params.meetingId, count + ' no-card members fined KES ' + amount);
  res.redirect('/admin/attendance/' + req.params.meetingId + '?message=' + encodeURIComponent(count + ' members fined KES ' + amount + ' for missing card'));
});

router.post('/attendance/auto-fine/no_neck_card/:meetingId', async (req, res) => {
  const meeting = await db.prepare('SELECT * FROM meeting_minutes WHERE id = ?').get(req.params.meetingId);
  if (!meeting) return res.redirect('/admin/minutes');
  const violators = await db.prepare("SELECT member_id FROM meeting_attendance WHERE meeting_id = ? AND no_neck_card = 1").all(req.params.meetingId);
  const rule = await db.prepare("SELECT amount FROM fine_rules WHERE rule_name = 'no_neck_card' AND is_active = 1").get();
  const amount = rule ? rule.amount : 50;
  const isPg = !!process.env.DATABASE_URL;
  let count = 0;
  for (const a of violators) {
    const reason = 'No neck card: ' + meeting.title + ' (' + meeting.meeting_date + ')';
    const likeSql = isPg ? "SELECT id FROM fines WHERE member_id = $1 AND reason ILIKE $2 AND status = 'pending'" : "SELECT id FROM fines WHERE member_id = ? AND reason LIKE ? AND status = 'pending'";
    const existing = await db.prepare(likeSql).get(a.member_id, '%No neck card%');
    if (!existing) {
      await db.prepare("INSERT INTO fines (member_id, amount, balance, reason, status, created_by, created_by_role) VALUES (?, ?, ?, ?, 'pending', ?, ?)").run(a.member_id, amount, amount, reason, req.session.user.id, req.session.user.admin_role || 'admin');
      count++;
    }
  }
  auditLog(req.session.user, 'auto_fine', 'meeting', req.params.meetingId, count + ' no-neck-card members fined KES ' + amount);
  res.redirect('/admin/attendance/' + req.params.meetingId + '?message=' + encodeURIComponent(count + ' members fined KES ' + amount + ' for missing neck card'));
});

router.post('/attendance/auto-fine/outside_nairobi/:meetingId', async (req, res) => {
  const meeting = await db.prepare('SELECT * FROM meeting_minutes WHERE id = ?').get(req.params.meetingId);
  if (!meeting) return res.redirect('/admin/minutes');
  const isPg = !!process.env.DATABASE_URL;
  const violators = await db.prepare("SELECT member_id FROM meeting_attendance ma JOIN members m ON m.id = ma.member_id WHERE ma.meeting_id = ? AND ma.status = 'absent' AND COALESCE(m.outside_nairobi,0) = 1").all(req.params.meetingId);
  const rule = await db.prepare("SELECT amount FROM fine_rules WHERE rule_name = 'absentism_outside_nairobi' AND is_active = 1").get();
  const amount = rule ? rule.amount : 1000;
  let count = 0;
  for (const v of violators) {
    // Check if they've been absent for 3+ consecutive meetings
    const recent = await db.prepare("SELECT ma.status FROM meeting_attendance ma JOIN meeting_minutes mm ON mm.id = ma.meeting_id WHERE ma.member_id = ? ORDER BY mm.meeting_date DESC LIMIT 3").all(v.member_id);
    const allAbsent = recent.length >= 3 && recent.every(function(a) { return a.status === 'absent'; });
    if (!allAbsent) continue;
    const reason = 'Outside Nairobi absentism (3+ months): ' + meeting.title + ' (' + meeting.meeting_date + ')';
    const likeSql = isPg ? "SELECT id FROM fines WHERE member_id = $1 AND reason ILIKE $2 AND status = 'pending'" : "SELECT id FROM fines WHERE member_id = ? AND reason LIKE ? AND status = 'pending'";
    const existing = await db.prepare(likeSql).get(v.member_id, '%Outside Nairobi absentism%');
    if (!existing) {
      await db.prepare("INSERT INTO fines (member_id, amount, balance, reason, status, created_by, created_by_role) VALUES (?, ?, ?, ?, 'pending', ?, ?)").run(v.member_id, amount, amount, reason, req.session.user.id, req.session.user.admin_role || 'admin');
      count++;
    }
  }
  auditLog(req.session.user, 'auto_fine', 'meeting', req.params.meetingId, count + ' outside-Nairobi absentees fined KES ' + amount);
  res.redirect('/admin/attendance/' + req.params.meetingId + '?message=' + encodeURIComponent(count + ' outside-Nairobi members fined KES ' + amount));
});

// --- Multi-signatory Withdrawal Approval ---
router.get('/withdrawals/approve/chairman/:id', async (req, res) => {
  try {
    const wr = await db.prepare("SELECT * FROM withdrawal_requests WHERE id = ? AND status = 'pending'").get(req.params.id);
    if (!wr) return res.redirect('/admin/withdrawals');
    if (req.session.user.admin_role !== 'chairman') return res.redirect('/admin/withdrawals');
    // Idempotency: chairman already acted on this request
    if (wr.approval_level === 'pending_treasurer' || wr.approval_level === 'approved') return res.redirect('/admin/withdrawals');
    const check = checkApprovalRight(req.session.user, wr);
    if (!check.ok) return res.redirect('/admin/withdrawals?error=' + encodeURIComponent(check.reason));
    // NOTE: keep status='pending' (CHECK constraint only allows pending/approved/rejected).
    // Two-step progress is tracked via approval_level.
    await db.prepare("UPDATE withdrawal_requests SET approval_level = 'pending_treasurer', status = 'pending' WHERE id = ?").run(req.params.id);
    auditLog(req.session.user, 'approve_level1', 'withdrawal', wr.id, 'Chairman approved KES ' + wr.amount);
    await notify(wr.member_id, 'Withdrawal: Chairman Approved', 'Chairman approved your withdrawal, awaiting treasurer', 'info', '/withdraw');
    res.redirect('/admin/withdrawals');
  } catch (e) {
    console.error('CHAIRMAN WITHDRAWAL APPROVE ERROR:', e.message, e.stack);
    res.redirect('/admin/withdrawals?error=' + encodeURIComponent('Could not approve: ' + e.message));
  }
});

router.get('/withdrawals/approve/treasurer/:id', async (req, res) => {
  try {
    // Accept legacy 'pending_chairman' status too (in case an old DB somehow has it).
    const wr = await db.prepare("SELECT * FROM withdrawal_requests WHERE id = ? AND (status = 'pending_chairman' OR status = 'pending')").get(req.params.id);
    if (!wr) return res.redirect('/admin/withdrawals');
    if (req.session.user.admin_role !== 'treasurer') return res.redirect('/admin/withdrawals');
    const check = checkApprovalRight(req.session.user, wr);
    if (!check.ok) return res.redirect('/admin/withdrawals?error=' + encodeURIComponent(check.reason));
    await db.transaction(async () => {
      await db.prepare("UPDATE withdrawal_requests SET status = 'approved', approval_level = 'approved', approved_at = datetime('now') WHERE id = ?").run(wr.id);
      await db.prepare("UPDATE member_balances SET balance = balance - ? WHERE member_id = ? AND fund_type_id = ?").run(wr.amount, wr.member_id, wr.fund_type_id);
    })();
    auditLog(req.session.user, 'approve_level2', 'withdrawal', wr.id, 'Treasurer approved KES ' + wr.amount);
    await notify(wr.member_id, 'Withdrawal Approved', 'KES ' + wr.amount.toLocaleString() + ' withdrawal fully approved', 'success', '/withdraw');
    res.redirect('/admin/withdrawals');
  } catch (e) {
    console.error('TREASURER WITHDRAWAL APPROVE ERROR:', e.message, e.stack);
    res.redirect('/admin/withdrawals?error=' + encodeURIComponent('Could not approve: ' + e.message));
  }
});

// --- Data Backup ---
router.get('/backup', async (req, res) => {
  const tables = ['members', 'users', 'fund_types', 'cycles', 'contributions', 'member_balances', 'loans', 'fines', 'member_cards', 'payment_requests', 'notifications', 'withdrawal_requests', 'welfare_requests', 'meeting_minutes', 'meeting_attendance', 'fine_rules'];
  const backup = {};
  for (const t of tables) {
    try { const rows = await db.prepare('SELECT * FROM ' + t).all(); backup[t] = rows; } catch(e) { backup[t] = []; }
  }
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="apwoche_backup_' + new Date().toISOString().split('T')[0] + '.json"');
  res.json(backup);
});

module.exports = router;
