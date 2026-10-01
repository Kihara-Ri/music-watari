// 实物照片处理：统一压缩到长边 1600 的 JPEG。
// HEIC/HEIF（iPhone 默认格式）浏览器普遍不原生解码：首次遇到时懒加载
// 本地 heic2any（wasm）转成 JPEG 再走通用压缩。多张须串行，避免同时解码。

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
  const url = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(new Error('图片读取失败'));
    r.readAsDataURL(blob);
  });
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('图片解码失败'));
    i.src = url;
  });
  const s = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * s));
  c.height = Math.max(1, Math.round(img.naturalHeight * s));
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';   // 透明 PNG 垫白底
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82);
}

// 照片队列条目：existing = 已有照片的序号；data = 新照片的 data URL；
// pending/error = 处理中的占位与失败态
export const MAX_PHOTOS = 30;
export type PhotoSlot = ({existing: number} | {data: string} | {pending: true} | {error: string}) & {token?: string};

export function isPending(p: PhotoSlot): p is {pending: true} { return (p as {pending?: boolean}).pending === true; }

// 串行照片队列：同一时刻只压一张，逐个回调回填
export class PhotoQueue {
  private chain: Promise<unknown> = Promise.resolve();

  add(file: File, onDone: (data: string) => void, onError: (message: string) => void): void {
    this.chain = this.chain
      .then(() => compressPhoto(file))
      .then(onDone)
      .catch(err => onError(err?.message || '处理失败'));
  }
}
