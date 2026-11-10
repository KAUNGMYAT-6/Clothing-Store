// Route guards. Both set returnTo so the user lands back where they
// were trying to go after logging in.

function requireLogin(req, res, next) {
  if (!req.session.user) {
    req.session.returnTo = req.originalUrl;
    req.flash('info', 'Please log in to continue.');
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) {
    req.session.returnTo = req.originalUrl;
    req.flash('info', 'Please log in to continue.');
    return res.redirect('/login');
  }

  // 403, not 401: we know exactly who they are, they're just not allowed
  if (req.session.user.role !== 'admin') {
    return res.status(403).render('errors/403', { title: 'Forbidden' });
  }

  next();
}

module.exports = { requireLogin, requireAdmin };