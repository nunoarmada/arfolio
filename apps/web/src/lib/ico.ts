/** One image of an ICO file: its pixel size and the PNG bytes that carry it. */
export interface IcoImage {
  size: number;
  png: Uint8Array;
}

/**
 * Packs PNG images into an ICO container (ICONDIR + one ICONDIRENTRY per image + the PNG payloads).
 * ICO has allowed PNG payloads since Windows Vista and every current browser reads them. Sizes
 * run 1-256; 256 is stored as 0, as the format requires.
 */
export function packIco(images: readonly IcoImage[]): Uint8Array {
  if (images.length === 0) throw new RangeError('an ICO file needs at least one image');
  const headerSize = 6 + 16 * images.length;
  const total = images.reduce((sum, image) => sum + image.png.length, headerSize);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0, true); // reserved
  view.setUint16(2, 1, true); // type: icon
  view.setUint16(4, images.length, true);
  let offset = headerSize;
  images.forEach((image, i) => {
    if (!Number.isInteger(image.size) || image.size < 1 || image.size > 256) {
      throw new RangeError(`ICO image size must be 1-256, got ${image.size}`);
    }
    const entry = 6 + 16 * i;
    view.setUint8(entry, image.size === 256 ? 0 : image.size); // width
    view.setUint8(entry + 1, image.size === 256 ? 0 : image.size); // height
    view.setUint8(entry + 2, 0); // palette colours (none)
    view.setUint8(entry + 3, 0); // reserved
    view.setUint16(entry + 4, 1, true); // colour planes
    view.setUint16(entry + 6, 32, true); // bits per pixel
    view.setUint32(entry + 8, image.png.length, true); // payload size
    view.setUint32(entry + 12, offset, true); // payload offset
    out.set(image.png, offset);
    offset += image.png.length;
  });
  return out;
}
