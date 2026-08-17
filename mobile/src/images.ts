import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';

export interface LocalImage {
  uri: string;
  width: number;
  height: number;
  base64: string;
}

async function normalize(uri: string, width: number, maxSide = 1600): Promise<LocalImage> {
  const actions = width > maxSide ? [{ resize: { width: maxSide } }] : [];
  const out = await manipulateAsync(uri, actions, { base64: true, compress: 0.9, format: SaveFormat.JPEG });
  return { uri: out.uri, width: out.width, height: out.height, base64: out.base64! };
}

export async function pickImage(): Promise<LocalImage | null> {
  const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: 'images', quality: 1 });
  const asset = res.assets?.[0];
  if (res.canceled || !asset) return null;
  return normalize(asset.uri, asset.width ?? 4000);
}

export async function base64ToLocal(base64: string, name: string): Promise<LocalImage> {
  const path = `${FileSystem.cacheDirectory}${name}`;
  await FileSystem.writeAsStringAsync(path, base64, { encoding: FileSystem.EncodingType.Base64 });
  const out = await manipulateAsync(path, [], { base64: true, compress: 0.9, format: SaveFormat.JPEG });
  return { uri: out.uri, width: out.width, height: out.height, base64: out.base64! };
}

/** Crop a garment out of a screenshot using a Gemini box_2d (0-1000 normalized). */
export async function cropByBox(img: LocalImage, box: [number, number, number, number]): Promise<LocalImage> {
  const [ymin, xmin, ymax, xmax] = box;
  const pad = 0.05 * Math.max(((xmax - xmin) / 1000) * img.width, ((ymax - ymin) / 1000) * img.height);
  const x = Math.max(0, (xmin / 1000) * img.width - pad);
  const y = Math.max(0, (ymin / 1000) * img.height - pad);
  const w = Math.min(img.width - x, ((xmax - xmin) / 1000) * img.width + pad * 2);
  const h = Math.min(img.height - y, ((ymax - ymin) / 1000) * img.height + pad * 2);
  const actions: object[] = [
    { crop: { originX: Math.round(x), originY: Math.round(y), width: Math.round(w), height: Math.round(h) } },
  ];
  // The VTO engine wants >= ~512px on the short side.
  if (Math.min(w, h) < 560) {
    const scale = 640 / Math.min(w, h);
    actions.push({ resize: { width: Math.round(w * scale) } });
  }
  const out = await manipulateAsync(img.uri, actions as never, { base64: true, compress: 0.92, format: SaveFormat.JPEG });
  return { uri: out.uri, width: out.width, height: out.height, base64: out.base64! };
}
