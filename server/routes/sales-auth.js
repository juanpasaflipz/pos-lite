import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { adminSql } from '../db/index.js';
import { requireSalesAuth } from '../middleware/salesAuth.js';
import { JWT_SECRET, JWT_SALES_EXPIRY } from '../lib/constants.js';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' },
});

// ── POST /api/sales/auth/login ──
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const [rep] = await adminSql`
      SELECT id, email, name, phone, role, password_hash, active
      FROM sales_reps WHERE email = ${cleanEmail}
    `;

    if (!rep) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!rep.active) {
      return res.status(401).json({ error: 'Account is inactive' });
    }

    const valid = await bcrypt.compare(password, rep.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { type: 'sales_rep', repId: rep.id, email: rep.email, role: rep.role },
      JWT_SECRET,
      { expiresIn: JWT_SALES_EXPIRY }
    );

    res.json({
      token,
      rep: { id: rep.id, email: rep.email, name: rep.name, phone: rep.phone, role: rep.role },
    });
  } catch (err) {
    console.error('[SalesAuth] Login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── GET /api/sales/auth/me ──
router.get('/me', requireSalesAuth(), async (req, res) => {
  res.json({ rep: req.salesRep });
});

export default router;
