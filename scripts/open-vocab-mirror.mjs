/** Actions only: mirror one open-vocabulary candidate's pinned files from Hugging Face into web/__hf/ so the
 * evaluation pages load the same bytes from the local server (download time is not part of any measurement).
 * Usage: node scripts/open-vocab-mirror.mjs <candidate id>   e.g. A-q8. Writes artifacts/open-vocab/mirror-<id>.json. */
import {createHash} from 'node:crypto';
import {mkdirSync,writeFileSync,existsSync,statSync,createWriteStream} from 'node:fs';
import {dirname,join} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {OPEN_VOCAB_CANDIDATES} from '../web/open-vocab.mjs';
const id=process.argv[2],c=OPEN_VOCAB_CANDIDATES[id];if(!c)throw new Error(`unknown candidate ${id}`);
const tree=await (await fetch(`https://huggingface.co/api/models/${c.repo}/tree/${c.revision}?recursive=1`)).json();
const wanted=tree.filter(f=>f.type==='file'&&(f.path===c.file||(!/\.onnx(_data)?$/.test(f.path)&&!/\.(md|gitattributes)$/.test(f.path)&&(f.size||0)<20e6)));
if(!wanted.some(f=>f.path===c.file))throw new Error(`${c.file} not in ${c.repo}@${c.revision}`);
const manifest={candidate:id,repo:c.repo,revision:c.revision,files:[]};
for(const f of wanted){
 const dest=join('web/__hf',c.repo,'resolve',c.revision,f.path);mkdirSync(dirname(dest),{recursive:true});
 if(!existsSync(dest)||statSync(dest).size!==f.size){const r=await fetch(`https://huggingface.co/${c.repo}/resolve/${c.revision}/${f.path}`);if(!r.ok)throw new Error(`${f.path}: HTTP ${r.status}`);await pipeline(Readable.fromWeb(r.body),createWriteStream(dest));}
 const size=statSync(dest).size;if(size!==f.size)throw new Error(`${f.path}: ${size} bytes, expected ${f.size}`);
 const hash=createHash('sha256');await pipeline((await import('node:fs')).createReadStream(dest),hash);
 manifest.files.push({path:f.path,bytes:size,sha256:hash.digest('hex')});
}
if(manifest.files.find(f=>f.path===c.file).bytes!==c.bytes)throw new Error(`${c.file} size differs from the protocol`);
// transformers.js 4.3.2 checks whether tokenizer_config.json exists at revision "main" (it does not pass the pinned
// revision to that check), then loads every file at the pinned revision. The mirror answers the check with the same bytes.
const {cpSync}=await import('node:fs');cpSync(join('web/__hf',c.repo,'resolve',c.revision),join('web/__hf',c.repo,'resolve','main'),{recursive:true});
mkdirSync('artifacts/open-vocab',{recursive:true});writeFileSync(`artifacts/open-vocab/mirror-${id}.json`,JSON.stringify(manifest,null,1));
console.log(JSON.stringify(manifest.files.map(f=>[f.path,f.bytes])));
