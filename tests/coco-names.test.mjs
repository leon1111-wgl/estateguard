import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {COCO_CLASSES} from '../web/detector-dfine.mjs';
import {COCO_NAMES_ZH} from '../web/coco-names.mjs';
test('every class either detector can output has a Chinese label',()=>{
 assert.equal(COCO_CLASSES.length,80);
 const missing=COCO_CLASSES.filter(c=>!COCO_NAMES_ZH[c]);assert.deepEqual(missing,[]);
 const bundle=readFileSync(new URL('../web/vendor/coco-ssd.min.js',import.meta.url),'utf8');
 const ssd=[...bundle.matchAll(/displayName:"([^"]*)"/g)].map(m=>m[1]);assert.equal(ssd.length,80);
 assert.deepEqual(ssd.filter(c=>!COCO_NAMES_ZH[c]),[]);
 assert.deepEqual(Object.keys(COCO_NAMES_ZH).filter(c=>!COCO_CLASSES.includes(c)),[],'no labels for classes that do not exist');
});
