/** What the visitor's browser can run, checked before any model download.
 * The bundled ONNX Runtime Web build (D-FINE-N, DINOv2) ships only the SIMD WebAssembly binary, so a browser
 * without WebAssembly SIMD (older Safari, or WebAssembly switched off, e.g. iOS Lockdown Mode or a managed policy)
 * cannot start it. TensorFlow.js models (SSDLite, MobileNetV2) run on WebGL or CPU and need no WebAssembly. */
// Smallest module using a SIMD instruction: () -> v128 { i8x16.popcnt(i8x16.splat(i32.const 0)) }.
const SIMD_PROBE=new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]);
export function wasmSimdSupported(){
 try{return typeof WebAssembly==='object'&&typeof WebAssembly.validate==='function'&&WebAssembly.validate(SIMD_PROBE);}catch{return false;}
}
export const ORT_UNSUPPORTED='此浏览器不支持 WebAssembly SIMD（或已关闭 WebAssembly，例如 iOS 锁定模式），无法运行 ONNX Runtime Web 上的 D-FINE-N 与 DINOv2。';
export class CapabilityError extends Error{constructor(message){super(message);this.name='CapabilityError';this.code='wasm-simd-unsupported';}}

const SIGNATURES=[
 ['image/jpeg',b=>b[0]===0xff&&b[1]===0xd8&&b[2]===0xff],
 ['image/png',b=>[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a].every((x,i)=>b[i]===x)],
 ['image/webp',b=>ascii(b,0,4)==='RIFF'&&ascii(b,8,12)==='WEBP'],
 ['video/webm',b=>b[0]===0x1a&&b[1]===0x45&&b[2]===0xdf&&b[3]===0xa3],
 // ISO BMFF: 'ftyp' box at offset 4. HEIF/AVIF stills use the same box, so their brands are excluded here.
 ['video/mp4',b=>ascii(b,4,8)==='ftyp'&&!/^(heic|heix|hevc|heim|heis|mif1|msf1|avif|avis)$/.test(ascii(b,8,12))],
];
const ascii=(b,from,to)=>String.fromCharCode(...b.slice(from,to));
const HEIF_BRAND=/^(heic|heix|hevc|heim|heis|mif1|msf1)$/;
/** File type from the first bytes, for files whose picker reports no MIME type (some Android and Windows pickers).
 * Returns '' when the bytes match none of the supported formats; 'image/heic' is reported so the page can say why. */
export function sniffType(bytes){
 const b=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);if(b.length<12)return '';
 if(ascii(b,4,8)==='ftyp'&&HEIF_BRAND.test(ascii(b,8,12)))return 'image/heic';
 for(const [type,match] of SIGNATURES)if(match(b))return type;
 return '';
}
/** The type the page should treat a file as: the picker's MIME type, or the sniffed one when the picker gave none or
 * only the generic application/octet-stream (some pickers and download managers do). */
export async function effectiveType(file){
 if(file.type==='image/jpg'||file.type==='image/pjpeg')return 'image/jpeg';
 if(file.type&&file.type!=='application/octet-stream')return file.type;
 try{return sniffType(new Uint8Array(await file.slice(0,16).arrayBuffer()));}catch{return '';}
}
/** A specific reason for common unsupported photo formats; null when the generic message is enough. */
export function unsupportedHint(type,name=''){
 if(/^image\/hei[cf]/.test(type)||/\.(heic|heif)$/i.test(name))return '这是 HEIC/HEIF 照片（iPhone 默认格式），多数浏览器无法解码。请在相册中导出为 JPEG，或在 iPhone「设置 › 相机 › 格式」选择「兼容性最佳」后重拍。';
 if(/^image\/avif$/.test(type)||/\.avif$/i.test(name))return '暂不接受 AVIF，请转换为 JPEG、PNG 或 WebP。';
 if(type==='video/quicktime'||/\.mov$/i.test(name))return '这是 MOV 视频（iPhone 默认格式）。请导出或转换为 MP4（H.264）后再试；单个片段最多分析 20 秒。';
 return null;
}
/** A warning for frames more than 3:1 long: the detectors resize to a square input, so objects in elongated frames are
 * squashed and may be missed. Empty for ordinary frames. It stays on screen after the analysis, not only when the file opens. */
export function aspectNote(width,height){const long=Math.max(width,height),short=Math.min(width,height);if(!(short>0))return '';const ratio=long/short;return ratio>3?`画面长宽比约 ${ratio.toFixed(1)}:1，检测器会把画面缩放成方形输入（D-FINE-N 为 640×640），细长画面里的物体会变形，可能漏检。`:'';}
