const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcrypt');
const db      = require('../db');

function isAdmin(req, res, next) {
  if (req.session.admin) return next();
  res.redirect('/admin/login');
}

// ── Login ──────────────────────────────────────────────────
router.get('/login', (req, res) => res.render('admin/login', { error: null }));

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.render('admin/login', { error: 'সব field পূরণ করো!' });
  try {
    const [rows] = await db.query('SELECT * FROM admins WHERE username=?', [username]);
    if (!rows.length) return res.render('admin/login', { error: 'Admin পাওয়া যায়নি!' });
    if (!await bcrypt.compare(password, rows[0].password))
      return res.render('admin/login', { error: 'Password ভুল!' });
    req.session.admin = { id: rows[0].id, username: rows[0].username };
    res.redirect('/admin/dashboard');
  } catch (e) { res.render('admin/login', { error: 'Server error!' }); }
});

// ── Dashboard ──────────────────────────────────────────────
router.get('/dashboard', isAdmin, async (req, res) => {
  try {
    const [questions]    = await db.query('SELECT COUNT(*) as c FROM questions');
    const [students]     = await db.query('SELECT COUNT(*) as c FROM students');
    const [pending]      = await db.query('SELECT COUNT(*) as c FROM students WHERE is_approved=0 AND is_blocked=0');
    const [reports]      = await db.query('SELECT COUNT(*) as c FROM question_reports WHERE status="pending"');
    const [payments]     = await db.query('SELECT COUNT(*) as c FROM payments WHERE status="pending"');
    const [examsCount]   = await db.query('SELECT COUNT(*) as c FROM exams');
    const [coursesCount] = await db.query('SELECT COUNT(*) as c FROM courses');
    const [settings]     = await db.query("SELECT setting_value FROM exam_settings WHERE setting_key='exam_duration_minutes'");

    res.render('admin/dashboard', {
      admin: req.session.admin,
      stats: {
        questions:   questions[0].c,
        students:    students[0].c,
        pending:     pending[0].c,
        reports:     reports[0].c,
        payments:    payments[0].c,
        exams:       examsCount[0].c,
        courses:     coursesCount[0].c
      },
      currentDuration: settings.length ? settings[0].setting_value : '10',
      success: req.query.success || null
    });
  } catch (e) { console.error(e); res.send('Error'); }
});

// ── Approvals ──────────────────────────────────────────────
router.get('/approvals', isAdmin, async (req, res) => {
  try {
    const [pending] = await db.query(
      `SELECT id, username, full_name, created_at
       FROM students WHERE is_approved=0 AND is_blocked=0
       ORDER BY created_at DESC`
    );
    const [approved] = await db.query(
      `SELECT id, username, full_name, is_blocked, created_at, approved_at
       FROM students WHERE is_approved=1
       ORDER BY approved_at DESC`
    );
    res.render('admin/approvals', {
      pending, approved,
      success: req.query.success || null
    });
  } catch (e) { console.error(e); res.redirect('/admin/dashboard'); }
});

router.post('/approve/:id', isAdmin, async (req, res) => {
  await db.query(
    'UPDATE students SET is_approved=1, approved_at=NOW(), approved_by=? WHERE id=?',
    [req.session.admin.id, req.params.id]
  );
  res.redirect('/admin/approvals?success=approved');
});

router.post('/reject/:id', isAdmin, async (req, res) => {
  await db.query('DELETE FROM students WHERE id=? AND is_approved=0', [req.params.id]);
  res.redirect('/admin/approvals?success=rejected');
});

router.post('/toggle-block/:id', isAdmin, async (req, res) => {
  const [rows] = await db.query('SELECT is_blocked FROM students WHERE id=?', [req.params.id]);
  if (!rows.length) return res.redirect('/admin/approvals');
  const nb = rows[0].is_blocked ? 0 : 1;
  await db.query('UPDATE students SET is_blocked=? WHERE id=?', [nb, req.params.id]);
  res.redirect('/admin/approvals?success=' + (nb ? 'blocked' : 'unblocked'));
});

// ── Exams Management ───────────────────────────────────────
router.get('/exams', isAdmin, async (req, res) => {
  try {
    const [exams]    = await db.query(`
      SELECT e.*, COUNT(q.id) as q_count
      FROM exams e LEFT JOIN questions q ON q.exam_id=e.id
      GROUP BY e.id ORDER BY e.created_at DESC`);
    const [students] = await db.query('SELECT id, full_name, username FROM students WHERE is_approved=1 ORDER BY full_name');
    res.render('admin/exams', { exams, students, success: req.query.success || null });
  } catch (e) { console.error(e); res.redirect('/admin/dashboard'); }
});

router.post('/exams/add', isAdmin, async (req, res) => {
  const { title, description, exam_type, duration_minutes, total_questions } = req.body;
  if (!title) return res.redirect('/admin/exams?success=error');
  try {
    const [result] = await db.query(
      'INSERT INTO exams (title, description, exam_type, duration_minutes, total_questions) VALUES (?,?,?,?,?)',
      [title.trim(), description||'', exam_type||'public', parseInt(duration_minutes)||10, parseInt(total_questions)||10]
    );
    // Private exam: allowed students
    if (exam_type === 'private' && req.body.allowed_students) {
      const ids = Array.isArray(req.body.allowed_students)
        ? req.body.allowed_students : [req.body.allowed_students];
      for (const sid of ids) {
        await db.query('INSERT IGNORE INTO exam_allowed_students VALUES (?,?)', [result.insertId, sid]);
      }
    }
    res.redirect('/admin/exams?success=exam_added');
  } catch (e) { console.error(e); res.redirect('/admin/exams?success=error'); }
});

router.post('/exams/toggle/:id', isAdmin, async (req, res) => {
  const [rows] = await db.query('SELECT is_active FROM exams WHERE id=?', [req.params.id]);
  if (!rows.length) return res.redirect('/admin/exams');
  await db.query('UPDATE exams SET is_active=? WHERE id=?', [rows[0].is_active ? 0 : 1, req.params.id]);
  res.redirect('/admin/exams?success=toggled');
});

router.post('/exams/delete/:id', isAdmin, async (req, res) => {
  await db.query('DELETE FROM exams WHERE id=?', [req.params.id]);
  res.redirect('/admin/exams?success=exam_deleted');
});

// ── Questions ──────────────────────────────────────────────
router.get('/questions', isAdmin, async (req, res) => {
  try {
    const [questions] = await db.query(`
      SELECT q.*, e.title as exam_title
      FROM questions q LEFT JOIN exams e ON e.id=q.exam_id
      ORDER BY q.created_at DESC`);
    const [exams] = await db.query('SELECT id, title FROM exams ORDER BY title');
    res.render('admin/questions', { questions, exams, success: req.query.success || null });
  } catch (e) { res.redirect('/admin/dashboard'); }
});

router.post('/questions/add', isAdmin, async (req, res) => {
  const { question, correct_answer, explanation, exam_id, num_options } = req.body;
  const n = parseInt(num_options) || 4;
  const opts = ['a','b','c','d','e','f'].slice(0, n);

  if (!question || !correct_answer) return res.redirect('/admin/questions?success=error_empty');

  const cols = opts.map(o => `option_${o}`).join(', ');
  const vals = opts.map(o => (req.body[`option_${o}`] || '').trim());

  try {
    await db.query(
      `INSERT INTO questions (question, ${cols}, correct_answer, explanation, exam_id, num_options)
       VALUES (?, ${opts.map(()=>'?').join(',')}, ?, ?, ?, ?)`,
      [question.trim(), ...vals, correct_answer.toUpperCase(), explanation||null, exam_id||null, n]
    );
    res.redirect('/admin/questions?success=added');
  } catch (e) { console.error(e); res.redirect('/admin/questions?success=error'); }
});

router.get('/questions/edit/:id', isAdmin, async (req, res) => {
  const [rows]  = await db.query('SELECT * FROM questions WHERE id=?', [req.params.id]);
  const [exams] = await db.query('SELECT id, title FROM exams');
  if (!rows.length) return res.redirect('/admin/questions');
  res.render('admin/edit', { question: rows[0], exams });
});

router.post('/questions/edit/:id', isAdmin, async (req, res) => {
  const { question, correct_answer, explanation, exam_id, num_options } = req.body;
  const n = parseInt(num_options) || 4;
  const opts = ['a','b','c','d','e','f'].slice(0, n);
  const sets = opts.map(o => `option_${o}=?`).join(', ');
  const vals = opts.map(o => (req.body[`option_${o}`]||'').trim());
  await db.query(
    `UPDATE questions SET question=?, ${sets}, correct_answer=?, explanation=?, exam_id=?, num_options=? WHERE id=?`,
    [question.trim(), ...vals, correct_answer.toUpperCase(), explanation||null, exam_id||null, n, req.params.id]
  );
  res.redirect('/admin/questions?success=updated');
});

router.post('/questions/delete/:id', isAdmin, async (req, res) => {
  await db.query('DELETE FROM questions WHERE id=?', [req.params.id]);
  res.redirect('/admin/questions?success=deleted');
});

// ── Reports ────────────────────────────────────────────────
router.get('/reports', isAdmin, async (req, res) => {
  try {
    const [reports] = await db.query(`
      SELECT r.*, q.question, s.full_name, s.username
      FROM question_reports r
      JOIN questions q ON q.id=r.question_id
      JOIN students s ON s.id=r.student_id
      ORDER BY r.reported_at DESC`);
    res.render('admin/reports', { reports, success: req.query.success || null });
  } catch (e) { res.redirect('/admin/dashboard'); }
});

router.post('/reports/resolve/:id', isAdmin, async (req, res) => {
  await db.query("UPDATE question_reports SET status='resolved' WHERE id=?", [req.params.id]);
  res.redirect('/admin/reports?success=resolved');
});

router.post('/reports/dismiss/:id', isAdmin, async (req, res) => {
  await db.query("UPDATE question_reports SET status='reviewed' WHERE id=?", [req.params.id]);
  res.redirect('/admin/reports?success=dismissed');
});

// ── Courses ────────────────────────────────────────────────
router.get('/courses', isAdmin, async (req, res) => {
  try {
    const [courses] = await db.query(`
      SELECT c.*, COUNT(DISTINCT e.id) as enrolled_count
      FROM courses c
      LEFT JOIN course_enrollments e ON e.course_id=c.id
      GROUP BY c.id ORDER BY c.created_at DESC`);
    res.render('admin/courses', { courses, success: req.query.success || null });
  } catch (e) { res.redirect('/admin/dashboard'); }
});

router.post('/courses/add', isAdmin, async (req, res) => {
  const { title, description, price, is_free, thumbnail_url } = req.body;
  if (!title) return res.redirect('/admin/courses?success=error');
  await db.query(
    'INSERT INTO courses (title, description, price, is_free, thumbnail_url) VALUES (?,?,?,?,?)',
    [title.trim(), description||'', parseFloat(price)||0, is_free?1:0, thumbnail_url||null]
  );
  res.redirect('/admin/courses?success=course_added');
});

router.get('/courses/edit/:id', isAdmin, async (req, res) => {
  const [courses]  = await db.query('SELECT * FROM courses WHERE id=?', [req.params.id]);
  const [contents] = await db.query('SELECT * FROM course_contents WHERE course_id=? ORDER BY sort_order', [req.params.id]);
  const [exams]    = await db.query('SELECT id, title FROM exams WHERE is_active=1');
  if (!courses.length) return res.redirect('/admin/courses');
  res.render('admin/course_edit', { course: courses[0], contents, exams, success: req.query.success||null });
});

router.post('/courses/toggle/:id', isAdmin, async (req, res) => {
  const [rows] = await db.query('SELECT is_published FROM courses WHERE id=?', [req.params.id]);
  await db.query('UPDATE courses SET is_published=? WHERE id=?', [rows[0].is_published?0:1, req.params.id]);
  res.redirect('/admin/courses?success=toggled');
});

router.post('/courses/:id/content/add', isAdmin, async (req, res) => {
  const { content_type, title, content_url, content_text, exam_id, sort_order, is_free_preview } = req.body;
  await db.query(
    'INSERT INTO course_contents (course_id,content_type,title,content_url,content_text,exam_id,sort_order,is_free_preview) VALUES (?,?,?,?,?,?,?,?)',
    [req.params.id, content_type, title, content_url||null, content_text||null, exam_id||null, parseInt(sort_order)||0, is_free_preview?1:0]
  );
  res.redirect(`/admin/courses/edit/${req.params.id}?success=content_added`);
});

router.post('/courses/content/delete/:cid', isAdmin, async (req, res) => {
  const [rows] = await db.query('SELECT course_id FROM course_contents WHERE id=?', [req.params.cid]);
  await db.query('DELETE FROM course_contents WHERE id=?', [req.params.cid]);
  res.redirect(`/admin/courses/edit/${rows[0]?.course_id}?success=content_deleted`);
});

// ── Payments (manual approval) ─────────────────────────────
router.get('/payments', isAdmin, async (req, res) => {
  try {
    const [payments] = await db.query(`
      SELECT p.*, s.full_name, s.username, c.title as course_title
      FROM payments p
      JOIN students s ON s.id=p.student_id
      JOIN courses c ON c.id=p.course_id
      ORDER BY p.submitted_at DESC`);
    res.render('admin/payments', { payments, success: req.query.success||null });
  } catch (e) { res.redirect('/admin/dashboard'); }
});

router.post('/payments/approve/:id', isAdmin, async (req, res) => {
  const [rows] = await db.query('SELECT * FROM payments WHERE id=?', [req.params.id]);
  if (!rows.length) return res.redirect('/admin/payments');
  await db.query("UPDATE payments SET status='approved', reviewed_at=NOW() WHERE id=?", [req.params.id]);
  await db.query(
    "INSERT IGNORE INTO course_enrollments (course_id,student_id,payment_status,payment_method,payment_ref) VALUES (?,?,'paid',?,?)",
    [rows[0].course_id, rows[0].student_id, rows[0].method, rows[0].transaction_ref]
  );
  res.redirect('/admin/payments?success=payment_approved');
});

router.post('/payments/reject/:id', isAdmin, async (req, res) => {
  await db.query("UPDATE payments SET status='rejected', reviewed_at=NOW() WHERE id=?", [req.params.id]);
  res.redirect('/admin/payments?success=payment_rejected');
});

// ── Student marks (আগের মতো) ───────────────────────────────
router.get('/student-marks/:id', isAdmin, async (req, res) => {
  const [studentRows] = await db.query('SELECT * FROM students WHERE id=?', [req.params.id]);
  if (!studentRows.length) return res.redirect('/admin/approvals');
  const [results] = await db.query(
    'SELECT * FROM exam_results WHERE student_id=? ORDER BY submitted_at DESC', [req.params.id]
  );
  const [rankRow] = await db.query(
    `SELECT COUNT(*) as c FROM (SELECT student_id, MAX(percentage) as best FROM exam_results GROUP BY student_id) t
     WHERE t.best > (SELECT COALESCE(MAX(percentage),0) FROM exam_results WHERE student_id=?)`,
    [req.params.id]
  );
  res.render('admin/student_marks', { student: studentRows[0], results, rank: rankRow[0].c + 1 });
});

// ── Timer ──────────────────────────────────────────────────
router.post('/set-timer', isAdmin, async (req, res) => {
  const mins = parseInt(req.body.duration);
  if (!mins || mins < 1 || mins > 180) return res.redirect('/admin/dashboard?success=error_timer');
  await db.query(
    "INSERT INTO exam_settings (setting_key,setting_value) VALUES ('exam_duration_minutes',?) ON DUPLICATE KEY UPDATE setting_value=?",
    [String(mins), String(mins)]
  );
  res.redirect('/admin/dashboard?success=timer_set');
});

router.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/admin/login'); });

module.exports = router;