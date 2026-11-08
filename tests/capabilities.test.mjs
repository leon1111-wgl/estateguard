import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sniffType,effectiveType,unsupportedHint,wasmSimdSupported} from '../web/capabilities.mjs';

const bytes=(...parts)=>{const out=[];for(const p of parts)typeof p==='string'?out.push(...[...p].map(c=>c.charCodeAt(0))):out.push(...p);while(out.length<16)out.push(0);return new Uint8Array(out);};
const box=brand=>bytes([0,0,0,24],'ftyp',brand);

test('sniffs the formats the page accepts from their first bytes',()=>{
 assert.equal(sniffType(new Uint8Array(readFileSync(new URL('../web/samples/bus.jpg',import.meta.url)))),'image/jpeg');
 assert.equal(sniffType(bytes([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])),'image/png');
 assert.equal(sniffType(bytes('RIFF',[1,2,3,4],'WEBP')),'image/webp');
 assert.equal(sniffType(bytes([0x1a,0x45,0xdf,0xa3])),'video/webm');
 for(const brand of ['isom','mp42','avc1','M4V '])assert.equal(sniffType(box(brand)),'video/mp4',brand);
});

test('HEIC is named so the page can explain it; AVIF and unknown bytes are not mistaken for MP4',()=>{
 for(const brand of ['heic','heix','mif1'])assert.equal(sniffType(box(brand)),'image/heic',brand);
 assert.equal(sniffType(box('avif')),'');
 assert.equal(sniffType(bytes('GIF89a')),'');
 assert.equal(sniffType(bytes('%PDF-1.7')),'');
 assert.equal(sniffType(new Uint8Array([0xff,0xd8])),'','too short to decide');
});

test('the picker type wins; a missing type falls back to the bytes',async()=>{
 const jpeg=readFileSync(new URL('../web/samples/bus.jpg',import.meta.url));
 assert.equal(await effectiveType(new File([jpeg],'photo')),'image/jpeg');
 assert.equal(await effectiveType(new File([jpeg],'a.png',{type:'image/png'})),'image/png');
 assert.equal(await effectiveType(new File([box('heic')],'IMG_0001.HEIC')),'image/heic');
 assert.equal(await effectiveType(new File(['hello'],'notes.txt')),'');
 assert.equal(await effectiveType(new File([jpeg],'photo.bin',{type:'application/octet-stream'})),'image/jpeg');
 assert.equal(await effectiveType(new File(['hello'],'x.bin',{type:'application/octet-stream'})),'');
});

test('unsupported photo formats get a specific reason, other types the generic message',()=>{
 assert.match(unsupportedHint('image/heic'),/HEIC/);
 assert.match(unsupportedHint('','IMG_1234.heif'),/HEIC/);
 assert.match(unsupportedHint('image/avif'),/AVIF/);
 assert.equal(unsupportedHint('image/gif','a.gif'),null);
 assert.equal(unsupportedHint('',''),null);
});

test('the SIMD probe is a valid SIMD module and the check fails closed',()=>{
 assert.equal(wasmSimdSupported(),true,'Node 22+ supports WebAssembly SIMD');
 const validate=WebAssembly.validate;
 try{
  WebAssembly.validate=()=>false;assert.equal(wasmSimdSupported(),false);
  WebAssembly.validate=()=>{throw new Error('blocked');};assert.equal(wasmSimdSupported(),false);
 }finally{WebAssembly.validate=validate;}
 // The probe must use a SIMD opcode: the same module with the SIMD instructions replaced by nops is not v128-typed.
 const probe=new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]);
 assert.equal(WebAssembly.validate(probe),true);
 const broken=probe.slice();broken[25]=1;broken[26]=1;broken[27]=1;broken[28]=1;
 assert.equal(WebAssembly.validate(broken),false);
});
