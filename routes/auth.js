const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.user) {
    return req.session.user.role === 'admin' ? res.redirect('/admin') : res.redirect('/member');
  }
  res.render('login', { error: null, success: null });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.render('login', { error: 'Enter username and password', success: null });
  }

  const user = await db.prepare(`
    SELECT u.*, m.first_name, m.last_name, m.member_number 
    FROM users u 
    LEFT JOIN members m ON u.member_id = m.id 
    WHERE u.username = ?
  `).get(username);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.render('login', { error: 'Invalid username or password', success: null });
  }

  req.session.user = {
    id: user.id,
    username: user.username,
    role: user.role,
    admin_role: user.admin_role || null,
    memberId: user.member_id,
    memberName: user.first_name ? `${user.first_name} ${user.last_name}` : 'Admin',
    memberNumber: user.member_number
  };

  if (user.role === 'admin') {
    if (user.admin_role === 'secretary' || user.admin_role === 'welfare') {
      return res.redirect('/member');
    }
    return res.redirect('/admin');
  }
  res.redirect('/member');
});

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

module.exports = router;
