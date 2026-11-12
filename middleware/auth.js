// Route guards. Both set returnTo so the user lands back where they
// were trying to go after logging in.

// Only GET pages are worth returning to. A POST address (posting a
// review, say) has no page behind it, so going "back" there after
// logging in would land on a 404.
function rememberWhereTheyWere(req) {
  if (req.method === 'GET') req.session.returnTo = req.originalUrl;
}

function requireLogin(req, res, next) {
  if (!req.session.user) {
    rememberWhereTheyWere(req);
    req.flash('info', 'Please log in to continue.');
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) {
    rememberWhereTheyWere(req);
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