// wawoff2 未自带类型声明。它是 Google woff2 编码器的 WASM 封装。
declare module 'wawoff2' {
  /** 把整段 sfnt（TTF/OTF）无损封装成 woff2，不裁剪字形 */
  export function compress(input: Uint8Array): Promise<Uint8Array>;
  /** woff2 解回 sfnt */
  export function decompress(input: Uint8Array): Promise<Uint8Array>;
}
