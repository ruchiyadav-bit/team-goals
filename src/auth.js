// Authentication: login/logout, JWT http-only cookie sessions, auth middleware.
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { getJwtSecret } = require('./db');

const COOKIE = 'tgc_token';
const SECURE = process.env.NODE_ENV === 'production';

function publicUser(u) {
  return {
    id: u.id, username: u.username, name: u.name, role: u.role,
    vertical: u.vertical, leader_id: u.leader_id, manager_id: u.manager_id, active: u.active,
  };
}

function authRouter(db) {
  const r = express.Router();

  r.post('/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim());
    if (!u || !u.active || !bcrypt.compareSync(String(password), u.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ id: u.id }, getJwtSecret(), { expiresIn: '7d' });
    res.cookie(COOKIE, token, {
      httpOnly: true, sameSite: 'lax', secure: SECURE, maxAge: 7 * 24 * 3600 * 1000,
    });
    res.json({ user: publicUser(u) });
  });

  r.post('/logout', (req, res) => {
    res.clearCookie(COOKIE);
    res.json({ ok: true });
  });

  return r;
}

function requireAuth(db) {
  return (req, res, next) => {
    const token = req.cookies && req.cookies[COOKIE];
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    let payload;
    try {
      payload = jwt.verify(token, getJwtSecret());
    } catch {
      return res.status(401).json({ error: 'Session expired' });
    }
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
    if (!u || !u.active) return res.status(401).json({ error: 'Account disabled' });
    req.user = u;
    next();
  };
}

module.exports = { authRouter, requireAuth, publicUser };
