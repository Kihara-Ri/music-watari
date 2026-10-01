// 实物照片处理：统一压缩到长边 1600 的 JPEG。
// HEIC/HEIF（iPhone 默认格式）浏览器普遍不原生解码：首次遇到时懒加载
// 本地 heic2any（wasm）转成 JPEG 再走通用压缩。heic2any 内部只有单个
// 解码 Worker，多张 HEIC 在其中自行排队，天然不会同时解码；其余环节经
// PhotoQueue 并发池重叠，多张总耗时不再逐张累加。
// 位图解码优先 createImageBitmap（免 base64 中转、解码不占主线程，需显式
// from-image 保住 EXIF 方向），抛错即回退 <img> 路径（等价旧行为）。

const isHeic = (f: File): boolean =>
  /\.hei[cf]$/i.test(f.name || '') || ['image/heic', 'image/heif'].includes((f.type || '').toLowerCase());

let heicReady: Promise<void> | null = null;

function loadHeic2any(): Promise<void> {
  if ((window as any).heic2any) return Promise.resolve();
  heicReady ??= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = '/vendor/heic2any.min.js';
    s.onload = () => res();
    s.onerror = () => { heicReady = null; rej(new Error('HEIC 解码组件加载失败，请检查网络')); };
    document.head.append(s);
  });
  return heicReady;
}

// <img> 回退：dataURL 中转 + 主线程解码，胜在处处可用
async function decodeViaImg(blob: Blob): Promise<HTMLImageElement> {
  const url = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(new Error('图片读取失败'));
    r.readAsDataURL(blob);
  });
  return new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('图片解码失败'));
    i.src = url;
  });
}

async function decodePhoto(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  try {
    return await createImageBitmap(blob, {imageOrientation: 'from-image'});
  } catch {
    return decodeViaImg(blob);
  }
}

export async function compressPhoto(file: File): Promise<string> {
  let blob: Blob = file;
  if (isHeic(file)) {
    await loadHeic2any();
    try {
      blob = await (window as any).heic2any({blob: file, toType: 'image/jpeg', quality: 0.9});
    } catch {
      throw new Error('HEIC 照片解码失败，文件可能已损坏');
    }
    if (Array.isArray(blob)) blob = blob[0];
  }
  const src = await decodePhoto(blob);
  const w = 'naturalWidth' in src ? src.naturalWidth : src.width;
  const h = 'naturalHeight' in src ? src.naturalHeight : src.height;
  const s = Math.min(1, 1600 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';   // 透明 PNG 垫白底
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, 0, 0, c.width, c.height);
  if ('close' in src) src.close();   // ImageBitmap 需显式释放
  return c.toDataURL('image/jpeg', 0.82);
}

// 照片队列条目：existing = 已有照片的序号；data = 新照片的 data URL；
// pending/error = 处理中的占位与失败态
export const MAX_PHOTOS = 30;
export type PhotoSlot = ({existing: number} | {data: string} | {pending: true} | {error: string}) & {token?: string};

export function isPending(p: PhotoSlot): p is {pending: true} { return (p as {pending?: boolean}).pending === true; }

// 并发照片池：2–3 条独立链，文件轮流进 lane。每个时刻至多 3 张在处理，
// HEIC 的 wasm 解码仍被 heic2any 的单 Worker 串住，内存有界。
export class PhotoQueue {
  private readonly lanes = Math.max(2, Math.min(3, navigator.hardwareConcurrency || 2));
  private chains: Promise<unknown>[] = Array.from({length: this.lanes}, () => Promise.resolve());
  private next = 0;

  add(file: File, onDone: (data: string) => void, onError: (message: string) => void): void {
    const i = this.next++ % this.lanes;
    this.chains[i] = this.chains[i]
      .then(() => compressPhoto(file))
      .then(onDone)
      .catch(err => onError(err?.message || '处理失败'));
  }
}
