const multer = require('multer');
const cloudinary = require('cloudinary').v2;

// ============================================================
// CLOUDINARY
// ============================================================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ============================================================
// MULTER
// ------------------------------------------------------------
// memoryStorage, not diskStorage. Hosts like Railway and Render
// wipe the filesystem on every deploy and restart, so a file
// saved to disk is gone within hours. The buffer goes straight
// to Cloudinary and is never written locally.
// ============================================================
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,   // 5 MB
    files: 1
  },
  fileFilter: (req, file, cb) => {
    if (ALLOWED.includes(file.mimetype)) return cb(null, true);
    // Tagged with a code so the error handler in server.js can tell
    // "user picked a PDF" apart from a real server fault
    const err = new Error('Only JPEG, PNG, WebP and AVIF images are allowed.');
    err.code = 'INVALID_FILE_TYPE';
    cb(err);
  }
});

// ============================================================
// UPLOAD
// ------------------------------------------------------------
// upload_stream is callback-based, so it's wrapped in a Promise
// to make it awaitable like everything else in the app.
//
// Defaults suit product photos. Pass options to override —
// avatars send their own folder and a square face crop.
// ============================================================
function uploadToCloudinary(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'denise/products',
        // 'limit' shrinks anything larger but never enlarges a
        // small image, so nothing gets upscaled and blurry
        transformation: [{ width: 1200, height: 1600, crop: 'limit' }],
        quality: 'auto',        // Cloudinary picks the compression
        fetch_format: 'auto',   // serves WebP/AVIF to browsers that support it
        ...options
      },
      (err, result) => (err ? reject(err) : resolve(result))
    );

    stream.end(buffer);
  });
}

// ============================================================
// DELETE
// ------------------------------------------------------------
// Takes the public_id stored in the database when the image was
// uploaded. Without this, replaced images pile up in Cloudinary
// forever and eat the free tier.
// ============================================================
function deleteFromCloudinary(publicId) {
  return cloudinary.uploader.destroy(publicId);
}

module.exports = { upload, uploadToCloudinary, deleteFromCloudinary, cloudinary };