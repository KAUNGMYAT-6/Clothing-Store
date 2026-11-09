const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const pool = require('../db/pool');

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const googleId = profile.id;
    const email = profile.emails && profile.emails[0] && profile.emails[0].value;
    const name = profile.displayName || 'Customer';

    if (!email) return done(null, false);

    // 1. Already linked to this Google account?
    const [byGoogle] = await pool.query(
      'SELECT * FROM users WHERE google_id = ?', [googleId]
    );
    if (byGoogle.length) return done(null, byGoogle[0]);

    // 2. An account with this email already exists: link it
    const [byEmail] = await pool.query(
      'SELECT * FROM users WHERE email = ?', [email]
    );
    if (byEmail.length) {
      await pool.query(
        'UPDATE users SET google_id = ? WHERE id = ?',
        [googleId, byEmail[0].id]
      );
      return done(null, { ...byEmail[0], google_id: googleId });
    }

    // 3. Brand new user, no password
    const [result] = await pool.query(
      'INSERT INTO users (name, email, google_id) VALUES (?, ?, ?)',
      [name, email, googleId]
    );

    return done(null, { id: result.insertId, name, email, role: 'user' });
  } catch (err) {
    return done(err);
  }
}));

module.exports = passport;