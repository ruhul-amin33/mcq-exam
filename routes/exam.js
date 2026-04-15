const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcrypt');
const db      = require('../db');

function isStudent(req, res, next) {
  if (req.session.student) return next();
  res.redirect('/exam/login');
}

// ── Login ──────────────────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.session.student) return res.redirect('/exam/start');
  res.render('exam/login', { error: null, query: req.query });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.render('exam/login', { error: 'Username ও Password দাও!', query: {} });
  try {
    const [rows] = await db.query('SELECT * FROM students WHERE username=?', [username.trim()]);
    if (!rows.length)
      return res.render('exam/login', { error: 'Account পাওয়া যায়নি! আগে Register করো।', query: {} });

    const s = rows[0];
    if (!s.is_approved)
      return res.render('exam/login', { error: '⏳ তোমার account এখনো approved হয়নি। Admin এর অপেক্ষায় থাকো।', query: {} });
    if (s.is_blocked)
      return res.render('exam/login', { error: '🚫 Account block করা হয়েছে। Admin এর সাথে যোগাযোগ করো।', query: {} });
    if (!await bcrypt.compare(password, s.password))
      return res.render('exam/login', { error: 'Password ভুল!', query: {} });

    req.session.student = { id: s.id, username: s.username, full_name: s.full_name };
    res.redirect('/exam/start');
  } catch (e) { res.render('exam/login', { error: 'Server error!', query: {} }); }
});

// ── Register ───────────────────────────────────────────────
router.get('/register', (req, res) => {
  if (req.session.student) return res.redirect('/exam/start');
  res.render('exam/register', { error: null });
});

router.post('/register', async (req, res) => {
  const { username, full_name, password, confirm_password } = req.body;
  if (!username || !full_name || !password || !confirm_password)
    return res.render('exam/register', { error: 'সব field পূরণ করো!' });
  if (username.trim().length < 3)
    return res.render('exam/register', { error: 'Username কমপক্ষে ৩ অক্ষর!' });
  if (password.length < 6)
    return res.render('exam/register', { error: 'Password কমপক্ষে ৬ অক্ষর!' });
  if (password !== confirm_password)
    return res.render('exam/register', { error: 'Password মিলছে না!' });
  if (!/^[a-zA-Z0-9_]+$/.test(username.trim()))
    return res.render('exam/register', { error: 'Username এ শুধু অক্ষর, সংখ্যা ও _ চলবে!' });
  try {
    const [ex] = await db.query('SELECT id FROM students WHERE username=?', [username.trim()]);
    if (ex.length) return res.render('exam/register', { error: 'Username ইতিমধ্যে নেওয়া!' });
    const hash = await bcrypt.hash(password, 10);
    await db.query('INSERT INTO students (username, full_name, password) VALUES (?,?,?)',
      [username.trim(), full_name.trim(), hash]);
    res.redirect('/exam/login?registered=1');
  } catch (e) { res.render('exam/register', { error: 'Server error!' }); }
});

// ── Start / Home ───────────────────────────────────────────
router.get('/start', isStudent, async (req, res) => {
  try {
    const [chk] = await db.query('SELECT is_blocked, is_approved FROM students WHERE id=?', [req.session.student.id]);
    if (!chk.length || chk[0].is_blocked || !chk[0].is_approved) {
      req.session.destroy(); return res.redirect('/exam/login?blocked=1');
    }

    // Available exams (public + private allowed)
    const [exams] = await db.query(`
      SELECT e.* FROM exams e
      WHERE e.is_active=1 AND (
        e.exam_type='public' OR
        EXISTS(SELECT 1 FROM exam_allowed_students x WHERE x.exam_id=e.id AND x.student_id=?)
      ) ORDER BY e.created_at DESC`,
      [req.session.student.id]
    );

    const [myResults] = await db.query(
      'SELECT score,total,percentage,submitted_at FROM exam_results WHERE student_id=? ORDER BY submitted_at DESC LIMIT 10',
      [req.session.student.id]
    );
    const [rankRow] = await db.query(
      `SELECT COUNT(*) as c FROM (SELECT student_id,MAX(percentage) as best FROM exam_results GROUP BY student_id) t
       WHERE t.best>(SELECT COALESCE(MAX(percentage),0) FROM exam_results WHERE student_id=?)`,
      [req.session.student.id]
    );

    res.render('exam/start', {
      student: req.session.student,
      exams, myResults,
      myRank: rankRow[0].c + 1,
      error: null
    });
  } catch (e) { console.error(e); res.redirect('/exam/login'); }
});

// POST: Begin exam
router.post('/start', isStudent, async (req, res) => {
  const { exam_id } = req.body;
  if (!exam_id) return res.redirect('/exam/start');
  try {
    // Verify access
    const [examRows] = await db.query(`
      SELECT e.* FROM exams e
      WHERE e.id=? AND e.is_active=1 AND (
        e.exam_type='public' OR
        EXISTS(SELECT 1 FROM exam_allowed_students x WHERE x.exam_id=e.id AND x.student_id=?)
      )`, [exam_id, req.session.student.id]
    );
    if (!examRows.length) return res.redirect('/exam/start');

    const exam = examRows[0];
    const [questions] = await db.query(
      'SELECT * FROM questions WHERE exam_id=? ORDER BY RAND() LIMIT ?',
      [exam_id, exam.total_questions]
    );
    if (!questions.length)
      return res.redirect('/exam/start');

    req.session.questions  = questions;
    req.session.exam       = exam;
    req.session.start_time = Date.now();

    res.render('exam/questions', {
      questions,
      exam,
      student:       req.session.student,
      exam_duration: exam.duration_minutes * 60
    });
  } catch (e) { console.error(e); res.redirect('/exam/start'); }
});

// POST: Submit exam
router.post('/submit', isStudent, async (req, res) => {
  const questions = req.session.questions;
  const exam      = req.session.exam;
  const student   = req.session.student;
  if (!questions || !exam) return res.redirect('/exam/start');

  const answers = req.body;
  let score = 0;
  const results = [];

  questions.forEach(q => {
    const sa = (answers[`q_${q.id}`] || '').toUpperCase();
    const ok = sa === q.correct_answer;
    if (ok) score++;
    results.push({
      id: q.id,
      question: q.question,
      options: buildOptions(q),
      correct_answer: q.correct_answer,
      student_answer: sa || 'দেওয়া হয়নি',
      is_correct: ok,
      explanation: q.explanation || null
    });
  });

  const total = questions.length;
  const pct   = parseFloat(((score / total) * 100).toFixed(2));

  try {
    await db.query(
      'INSERT INTO exam_results (student_id, score, total, percentage) VALUES (?,?,?,?)',
      [student.id, score, total, pct]
    );
  } catch (e) { console.error(e); }

  req.session.questions  = null;
  req.session.exam       = null;
  req.session.start_time = null;

  res.render('exam/result', { student, score, total, percentage: pct, results, exam });
});

// POST: Report a question
router.post('/report-question', isStudent, async (req, res) => {
  const { question_id, reason } = req.body;
  if (!question_id || !reason || reason.trim().length < 5)
    return res.json({ success: false, msg: 'কারণ লেখো!' });
  try {
    await db.query(
      'INSERT INTO question_reports (question_id, student_id, reason) VALUES (?,?,?)',
      [question_id, req.session.student.id, reason.trim()]
    );
    res.json({ success: true, msg: 'Report জমা হয়েছে। ধন্যবাদ!' });
  } catch (e) { res.json({ success: false, msg: 'Error!' }); }
});

router.get('/logout', (req, res) => {
  req.session.student    = null;
  req.session.questions  = null;
  req.session.exam       = null;
  req.session.start_time = null;
  res.redirect('/exam/login');
});

// Helper: build options array from question row
function buildOptions(q) {
  const opts = [];
  ['a','b','c','d','e','f'].forEach(k => {
    if (q[`option_${k}`]) opts.push({ key: k.toUpperCase(), text: q[`option_${k}`] });
  });
  return opts;
}

module.exports = router;