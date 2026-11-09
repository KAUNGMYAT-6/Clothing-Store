// Flash messages: set on one request, shown on the next (survives a redirect)
function flash(req, res, next) {
  // Hand whatever was queued last request to the templates, then clear it
  res.locals.flash = req.session.flash || [];
  req.session.flash = [];

  // Queue a message for the next page the user sees
  req.flash = (type, message) => {
    if (!req.session.flash) req.session.flash = [];
    req.session.flash.push({ type, message });
  };

  next();
}

module.exports = { flash };