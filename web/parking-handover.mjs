import {parkingReviewStatus} from './parking-model.mjs';

const filters=new Set(['all','review','confirmed','evidence','model_uncertain','audit','errors']);
const modelFilters=new Set(['model_uncertain','audit','errors']);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
// Prepare a handover without touching UI or inference state. File scores are never restored.
export function readParkingHandover(data,context,reviews){
 const modern=Object.hasOwn(data,'view');
 if(!modern&&!Object.hasOwn(data,'source_frame'))return null;
 const notes=[];
 let view;
 if(modern){
  if(!object(data.view)||data.view.version!==1)throw new Error('交接位置格式或版本无效');
  view={...data.view};
  if(!filters.has(view.filter)||typeof view.show_truth!=='boolean')throw new Error('交接筛选设置无效');
  if(view.sample_id!==null&&typeof view.sample_id!=='string')throw new Error('交接车位编号无效');
  if(data.source_frame!==undefined&&data.source_frame!==view.frame_id)throw new Error('交接快照记录不一致');
  if(data.prediction_model!==undefined&&(!object(data.prediction_model)||data.prediction_model.key!==view.model_key||data.prediction_model.model_sha256!==view.model_sha256))throw new Error('交接模型记录不一致');
 }else{
  const model=data.prediction_model;
  if(model!==undefined&&!object(model))throw new Error('交接模型记录无效');
  view={version:1,frame_id:data.source_frame,sample_id:null,model_key:model===undefined?context.current_model:model.key,model_sha256:model===undefined?context.models[context.current_model]:model.model_sha256,filter:'all',show_truth:false};
  notes.push('旧版文件未记录精确选中车位和筛选，已定位到该快照首个有人工记录的车位；若无记录则显示首个车位。');
  if(!model)notes.push('旧版文件未记录所用模型，保留本页模型。');
 }
 const frame=typeof view.frame_id==='string'&&context.frames.find(f=>f.id===view.frame_id);
 if(!frame)throw new Error('交接快照不存在或对应公开数据未加载，请检查文件或刷新后重试');
 if(typeof view.model_key!=='string'||!Object.hasOwn(context.models,view.model_key)||context.models[view.model_key]!==view.model_sha256)throw new Error('交接模型不可用或版本不一致，请使用匹配版本的文件');
 if(!modern)view.sample_id=frame.sample_ids.find(id=>Object.hasOwn(reviews,id))??frame.sample_ids[0]??null;
 if(view.sample_id!==null&&!frame.sample_ids.includes(view.sample_id))throw new Error('交接车位不属于记录的快照');
 if(modelFilters.has(view.filter)){
  view.filter='all';notes.push('原筛选依赖模型结果，已切换“全部车位”；请重新分析后再筛选模型结果。');
 }else if(view.sample_id!==null){
  const status=parkingReviewStatus(reviews[view.sample_id]);
  const hidden=(view.filter==='review'&&status==='confirmed')||(view.filter==='confirmed'&&status!=='confirmed')||(view.filter==='evidence'&&status!=='needs_evidence');
  if(hidden){view.filter='all';notes.push('原人工筛选会隐藏交接车位，已切换“全部车位”以保留位置。');}
 }
 return {view,session:frame.session,notes};
}
