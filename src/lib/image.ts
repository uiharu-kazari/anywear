// Client-side image plumbing: downscaling for upload/storage and cropping
// detected garments out of screenshots.

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read that image.'));
    img.src = src;
  });
}

function toDataURL(canvas: HTMLCanvasElement, quality = 0.92): string {
  return canvas.toDataURL('image/jpeg', quality);
}

export function base64Of(dataUrl: string): string {
  return dataUrl.replace(/^data:[^;]+;base64,/, '');
}

export async function fileToDataURL(file: File | Blob, maxSide = 2000): Promise<string> {
  const raw = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
  return resizeDataURL(raw, maxSide);
}

export async function resizeDataURL(dataUrl: string, maxSide: number, quality = 0.92): Promise<string> {
  const img = await loadImage(dataUrl);
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return toDataURL(canvas, quality);
}

export async function urlToDataURL(url: string, maxSide = 2000): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Could not load the image.');
  return fileToDataURL(await res.blob(), maxSide);
}

/**
 * Crop a garment out of a screenshot using a Gemini box_2d
 * ([ymin,xmin,ymax,xmax] in 0-1000 normalized coordinates), with a little
 * breathing room. The VTO engine wants at least ~512px on the short side, so
 * small crops are upscaled.
 */
export async function cropByBox(
  dataUrl: string,
  box: [number, number, number, number],
  padFrac = 0.05,
): Promise<string> {
  const img = await loadImage(dataUrl);
  const [ymin, xmin, ymax, xmax] = box;
  let x = (xmin / 1000) * img.width;
  let y = (ymin / 1000) * img.height;
  let w = ((xmax - xmin) / 1000) * img.width;
  let h = ((ymax - ymin) / 1000) * img.height;
  const pad = Math.max(w, h) * padFrac;
  x = Math.max(0, x - pad);
  y = Math.max(0, y - pad);
  w = Math.min(img.width - x, w + pad * 2);
  h = Math.min(img.height - y, h + pad * 2);

  const minShort = 560;
  const scale = Math.max(1, minShort / Math.min(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, x, y, w, h, 0, 0, canvas.width, canvas.height);
  return toDataURL(canvas);
}
