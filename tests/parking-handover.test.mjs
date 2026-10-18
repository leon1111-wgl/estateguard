import test from 'node:test';
import assert from 'node:assert/strict';
import {readParkingHandover} from '../web/parking-handover.mjs';

const context={frames:[{id:'B-late',session:'B-day',sample_ids:['B:1','B:52']},{id:'C8-noon',session:'C8-test',sample_ids:['C8:615']}],models:{mlp32:'hash-a',mobilenet:'hash-b'},current_model:'mobilenet'};
const view={version:1,frame_id:'B-late',sample_id:'B:52',model_key:'mlp32',model_sha256:'hash-a',filter:'evidence',show_truth:true};
const reviews={'B:52':{decision:'uncertain'}};
test('交班保留同一快照、车位、模型和人工筛选',()=>{
 const result=readParkingHandover({view,source_frame:'B-late',prediction_model:{key:'mlp32',model_sha256:'hash-a'}},context,reviews);
 assert.deepEqual(result.view,view);assert.equal(result.session,'B-day');assert.deepEqual(result.notes,[]);
});
test('模型筛选须重新推理，恢复时仍定位原车位',()=>{
 for(const filter of ['errors','audit','model_uncertain']){
  const result=readParkingHandover({view:{...view,filter}},context,reviews);
  assert.equal(result.view.filter,'all');assert.equal(result.view.sample_id,'B:52');assert.match(result.notes.join(''),/重新分析/);
 }
});
test('保存后的人工筛选可能隐藏所选车位，此时恢复全部并解释',()=>{
 const result=readParkingHandover({view:{...view,filter:'review'}},context,{'B:52':{decision:'busy'}});
 assert.equal(result.view.filter,'all');assert.match(result.notes.join(''),/隐藏/);
 assert.equal(readParkingHandover({view:{...view,sample_id:null,filter:'confirmed'}},context,{}).view.sample_id,null);
});
test('旧版交班从 source_frame 和模型版本恢复，不猜跨相机位置',()=>{
 const result=readParkingHandover({source_frame:'C8-noon',prediction_model:{key:'mobilenet',model_sha256:'hash-b'}},context,{'C8:615':{decision:'busy'}});
 assert.equal(result.session,'C8-test');assert.equal(result.view.sample_id,'C8:615');assert.equal(result.view.model_key,'mobilenet');assert.match(result.notes.join(''),/旧版/);
 assert.equal(readParkingHandover({reviews:{}},context,{}),null);
});
test('损坏或不一致的位置和模型版本必须整份拒绝',()=>{
 const invalid=[null,[],{...view,version:2},{...view,frame_id:'missing'},{...view,sample_id:'C8:615'},{...view,sample_id:7},{...view,model_key:'unknown'},{...view,model_key:'__proto__'},{...view,model_sha256:'changed'},{...view,filter:'unknown'},{...view,show_truth:'true'}];
 for(const entry of invalid)assert.throws(()=>readParkingHandover({view:entry},context,reviews),Error);
 assert.throws(()=>readParkingHandover({view,source_frame:'C8-noon'},context,reviews),/不一致/);
 assert.throws(()=>readParkingHandover({view,prediction_model:{key:'mobilenet',model_sha256:'hash-b'}},context,reviews),/不一致/);
 assert.throws(()=>readParkingHandover({source_frame:'missing'},context,reviews),/快照/);
 assert.throws(()=>readParkingHandover({source_frame:'B-late',prediction_model:{key:'mlp32',model_sha256:'stale'}},context,reviews),/模型/);
});
