const express = require('express');
const session = require('express-session');
const path    = require('path');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: 'mcq_secret_key_2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 3600000 * 6 }
}));

app.use('/admin',  require('./routes/admin'));
app.use('/exam',   require('./routes/exam'));
app.use('/course', require('./routes/course'));

app.get('/', (req, res) => res.redirect('/exam/login'));

app.use((req, res) => {
  res.status(404).send(`
    <div style="text-align:center;padding:60px;font-family:sans-serif">
      <h2>404 — Page Not Found</h2>
      <a href="/">← হোমে ফিরে যাও</a>
    </div>
  `);
});

// app.listen(3000, () => {
  // console.log('✅ Server: http://localhost:3000');
// });
// 
// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => console.log('Server running on port ' + PORT));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});