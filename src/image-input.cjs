function jpegSize(buffer) {
  let offset = 2, size;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset++] !== 255) break;
    while (buffer[offset] === 255) offset++;
    const marker = buffer[offset++];
    if (marker === 218 && size) return size;
    if (marker === 217 || offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
      if (size || length < 8) break;
      size = [buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3)];
    }
    offset += length;
  }
  throw new Error('Invalid JPEG image header.');
}

function webpSize(buffer) {
  const type = buffer.toString('ascii', 12, 16);
  if (buffer.length >= 30 && type === 'VP8X')
    return [buffer.readUIntLE(24, 3) + 1, buffer.readUIntLE(27, 3) + 1];
  if (buffer.length >= 30 && type === 'VP8 ' && buffer.subarray(23, 26).equals(Buffer.from([157, 1, 42])))
    return [buffer.readUInt16LE(26) & 16383, buffer.readUInt16LE(28) & 16383];
  if (buffer.length >= 25 && type === 'VP8L' && buffer[20] === 47) {
    const bits = buffer.readUInt32LE(21);
    return [(bits & 16383) + 1, ((bits >>> 14) & 16383) + 1];
  }
  throw new Error('Invalid WebP image header.');
}

async function normalizeImage(bytes, mime) {
  const buffer = Buffer.from(bytes);
  const png = buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = buffer.length >= 4 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  const webp = buffer.length >= 16 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  const formats = { png, jpeg, webp };
  if (!Object.hasOwn(formats, mime) || !formats[mime]) throw new Error('The image contents do not match PNG, JPEG or WebP.');
  const check = (width, height) => {
    if (!width || !height || width * height > 25000000) throw new Error('Invalid image or image exceeds 25 megapixels.');
  };
  if (png) check(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
  else check(...(jpeg ? jpegSize(buffer) : webpSize(buffer)));
  const { loadImage, createCanvas } = require('@napi-rs/canvas');
  let image;
  try { image = await loadImage(buffer); }
  catch { throw new Error('The image could not be decoded. Use a valid PNG, JPEG or WebP.'); }
  check(image.width, image.height);
  // Codex replays every history image on each turn; providers downscale past ~2048 px anyway.
  const scale = Math.min(1, 2048 / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale)), height = Math.max(1, Math.round(image.height * scale));
  const canvas = createCanvas(width, height), context = canvas.getContext('2d');
  context.drawImage(image, 0, 0, width, height);
  let url = canvas.toDataURL('image/png');
  // Photos shrink several-fold as JPEG; any transparency keeps PNG so alpha is never flattened.
  if (jpeg || opaque(context, width, height)) {
    const photo = canvas.toDataURL('image/jpeg', 0.85);
    if (photo.length < url.length) url = photo;
  }
  if (url.length > 12 * 1024 * 1024) throw new Error('The decoded image is too large. Attach a smaller image.');
  return { format: 'image', url };
}

function opaque(context, width, height) {
  const { data } = context.getImageData(0, 0, width, height);
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) return false;
  }
  return true;
}

// Normalized images are PNG or JPEG data URLs; providers need the media type and the bare base64 payload.
function imageData(url) {
  const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(url);
  if (!match) throw new Error('Invalid image: attach a PNG or JPEG image.');
  return { mime: match[1], data: match[2] };
}

// Jev takes PNG or JPEG with each side 280-1568 px and rejects anything else (docs.typesafe.ai/images.md, 2026-10-30).
const JEV_MIN = 280, JEV_MAX = 1568;
async function jevImage(url) {
  const { mime, data } = imageData(url);
  const format = mime === 'image/png' ? 'png' : 'jpeg';
  const buffer = Buffer.from(data, 'base64');
  const [width, height] = format === 'png' ? [buffer.readUInt32BE(16), buffer.readUInt32BE(20)] : jpegSize(buffer);
  if (Math.min(width, height) >= JEV_MIN && Math.max(width, height) <= JEV_MAX) return { type: 'image', format, data_base64: data };
  // This decodes outside the document worker's memory cap, so only up to the 2048 px that normalizeImage makes.
  if (!width || !height || Math.max(width, height) > 2048) return null;
  const { loadImage, createCanvas } = require('@napi-rs/canvas');
  const image = await loadImage(buffer);
  // Shrink to fit, grow a small image toward the minimum while it still fits, then pad a side that stays short.
  const scale = Math.min(JEV_MAX / Math.max(width, height), Math.max(1, JEV_MIN / Math.min(width, height)));
  const w = Math.min(JEV_MAX, Math.max(1, Math.round(width * scale))), h = Math.min(JEV_MAX, Math.max(1, Math.round(height * scale)));
  const canvas = createCanvas(Math.max(JEV_MIN, w), Math.max(JEV_MIN, h)), context = canvas.getContext('2d');
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, w, h);
  // Jev bills by pixels, not bytes, and JPEG encodes about twice as fast as PNG here (61 vs 30 ms at 1920x1080).
  return { type: 'image', format: 'jpeg', data_base64: (await canvas.encode('jpeg', 85)).toString('base64') };
}

// State snapshots leave inline images on the runner (null keeps counts); the UI fetches a shown image on demand.
function withoutImages(value, key) {
  if (typeof value === 'string') return (key === 'url' || key === 'images') && value.startsWith('data:image/') ? null : value;
  if (!value || typeof value !== 'object') return value;
  // Tool results carry base64 images as { data, media_type } (Claude) or { data, mimeType } (MCP).
  const base64Image = typeof value.data === 'string' && /^image\//.test(value.media_type || value.mimeType || '');
  let copy = null;
  for (const name of Array.isArray(value) ? value.keys() : Object.keys(value)) {
    const next = base64Image && name === 'data' ? null : withoutImages(value[name], Array.isArray(value) ? key : name);
    if (next !== value[name]) (copy ||= Array.isArray(value) ? [...value] : { ...value })[name] = next;
  }
  return copy || value;
}

module.exports = { normalizeImage, imageData, jevImage, withoutImages };
