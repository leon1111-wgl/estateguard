import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
// The results page shows the PKLot numbers as static text; they must match the committed evaluation file.
const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
const pklot=JSON.parse(readFileSync(new URL('../docs/validation/pklot-evaluation.json',import.meta.url),'utf8'));
const metrics=key=>key==='mlp32'?pklot.mlp32.all:pklot.models[key].all;
test('the PKLot panel repeats the published held-out numbers exactly',()=>{
 const cells=[...html.matchAll(/data-pklot="([a-z0-9]+)\.([a-z_]+)">([\d.]+)%</g)];
 assert.equal(cells.length,9);
 for(const [,model,field,shown] of cells)assert.equal(shown,(metrics(model)[field]*100).toFixed(2),`${model}.${field}`);
});
test('the panel keeps its caveats',()=>{
 const panel=html.slice(html.indexOf('id="parking-pklot"'),html.indexOf('</section>',html.indexOf('id="parking-pklot"')));
 for(const phrase of ['从未参与训练','数字未在本次发布中重算','只有白天画面','不能排除编码器的预训练语料','已观察数据'])assert.ok(panel.includes(phrase),phrase);
});
