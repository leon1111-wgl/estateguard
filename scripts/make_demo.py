"""Rebuild original synthetic fixtures. No private footage or detector inference."""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
base=datetime(2026,10,15,8,0,tzinfo=timezone(timedelta(hours=8)))
rows=[]
references=[]
def scenario(key,category,camera,zone,start,count,summary,truth=True,score=.88,quality=.9,permit=False,evidence=True,step=8,length=10):
    for i in range(count):
        t=base+timedelta(seconds=start+i*step)
        rows.append(dict(id=f'{key}-{i+1}',camera=camera,zone=zone,track=key,category=category,start=t.isoformat(),end=(t+timedelta(seconds=length)).isoformat(),score=score,quality=quality,summary=summary,evidence=[f'{key}-frame-{i+1}.jpg'] if evidence else [],move_permit=permit))
    if truth:
        references.append(dict(id=f'ref-{key}',camera=camera,zone=zone,track=key,category=category,start=(base+timedelta(seconds=start)).isoformat(),end=(base+timedelta(seconds=start+(count-1)*step+length)).isoformat()))
scenario('move-booked','bulky_load','LIFT-A','A栋客梯',0,4,'大件柜体进入客梯，来源记录声明已有搬运预约，仍需核对预约有效性。',truth=False,permit=True)
scenario('door-held','door_obstruction','LIFT-A','A栋客梯',20,4,'预约搬家过程中，推车疑似阻挡电梯关门；预约不能豁免挡门风险。')
scenario('impact','lift_impact','LIFT-B','B栋客梯',180,2,'柜体边缘疑似靠近电梯内壁，需对照前后画面，目前不能认定损坏。',truth=False)
scenario('unbooked','bulky_load','LIFT-B','B栋客梯',360,3,'客梯内出现家具搬运，暂未查到预约记录，应先核对现场搬运规定。')
scenario('van-route','blocked_access','PARK-ENTRY','标记公共通道',480,5,'配送车辆停在标记通道上，需确认通道用途并安排现场核查。')
scenario('bay-17','illegal_parking','PARK-B1','地下B1停车区',600,4,'车辆部分超出车位线，输入记录覆盖超过30秒，需核对临时停放许可。',step=12,length=15)
scenario('drop-off','illegal_parking','PARK-B1','临时装卸点',750,2,'短时配送停靠，尚不足以确认超时停车，需核对装卸安排。',truth=False,step=5,length=8)
scenario('reverse','wrong_way','PARK-RAMP','出口坡道',900,3,'连续观察提示车辆可能逆向行驶，应对照出口标识核查轨迹。')
scenario('bags','waste_dumping','REFUSE-A','A栋垃圾收集间',1080,3,'示例清运时段结束后，收集区域外仍有垃圾袋。')
scenario('full-bin','waste_overflow','REFUSE-B','花园垃圾收集点',1260,3,'垃圾容器顶盖无法闭合，物料高于边缘，需要核查并安排清运。')
scenario('dark-route','blocked_access','PARK-REAR','后门通道',1440,2,'暗光画面出现通道占用线索，图像不足以判断，应保留现场核查任务。',score=.35,quality=.25,evidence=False)
scenario('shadow','waste_dumping','REFUSE-A','A栋垃圾收集间',1560,1,'阴影疑似垃圾袋，检测分数较低，保留在全部事件中。',truth=False,score=.25)
# A manually authored positive with no corresponding observation makes detector blind spots explicit.
references.append(dict(id='ref-unseen-overflow',camera='REFUSE-C',zone='后侧垃圾收集间',track='unseen',category='waste_overflow',start=(base+timedelta(seconds=1700)).isoformat(),end=(base+timedelta(seconds=1740)).isoformat()))
batch=dict(schema_version=1,name='枫庭小区 · 模拟早班',provenance='原创合成场景，无真实住户或监控，不是模型推理结果或实地部署测量。',observations=rows)
(ROOT/'data/demo.json').write_text(json.dumps(batch,indent=2)+'\n')
(ROOT/'web/demo.json').write_text(json.dumps(batch,indent=2)+'\n')
(ROOT/'data/reference.json').write_text(json.dumps(dict(provenance='Hand-authored synthetic reference incidents; includes one deliberately unobserved event.',incidents=references),indent=2)+'\n')
print(f'{len(rows)} synthetic observations; {len(references)} reference incidents')
