const multer = require('multer');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Memory storage, not disk: hosting platforms wipe the filesystem on every
// restart, so a file written to disk would vanish. The buffer goes straight
// to Cloudinary and is never stored locally.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },   // 5 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Only JPEG, PNG, WebP and AVIF images are allowed.'));
  }
});

// Streams a buffer to Cloudinary and resolves with the result
function uploadToCloudinary(buffer, folder = 'denise/products') {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: 'image',
        transformation: [
          { width: 1200, height: 1600, crop: 'limit' },  // cap the size
          { quality: 'auto', fetch_format: 'auto' }      // compress, modern formats
        ]
      },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

function deleteFromCloudinary(publicId) {
  return cloudinary.uploader.destroy(publicId);
}

module.exports = { upload, uploadToCloudinary, deleteFromCloudinary };