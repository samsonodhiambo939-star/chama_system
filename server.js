require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { initDatabase, seedMembers } = require('./schema');

const app = express();

app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'chama_secret_key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// --- Shared middleware ---
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.pageTitle = 'Dashboard';
  res.locals.header = (title) => { res.locals.pageTitle = title || 'Dashboard'; };
  res.renderWithLayout = (view, options = {}) => {
    const merged = { ...options, user: req.session.user || null, body: '' };
    res.render(view, merged, (err, html) => {
      if (err) return res.status(500).send('Render error: ' + err.message);
      merged.body = html;
      res.render('layout', merged);
    });
  };
  next();
});

// --- Input validation helper ---
global.sanitize = (v) => (v === null || v === undefined ? '' : String(v).trim());
global.toNumber = (v, def = 0) => { const n = parseFloat(v); return isNaN(n) ? def : Math.max(0, n); };
global.escapeHtml = (v) => String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// --- Rate limiting (login) ---
const loginAttempts = {};
app.use('/login', (req, res, next) => {
  if (req.method !== 'POST') return next();
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  if (!loginAttempts[ip]) loginAttempts[ip] = [];
  loginAttempts[ip] = loginAttempts[ip].filter(t => now - t < 60000);
  if (loginAttempts[ip].length >= 5) {
    return res.render('login', { error: 'Too many attempts. Try again in 1 minute.' });
  }
  loginAttempts[ip].push(now);
  next();
});

// --- Auto DB backup ---
function backupDB() {
  try {
    const dbPath = path.join(__dirname, 'chama.db');
    if (!fs.existsSync(dbPath)) return;
    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    fs.copyFileSync(dbPath, path.join(backupDir, `chama_${date}.db`));
    const files = fs.readdirSync(backupDir).filter(f => f.startsWith('chama_')).sort().reverse();
    for (let i = 7; i < files.length; i++) fs.unlinkSync(path.join(backupDir, files[i]));
  } catch(e) { console.error('Backup error:', e.message); }
}
setInterval(backupDB, 3600000);
backupDB();

// --- Routes ---
const db = require('./db');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const memberRoutes = require('./routes/member');

app.use('/', authRoutes);

// --- Bulk approve (must be before admin router to avoid /:id catch-all) ---
app.post('/admin/contributions/approve-all', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/');
  const pending = await db.prepare("SELECT * FROM contributions WHERE status = 'pending' AND amount > 0").all();
  const trans = await db.transaction(async () => {
    for (const c of pending) {
      await db.prepare("UPDATE contributions SET status = 'approved' WHERE id = ?").run(c.id);
      const upd = await db.prepare("UPDATE member_balances SET balance = balance + ? WHERE member_id = ? AND fund_type_id = ?").run(c.amount, c.member_id, c.fund_type_id);
      if (upd.changes === 0) {
        await db.prepare("INSERT INTO member_balances (member_id, fund_type_id, balance) VALUES (?, ?, ?)").run(c.member_id, c.fund_type_id, c.amount);
      }
      await notify(c.member_id, 'Contribution Approved', 'KES ' + c.amount.toLocaleString() + ' contribution approved', 'success', '/member');
    }
  });
  await trans();
  auditLog(req.session.user, 'bulk_approve', 'contribution', null, 'Approved ' + pending.length + ' contributions');
  res.redirect('/admin/approvals');
});

app.post('/admin/payments/approve-all', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/');
  const pending = await db.prepare("SELECT * FROM payment_requests WHERE status = 'pending'").all();
  const trans = await db.transaction(async () => {
    for (const r of pending) {
      const now = new Date().toISOString();
      await db.prepare("UPDATE payment_requests SET status = 'approved', approved_at = ? WHERE id = ?").run(now, r.id);
      if (r.payment_type === 'fine') {
        const pendingFines = await db.prepare("SELECT * FROM fines WHERE member_id = ? AND status = 'pending' ORDER BY created_at ASC").all(r.member_id);
        let remaining = r.amount;
        for (const fine of pendingFines) {
          if (remaining <= 0) break;
          const pay = Math.min(remaining, fine.balance);
          const nb = fine.balance - pay;
          if (nb <= 0) {
            await db.prepare("UPDATE fines SET balance = 0, status = 'paid' WHERE id = ?").run(fine.id);
          } else {
            await db.prepare("UPDATE fines SET balance = ? WHERE id = ?").run(nb, fine.id);
          }
          remaining -= pay;
        }
      } else if (r.payment_type === 'member_card') {
        await db.prepare("UPDATE member_cards SET paid_amount = paid_amount + ? WHERE member_id = ?").run(r.amount, r.member_id);
      } else if (r.payment_type === 'loan') {
        const loan = await db.prepare("SELECT * FROM loans WHERE id = ? AND status IN ('active', 'defaulted')").get(r.reference_id);
        if (loan) {
          const np = Math.min(loan.paid_amount + r.amount, loan.amount_due);
          if (np >= loan.amount_due) {
            await db.prepare("UPDATE loans SET paid_amount = ?, status = 'paid' WHERE id = ?").run(np, loan.id);
          } else {
            await db.prepare("UPDATE loans SET paid_amount = ? WHERE id = ?").run(np, loan.id);
          }
        }
      }
      await notify(r.member_id, 'Payment Approved', 'KES ' + r.amount.toLocaleString() + ' payment approved', 'success', '/member');
    }
  });
  await trans();
  auditLog(req.session.user, 'bulk_approve', 'payment', null, 'Approved ' + pending.length + ' payment requests');
  res.redirect('/admin/payments');
});

// --- Welfare requests (must be before admin router) ---
app.get('/member/welfare', async (req, res) => {
  if (!req.session.user || !req.session.user.memberId) return res.redirect('/login');
  const memberId = req.session.user.memberId;
  const welfareBalance = await db.prepare("SELECT COALESCE(balance,0) as b FROM member_balances WHERE member_id = ? AND fund_type_id = 1").get(memberId);
  const requests = await db.prepare("SELECT * FROM welfare_requests WHERE member_id = ? ORDER BY created_at DESC").all(memberId);
  const pendingAmt = await db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM welfare_requests WHERE member_id = ? AND status = 'pending'").get(memberId);
  res.renderWithLayout('member/welfare', { user: req.session.user, balance: welfareBalance.b, requests, pendingAmt: pendingAmt.t, error: null, message: null, pageTitle: 'Welfare Request', success: req.query.success || null });
});

app.post('/member/welfare', async (req, res) => {
  if (!req.session.user || !req.session.user.memberId) return res.redirect('/login');
  const memberId = req.session.user.memberId;
  const { amount, reason, beneficiary_name, beneficiary_id_number, relationship, description } = req.body;
  if (!amount || amount <= 0 || !beneficiary_name || !beneficiary_id_number || !relationship) {
    const welfareBalance = await db.prepare("SELECT COALESCE(balance,0) as b FROM member_balances WHERE member_id = ? AND fund_type_id = 1").get(memberId);
    const requests = await db.prepare("SELECT * FROM welfare_requests WHERE member_id = ? ORDER BY created_at DESC").all(memberId);
    const pendingAmt = await db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM welfare_requests WHERE member_id = ? AND status = 'pending'").get(memberId);
    return res.renderWithLayout('member/welfare', { user: req.session.user, balance: welfareBalance.b, requests, pendingAmt: pendingAmt.t, error: 'All fields required', message: null, pageTitle: 'Welfare Request', success: null });
  }
  await db.prepare("INSERT INTO welfare_requests (member_id, amount, reason, beneficiary_name, beneficiary_id_number, relationship, description) VALUES (?, ?, ?, ?, ?, ?, ?)").run(memberId, amount, reason, beneficiary_name, beneficiary_id_number, relationship, description || null);
  await notify(null, 'Welfare Request', req.session.user.memberName + ' requested KES ' + Number(amount).toLocaleString() + ' welfare: ' + reason, 'warning', '/admin/welfare');
  auditLog(req.session.user, 'create', 'welfare_request', null, 'KES ' + amount + ' welfare for ' + beneficiary_name);
  res.redirect('/member/welfare?success=1');
});

app.get('/admin/welfare', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/login');
  const requests = await db.prepare("SELECT wr.*, m.first_name, m.last_name, m.member_number FROM welfare_requests wr JOIN members m ON wr.member_id = m.id ORDER BY wr.created_at DESC").all();
  res.renderWithLayout('admin/welfare', { user: req.session.user, requests, pageTitle: 'Welfare Requests', error: req.query.error || null });
});

app.post('/admin/welfare/approve/:id', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/login');
  const wr = await db.prepare("SELECT * FROM welfare_requests WHERE id = ? AND status = 'pending'").get(req.params.id);
  if (!wr) return res.redirect('/admin/welfare');
  const welfareFund = await db.prepare("SELECT COALESCE(SUM(balance),0) as t FROM member_balances WHERE fund_type_id = 1").get();
  if (welfareFund.t < wr.amount) return res.redirect('/admin/welfare?error=insufficient');
  await db.transaction(async function() {
    await db.prepare("UPDATE welfare_requests SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?").run(req.session.user.id, wr.id);
    await db.prepare("UPDATE member_balances SET balance = balance - ? WHERE member_id = ? AND fund_type_id = 1").run(wr.amount, wr.member_id);
  })();
  await notify(wr.member_id, 'Welfare Approved', 'KES ' + wr.amount.toLocaleString() + ' welfare approved', 'success', '/member/welfare');
  auditLog(req.session.user, 'approve', 'welfare_request', wr.id, 'KES ' + wr.amount);
  res.redirect('/admin/welfare');
});

app.post('/admin/welfare/reject/:id', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/login');
  const wr = await db.prepare("SELECT * FROM welfare_requests WHERE id = ? AND status = 'pending'").get(req.params.id);
  if (wr) { await db.prepare("UPDATE welfare_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?").run(req.session.user.id, wr.id);
    await notify(wr.member_id, 'Welfare Rejected', 'KES ' + wr.amount.toLocaleString() + ' welfare rejected', 'error', '/member/welfare');
    auditLog(req.session.user, 'reject', 'welfare_request', wr.id, 'KES ' + wr.amount); }
  res.redirect('/admin/welfare');
});

// --- Welfare Registration (admin view) ---
app.get('/admin/welfare/registrations', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/login');
  if (!['chairman','treasurer','welfare'].includes(req.session.user.admin_role)) return res.redirect('/admin');
  const regs = await db.prepare(`
    SELECT wr.*, m.first_name, m.last_name, m.member_number 
    FROM welfare_registrations wr 
    JOIN members m ON wr.member_id = m.id 
    WHERE wr.status IN ('submitted','locked')
    ORDER BY wr.submitted_at DESC
  `).all();
  res.renderWithLayout('admin/welfare_registrations', { user: req.session.user, registrations: regs, pageTitle: 'Welfare Registrations' });
});

app.get('/admin/welfare/registrations/:id', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/login');
  if (!['chairman','treasurer','welfare'].includes(req.session.user.admin_role)) return res.redirect('/admin');
  const reg = await db.prepare(`
    SELECT wr.*, m.first_name, m.last_name, m.member_number 
    FROM welfare_registrations wr 
    JOIN members m ON wr.member_id = m.id 
    WHERE wr.id = ?
  `).get(req.params.id);
  if (!reg) return res.redirect('/admin/welfare/registrations');
  const formData = JSON.parse(reg.form_data || '{}');
  res.renderWithLayout('admin/welfare_registration_detail', { user: req.session.user, reg, formData, pageTitle: 'Welfare Registration' });
});

app.post('/admin/welfare/registrations/unlock/:id', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/login');
  if (!['chairman','treasurer'].includes(req.session.user.admin_role)) return res.redirect('/admin');
  await db.prepare("UPDATE welfare_registrations SET locked = 0, status = 'draft', edit_requested = 0 WHERE id = ?").run(req.params.id);
  auditLog(req.session.user, 'unlock', 'welfare_registration', req.params.id, 'Form unlocked for editing');
  res.redirect('/admin/welfare/registrations');
});

// --- Meeting minutes (secretary, must be before admin router) ---
app.get('/admin/minutes', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/login');
  const minutes = await db.prepare("SELECT * FROM meeting_minutes ORDER BY meeting_date DESC").all();
  res.renderWithLayout('admin/minutes', { user: req.session.user, minutes, error: null, message: null, pageTitle: 'Meeting Minutes' });
});

app.post('/admin/minutes/add', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/login');
  const { title, meeting_date, content } = req.body;
  if (!title || !meeting_date || !content) return res.redirect('/admin/minutes');
  await db.prepare("INSERT INTO meeting_minutes (title, meeting_date, content, created_by) VALUES (?, ?, ?, ?)").run(title, meeting_date, content, req.session.user.id);
  res.redirect('/admin/minutes');
});

app.post('/admin/minutes/edit/:id', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/login');
  const { title, meeting_date, content } = req.body;
  if (!title || !meeting_date || !content) return res.redirect('/admin/minutes');
  await db.prepare("UPDATE meeting_minutes SET title = ?, meeting_date = ?, content = ?, updated_at = datetime('now') WHERE id = ?").run(title, meeting_date, content, req.params.id);
  res.redirect('/admin/minutes');
});

app.post('/admin/minutes/delete/:id', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/login');
  await db.prepare("DELETE FROM meeting_minutes WHERE id = ?").run(req.params.id);
  res.redirect('/admin/minutes');
});

app.use('/admin', adminRoutes);

app.use('/member', memberRoutes);

app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role === 'admin') {
    const roleMap = { secretary: '/admin/minutes', welfare: '/admin/welfare' };
    return res.redirect(roleMap[req.session.user.admin_role] || '/admin');
  }
  res.redirect('/member');
});

app.get('/download', (req, res) => {
  res.render('download', { user: req.session.user || null });
});

// --- CSV Export ---
app.get('/export/:table', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const allowed = ['members', 'contributions', 'loans', 'fines', 'member_balances', 'cycles', 'payment_requests'];
  if (!allowed.includes(req.params.table)) return res.redirect('/');
  let data;
  try {
    data = await db.prepare(`SELECT * FROM ${req.params.table} ORDER BY id DESC`).all();
  } catch(e) { return res.redirect('/'); }
  if (data.length === 0) return res.redirect('/');
  const headers = Object.keys(data[0]);
  let csv = headers.join(',') + '\n';
  data.forEach(row => {
    csv += headers.map(h => `"${String(row[h] || '').replace(/"/g,'""')}"`).join(',') + '\n';
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.table}_export.csv"`);
  res.send(csv);
});

// --- Profile ---
app.get('/profile', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const memberId = req.session.user.memberId;
  const error = req.query.error || null;
  const success = req.query.success || null;
  if (!memberId) return res.render('profile', { user: req.session.user, member: null, error, success });
  const member = await db.prepare("SELECT * FROM members WHERE id = ?").get(memberId);
  const funds = await db.prepare(`
    SELECT f.name, COALESCE(mb.balance,0) as balance FROM fund_types f
    LEFT JOIN member_balances mb ON mb.fund_type_id = f.id AND mb.member_id = ?
    ORDER BY f.id
  `).all(memberId);
  const totalActiveLoan = (await db.prepare("SELECT COALESCE(SUM(amount_due),0) as t FROM loans WHERE member_id = ? AND status = 'active'").get(memberId)).t;
  const totalContributions = (await db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM contributions WHERE member_id = ? AND status = 'approved'").get(memberId)).t;
  res.render('profile', { user: req.session.user, member, funds, totalActiveLoan, totalContributions, error, success });
});

app.post('/profile', async (req, res) => {
  if (!req.session.user || !req.session.user.memberId) return res.redirect('/login');
  const memberId = req.session.user.memberId;
  const phone = sanitize(req.body.phone);
  const first_name = sanitize(req.body.first_name);
  const last_name = sanitize(req.body.last_name);
  try {
    await db.prepare("UPDATE members SET phone = ?, first_name = ?, last_name = ? WHERE id = ?").run(phone || null, first_name, last_name, memberId);
    req.session.user.memberName = `${first_name} ${last_name}`;
  } catch(e) {}
  res.redirect('/profile?updated=1');
});

app.post('/profile/password', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const { current_password, new_password, confirm_password } = req.body;
  if (new_password.length < 6) return res.redirect('/profile?error=Password must be at least 6 characters');
  if (new_password !== confirm_password) return res.redirect('/profile?error=Passwords do not match');
  const user = await db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.user.id);
  if (!user || !bcrypt.compareSync(current_password, user.password_hash)) {
    return res.redirect('/profile?error=Current password is incorrect');
  }
  const hash = bcrypt.hashSync(new_password, 10);
  await db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, req.session.user.id);
  res.redirect('/profile?success=Password changed successfully');
});

app.post('/change-password', async (req, res) => {
  const { username, current_password, new_password, confirm_password } = req.body;
  if (!username || !current_password || !new_password || !confirm_password) {
    return res.render('login', { error: 'All fields are required' });
  }
  if (new_password.length < 6) {
    return res.render('login', { error: 'New password must be at least 6 characters' });
  }
  if (new_password !== confirm_password) {
    return res.render('login', { error: 'Passwords do not match' });
  }
  const user = await db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user || !bcrypt.compareSync(current_password, user.password_hash)) {
    return res.render('login', { error: 'Invalid username or current password' });
  }
  const hash = bcrypt.hashSync(new_password, 10);
  await db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, user.id);
  res.render('login', { error: null, success: 'Password updated! You can now sign in with your new password.' });
});

// --- Withdrawals ---
app.get('/withdraw', async (req, res) => {
  if (!req.session.user || !req.session.user.memberId) return res.redirect('/login');
  const memberId = req.session.user.memberId;
  const funds = await db.prepare(`
    SELECT f.id, f.name, COALESCE(mb.balance,0) as balance FROM fund_types f
    LEFT JOIN member_balances mb ON mb.fund_type_id = f.id AND mb.member_id = ?
    ORDER BY f.id
  `).all(memberId);
  const requests = await db.prepare(`
    SELECT wr.*, f.name as fund_name FROM withdrawal_requests wr
    JOIN fund_types f ON wr.fund_type_id = f.id
    WHERE wr.member_id = ? ORDER BY wr.created_at DESC
  `).all(memberId);
  res.render('withdraw', { user: req.session.user, funds, requests, error: null });
});

app.post('/withdraw', async (req, res) => {
  if (!req.session.user || !req.session.user.memberId) return res.redirect('/login');
  const memberId = req.session.user.memberId;
  const fund_type_id = toNumber(req.body.fund_type_id);
  const amount = toNumber(req.body.amount);
  if (!fund_type_id || amount <= 0) return res.redirect('/withdraw');
  const bal = await db.prepare("SELECT COALESCE(balance,0) as b FROM member_balances WHERE member_id = ? AND fund_type_id = ?").get(memberId, fund_type_id);
  if (!bal || bal.b < amount) return res.redirect('/withdraw');
  await db.prepare("INSERT INTO withdrawal_requests (member_id, fund_type_id, amount) VALUES (?, ?, ?)").run(memberId, fund_type_id, amount);
  await db.prepare("INSERT INTO notifications (member_id, title, message, type, link) VALUES (?, 'Withdrawal Request', ?, 'warning', '/admin/approvals')").run(null, `${req.session.user.memberName} requested KES ${amount.toLocaleString()} withdrawal`);
  auditLog(req.session.user, 'create', 'withdrawal_request', null, `KES ${amount} withdrawal requested from fund ${fund_type_id}`);
  res.redirect('/withdraw');
});

// --- Receipt ---
app.get('/receipt/:type/:id', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const { type, id } = req.params;
  let data, title;
  if (type === 'contribution') {
    data = await db.prepare("SELECT c.*, f.name as fund, m.first_name, m.last_name, m.member_number, cy.start_date, cy.end_date FROM contributions c JOIN fund_types f ON c.fund_type_id = f.id JOIN members m ON c.member_id = m.id JOIN cycles cy ON c.cycle_id = cy.id WHERE c.id = ?").get(id);
    if (!data) return res.redirect('/');
    title = 'Contribution Receipt';
  } else if (type === 'loan') {
    data = await db.prepare("SELECT l.*, m.first_name, m.last_name, m.member_number FROM loans l JOIN members m ON l.member_id = m.id WHERE l.id = ?").get(id);
    if (!data) return res.redirect('/');
    title = 'Loan Repayment Receipt';
  } else if (type === 'fine') {
    data = await db.prepare("SELECT f.*, m.first_name, m.last_name, m.member_number FROM fines f JOIN members m ON f.member_id = m.id WHERE f.id = ?").get(id);
    if (!data) return res.redirect('/');
    title = 'Fine Payment Receipt';
  } else if (type === 'card') {
    data = await db.prepare("SELECT mc.*, m.first_name, m.last_name, m.member_number FROM member_cards mc JOIN members m ON mc.member_id = m.id WHERE mc.id = ?").get(id);
    if (!data) return res.redirect('/');
    title = 'Member Card Receipt';
  } else { return res.redirect('/'); }
  res.render('receipt', { title, data, type, user: req.session.user });
});

// --- Chart data API ---
app.get('/api/chart/contributions', async (req, res) => {
  if (!req.session.user || !req.session.user.memberId) return res.json([]);
  const memberId = req.session.user.memberId;
  const cycles = await db.prepare("SELECT id, start_date, end_date FROM cycles ORDER BY start_date ASC LIMIT 6").all();
  const result = [];
  for (const cy of cycles) {
    const row = { cycle: cy.start_date + ' - ' + cy.end_date };
    const funds = await db.prepare("SELECT f.name, COALESCE(SUM(c.amount),0) as total FROM contributions c JOIN fund_types f ON c.fund_type_id = f.id WHERE c.member_id = ? AND c.cycle_id = ? AND c.status = 'approved' GROUP BY f.id").all(memberId, cy.id);
    funds.forEach(f => { row[f.name] = f.total; });
    result.push(row);
  }
  res.json(result);
});

// --- Notifications API ---
app.get('/api/notifications', async (req, res) => {
  if (!req.session.user) return res.json([]);
  const memberId = req.session.user.memberId;
  const userId = req.session.user.id;
  let notifs;
  if (req.session.user.role === 'admin') {
    notifs = await db.prepare("SELECT * FROM notifications WHERE user_id IS NULL OR member_id IS NULL ORDER BY created_at DESC LIMIT 20").all();
  } else {
    notifs = await db.prepare("SELECT * FROM notifications WHERE member_id = ? ORDER BY created_at DESC LIMIT 20").all(memberId);
  }
  res.json(notifs);
});

app.post('/api/notifications/read/:id', async (req, res) => {
  await db.prepare("UPDATE notifications SET is_read = 1 WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/member/photo', async (req, res) => {
  if (!req.session.user || !req.session.user.memberId) return res.json({ photo: null });
  const member = await db.prepare('SELECT photo FROM members WHERE id = ?').get(req.session.user.memberId);
  res.json({ photo: member?.photo || null });
});

// --- Audit log helper ---
async function auditLog(user, action, entityType, entityId, details) {
  try { await db.prepare("INSERT INTO audit_logs (user_id, username, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?, ?)").run(user.id, user.username, action, entityType, entityId || null, details || null); } catch(e) {}
}
global.auditLog = auditLog;

// --- Notification helper ---
async function notify(memberId, title, message, type, link) {
  try { await db.prepare("INSERT INTO notifications (member_id, title, message, type, link) VALUES (?, ?, ?, ?, ?)").run(memberId, title, message, type || 'info', link || null); } catch(e) {}
}
global.notify = notify;

global.db = db;

// --- 404 handler (after all routes) ---
app.use((req, res) => {
  res.status(404).render('error', { message: 'Page not found', user: req.session.user || null, pageTitle: 'Not Found' });
});

// --- Global error handler ---
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message || err);
  console.error('Stack:', err.stack);
  if (req.headers.accept && req.headers.accept.includes('text/html')) {
    if (req.session && req.session.user) {
      return res.status(500).render('error', { message: 'Something went wrong. Please try again.', user: req.session.user });
    }
    return res.status(500).send('Server error. Please try again.');
  }
  res.status(500).json({ error: 'Server error' });
});

const PORT = process.env.PORT || 3000;

(async () => {
  await initDatabase();
  await seedMembers();

  const isPg = !!process.env.DATABASE_URL;
  const q = (sql, ...params) => isPg ? db.prepare(sql).run(...params) : db.prepare(sql).run(...params);
  const g = (sql, ...params) => isPg ? db.prepare(sql).get(...params) : db.prepare(sql).get(...params);

  let cycleCount = g('SELECT COUNT(*) as c FROM cycles');
  if (cycleCount.c === 0) {
    const today = new Date();
    const end = new Date(today);
    end.setDate(end.getDate() + 14);
    const sql = isPg ? "INSERT INTO cycles (start_date, end_date, is_open, is_processed) VALUES ($1, $2, 1, 0)" : "INSERT INTO cycles (start_date, end_date, is_open, is_processed) VALUES (?, ?, 1, 0)";
    await db.prepare(sql).run(today.toISOString().split('T')[0], end.toISOString().split('T')[0]);
  }

  // Auto-close expired cycles and open next
  const openCycle = g("SELECT * FROM cycles WHERE is_open = 1 ORDER BY id DESC LIMIT 1");
  if (openCycle) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const endDate = new Date(openCycle.end_date);
    endDate.setDate(endDate.getDate() + 1);
    endDate.setHours(0, 0, 0, 0);
    if (today >= endDate) {
      await q("UPDATE cycles SET is_open = 0, is_processed = 1 WHERE id = ?", openCycle.id);
      const lastCycle = g("SELECT end_date FROM cycles ORDER BY id DESC LIMIT 1");
      if (lastCycle) {
        const newStart = new Date(lastCycle.end_date);
        newStart.setDate(newStart.getDate() + 1);
        const newEnd = new Date(newStart);
        newEnd.setDate(newEnd.getDate() + 14);
        const sql = isPg ? "INSERT INTO cycles (start_date, end_date, is_open, is_processed) VALUES ($1, $2, 1, 0)" : "INSERT INTO cycles (start_date, end_date, is_open, is_processed) VALUES (?, ?, 1, 0)";
        await db.prepare(sql).run(newStart.toISOString().split('T')[0], newEnd.toISOString().split('T')[0]);
        console.log('Auto-created new cycle');
      }
    }
  }

  if (isPg) {
    try { await db.prepare("SELECT setval('loans_id_seq', COALESCE((SELECT MAX(id) FROM loans), 1))").run(); } catch(e) {}
    try { await db.prepare("SELECT setval('contributions_id_seq', COALESCE((SELECT MAX(id) FROM contributions), 1))").run(); } catch(e) {}
    try { await db.prepare("SELECT setval('payment_requests_id_seq', COALESCE((SELECT MAX(id) FROM payment_requests), 1))").run(); } catch(e) {}
    try { await db.prepare("SELECT setval('fines_id_seq', COALESCE((SELECT MAX(id) FROM fines), 1))").run(); } catch(e) {}
    try { await db.prepare("SELECT setval('withdrawal_requests_id_seq', COALESCE((SELECT MAX(id) FROM withdrawal_requests), 1))").run(); } catch(e) {}
    try { await db.prepare("SELECT setval('cycles_id_seq', COALESCE((SELECT MAX(id) FROM cycles), 1))").run(); } catch(e) {}
  }

  app.listen(PORT, () => {
    console.log(`Chama System running at http://localhost:${PORT}`);
    console.log('DEPLOY v10 - clean, all penalties correct');
  });
})();
