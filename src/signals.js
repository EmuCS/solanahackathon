// Cheap provenance signals for photos NOT captured in FraudBusters (the upload tier).
// Metadata is easy to strip or forge, so these are risk signals with reasons — never proof.
import sharp from 'sharp';
import exifReader from 'exif-reader';

// Labels that generators / editors write into C2PA, XMP (IPTC DigitalSourceType) or PNG text chunks
const AI_MARKERS = [
  [/compositeWithTrainedAlgorithmicMedia/, 'IPTC label: composite with AI-generated content'],
  [/trainedAlgorithmicMedia/, 'IPTC label: AI-generated (trainedAlgorithmicMedia)'],
  [/OpenAI|DALL.?E|ChatGPT|GPT-4o|gpt-image/i, 'OpenAI / ChatGPT generator label'],
  [/Made with Google AI|Imagen|Gemini/i, 'Google AI generator label'],
  [/Adobe Firefly/i, 'Adobe Firefly generator label'],
  [/Midjourney/i, 'Midjourney generator label'],
  [/Stable Diffusion|stability\.ai|ComfyUI|Negative prompt:|Sampler: /i, 'Stable Diffusion generation parameters'],
];

const EDITORS = /photoshop|lightroom|gimp|snapseed|canva|picsart|facetune|pixelmator|affinity|photoroom|remini/i;

const check = (id, label, status, detail) => ({ id, label, status, detail });

export function aiLabelCheck(buf) {
  // C2PA manifests (JUMBF), XMP and PNG text are stored as plain bytes — scan them directly
  const text = buf.toString('latin1');
  const hits = AI_MARKERS.filter(([re]) => re.test(text)).map(([, why]) => why);
  return hits.length
    ? check('ai_label', 'AI-generation labels', 'fail', `Found: ${[...new Set(hits)].join('; ')}`)
    : check('ai_label', 'AI-generation labels', 'pass', 'No AI-generator labels found in C2PA / XMP / metadata');
}

export async function metadataChecks(buf) {
  const out = [];
  const text = buf.toString('latin1');
  if (/c2pa/.test(text)) {
    out.push(check('c2pa', 'Content Credentials (C2PA)', 'info', 'C2PA manifest present (issuer not validated in prototype)'));
  }

  const meta = await sharp(buf).metadata();
  let exif = null;
  try {
    exif = meta.exif ? exifReader(meta.exif) : null;
  } catch {}
  const make = exif?.Image?.Make?.trim();
  const model = exif?.Image?.Model?.trim();
  const software = exif?.Image?.Software?.trim();
  const taken = exif?.Photo?.DateTimeOriginal;

  if (make || model) {
    out.push(check('camera', 'Camera metadata', 'info', `${[make, model].filter(Boolean).join(' ')} — can be forged, weak evidence`));
  } else {
    out.push(check('camera', 'Camera metadata', 'warn', 'No camera metadata: stripped (messaging app, screenshot, re-save) or never a camera photo'));
  }

  if (software && EDITORS.test(software)) {
    out.push(check('editor', 'Editing software', 'warn', `Saved by editing software: ${software}`));
  }

  if (taken instanceof Date && !isNaN(taken)) {
    const days = Math.floor((Date.now() - taken.getTime()) / 86400000);
    if (days > 30) out.push(check('age', 'Capture date', 'warn', `Metadata says taken ${taken.toISOString().slice(0, 10)} (${days} days ago)`));
  }

  if (meta.format === 'png' && !make) {
    out.push(check('format', 'File format', 'info', 'PNG without camera data — typical of screenshots and generated images'));
  }
  return out;
}
