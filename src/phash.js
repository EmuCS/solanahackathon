import sharp from 'sharp';

// 64-bit difference hash: survives re-compression, resizing and format changes,
// so a photo can still be matched after a platform strips its metadata.
export async function dhash(buf) {
  const data = await sharp(buf)
    .rotate() // apply EXIF orientation so re-encoded copies line up
    .flatten({ background: '#ffffff' })
    .grayscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer();
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits = (bits << 1n) | (data[y * 9 + x] < data[y * 9 + x + 1] ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

export function hamming(a, b) {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

export async function thumbnail(buf) {
  return sharp(buf).rotate().resize(640, 640, { fit: 'inside' }).jpeg({ quality: 80 }).toBuffer();
}
