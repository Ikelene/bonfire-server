'use strict';
// Image compression for uploads (Server settings > Uploads > Image compression). Uses sharp when it is installed (it is an optional
// dependency: a server without it still takes uploads, just without resizing). Animated pictures and GIFs are kept as they are.
let sharp; // undefined = not looked for yet, null = not installed
function lib() {
  if (sharp === undefined) { try { sharp = require('sharp'); } catch { sharp = null; } }
  return sharp;
}
const available = () => !!lib();

// buf + its sniffed ext ('png' | 'jpg' | 'webp' | ...) + the uploads settings -> { buffer, width, height } (or the same buffer back)
// Throws `image_too_large` when the picture has more pixels than max_pixels (checked from the header, before decoding).
async function compress(buf, ext, opts, dims = {}) {
  if (!['png', 'jpg', 'webp'].includes(ext)) return { buffer: buf };
  const { max_width: mw, max_height: mh, max_pixels: mp, jpeg_quality: q } = opts;
  if (dims.width && dims.height && dims.width * dims.height > mp) throw Object.assign(new Error('image_too_large'), { code: 'image_too_large', status: 413, extra: { max_pixels: mp } });
  const s = lib();
  if (!s) return { buffer: buf };
  try {
    const img = s(buf, { limitInputPixels: mp, animated: false });
    const meta = await img.metadata();
    if ((meta.pages || 1) > 1) return { buffer: buf }; // animated webp / apng: keep it moving
    let p = img.rotate().resize({ width: mw, height: mh, fit: 'inside', withoutEnlargement: true });
    p = ext === 'jpg' ? p.jpeg({ quality: q, mozjpeg: true }) : ext === 'webp' ? p.webp({ quality: q }) : p.png({ compressionLevel: 9, palette: false });
    const { data, info } = await p.toBuffer({ resolveWithObject: true });
    return data.length < buf.length || (meta.width > mw || meta.height > mh) ? { buffer: data, width: info.width, height: info.height } : { buffer: buf };
  } catch (e) {
    if (/pixel limit/i.test(e.message)) throw Object.assign(new Error('image_too_large'), { code: 'image_too_large', status: 413, extra: { max_pixels: mp } });
    return { buffer: buf }; // a picture sharp can't read is stored as it came
  }
}

module.exports = { available, compress };
