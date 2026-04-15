const express = require('express');
const router  = express.Router();
const db      = require('../db');

function isStudent(req, res, next) {
  if (req.session.student) return next();
  res.redirect('/exam/login');
}

// Course list
router.get('/', isStudent, async (req, res) => {
  try {
    const [courses] = await db.query(`
      SELECT c.*,
        (SELECT COUNT(*) FROM course_enrollments e WHERE e.course_id=c.id AND e.student_id=?) as enrolled
      FROM courses c WHERE c.is_published=1 ORDER BY c.created_at DESC`,
      [req.session.student.id]
    );
    res.render('exam/course/list', { student: req.session.student, courses, success: req.query.success||null });
  } catch (e) { console.error(e); res.redirect('/exam/start'); }
});

// Course detail
router.get('/:id', isStudent, async (req, res) => {
  try {
    const [crows] = await db.query('SELECT * FROM courses WHERE id=? AND is_published=1', [req.params.id]);
    if (!crows.length) return res.redirect('/course');

    const [enrolled] = await db.query(
      'SELECT * FROM course_enrollments WHERE course_id=? AND student_id=?',
      [req.params.id, req.session.student.id]
    );
    const isEnrolled = enrolled.length > 0;

    const [contents] = await db.query(
      `SELECT * FROM course_contents WHERE course_id=? ${!isEnrolled ? 'AND is_free_preview=1' : ''} ORDER BY sort_order`,
      [req.params.id]
    );

    // Pending payment?
    const [pendingPay] = await db.query(
      "SELECT * FROM payments WHERE course_id=? AND student_id=? AND status='pending'",
      [req.params.id, req.session.student.id]
    );

    res.render('exam/course/detail', {
      student: req.session.student,
      course: crows[0],
      contents, isEnrolled,
      hasPendingPayment: pendingPay.length > 0,
      success: req.query.success||null
    });
  } catch (e) { console.error(e); res.redirect('/course'); }
});

// Enroll free course
router.post('/:id/enroll-free', isStudent, async (req, res) => {
  const [crows] = await db.query('SELECT * FROM courses WHERE id=? AND is_free=1', [req.params.id]);
  if (!crows.length) return res.redirect(`/course/${req.params.id}`);
  await db.query(
    "INSERT IGNORE INTO course_enrollments (course_id,student_id,payment_status) VALUES (?,'free')",
    [req.params.id, req.session.student.id]
  );
  res.redirect(`/course/${req.params.id}?success=enrolled`);
});

// Payment submission
router.get('/:id/pay', isStudent, async (req, res) => {
  const [crows] = await db.query('SELECT * FROM courses WHERE id=? AND is_published=1', [req.params.id]);
  if (!crows.length) return res.redirect('/course');
  res.render('exam/course/payment', { student: req.session.student, course: crows[0], error: null, success: null });
});

router.post('/:id/pay', isStudent, async (req, res) => {
  const { method, transaction_ref } = req.body;
  const [crows] = await db.query('SELECT * FROM courses WHERE id=?', [req.params.id]);
  if (!crows.length) return res.redirect('/course');

  if (!method || !transaction_ref || transaction_ref.trim().length < 4)
    return res.render('exam/course/payment', {
      student: req.session.student, course: crows[0],
      error: 'Transaction Reference দাও!', success: null
    });

  try {
    await db.query(
      'INSERT INTO payments (student_id,course_id,amount,method,transaction_ref) VALUES (?,?,?,?,?)',
      [req.session.student.id, req.params.id, crows[0].price, method, transaction_ref.trim()]
    );
    res.render('exam/course/payment', {
      student: req.session.student, course: crows[0],
      error: null, success: 'Payment জমা হয়েছে! Admin approve করলে course unlock হবে।'
    });
  } catch (e) {
    res.render('exam/course/payment', {
      student: req.session.student, course: crows[0],
      error: 'Error! আবার চেষ্টা করো।', success: null
    });
  }
});

module.exports = router;