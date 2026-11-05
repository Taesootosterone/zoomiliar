const $ = id => document.getElementById(id);
const peers = new Map();
let ws, mic, screenStream, selfId, members=[], presenter=null, config, started, timer, pendingShare=false, joined=false, generation=0;
let room=location.hash.slice(1);
if(room && !/^[a-f0-9]{32}$/.test(room)){ $('status').textContent='초대 링크가 올바르지 않습니다. 새 방을 열어주세요.';room='';history.replaceState(null,'',location.pathname);}
if(room){$('join-title').textContent='대화에 함께하기';$('join').textContent='대화방 참여하기 →';}
const status = text => $('status').textContent=text;
function send(data){if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(data));}
function render(){
  $('count').textContent=`${members.length} / 10`;
  $('members').replaceChildren(...members.map(m=>{
    const el=document.createElement('div');el.className='member';
    const avatar=document.createElement('span');avatar.className='avatar';avatar.textContent=m.name.slice(0,1);
    const info=document.createElement('div');info.className='member-info';
    const name=document.createElement('strong');name.textContent=m.name+(m.id===selfId?' (나)':'');
    const state=document.createElement('small');state.textContent=(m.muted?'음소거':'마이크 켜짐')+(m.id===selfId?'':` · ${peers.get(m.id)?.pc.connectionState==='connected'?'연결됨':'연결 중'}`);
    info.append(name,state);el.append(avatar,info);return el;
  }));
  $('share').disabled=!!presenter && presenter!==selfId;
  $('share').textContent=screenStream?'공유 중지':'화면 공유';
  const track=presenter===selfId?screenStream?.getVideoTracks()[0]:peers.get(presenter)?.video;
  $('screen').hidden=!track; $('empty').hidden=!!track; $('screen-label').hidden=!track;
  if(track && $('screen').srcObject?.getVideoTracks()[0]!==track)$('screen').srcObject=new MediaStream([track]);
  if(!track)$('screen').srcObject=null;
  $('screen-label').textContent=(members.find(m=>m.id===presenter)?.name||'')+' 님의 화면';
}
async function makePeer(id, initiator){
  if(peers.has(id))return peers.get(id);
  const pc=new RTCPeerConnection(config);
  const p={pc,queue:Promise.resolve(),audio:document.createElement('audio'),video:null};peers.set(id,p);
  p.audio.autoplay=true;document.body.append(p.audio);
  pc.addTrack(mic.getAudioTracks()[0],mic);
  // Reserve a video sender once: starting/stopping sharing needs no renegotiation.
  if(initiator){p.sender=pc.addTransceiver('video',{direction:'sendrecv'}).sender;
    if(screenStream && !pendingShare)await p.sender.replaceTrack(screenStream.getVideoTracks()[0]);}
  pc.onicecandidate=e=>{if(e.candidate)send({type:'signal',to:id,data:{candidate:e.candidate}});};
  pc.ontrack=e=>{
    if(e.track.kind==='audio'){p.audio.srcObject=new MediaStream([e.track]);p.audio.play().catch(()=>$('sound').hidden=false);}
    else{p.video=e.track;render();}
  };
  pc.onconnectionstatechange=()=>{
    render();
    if(pc.connectionState==='failed')status('참가자 연결에 실패했습니다. 다시 입장하거나 운영자에게 TURN 설정을 요청하세요.');
  };
  if(initiator){await pc.setLocalDescription(await pc.createOffer());send({type:'signal',to:id,data:{description:pc.localDescription}});}
  return p;
}
async function signal(m){
  let p=peers.get(m.from);if(!p)p=await makePeer(m.from,false);
  p.queue=p.queue.then(async()=>{
    if(m.data?.description){await p.pc.setRemoteDescription(m.data.description);if(m.data.description.type==='offer'){const video=p.pc.getTransceivers().find(t=>t.receiver.track.kind==='video');video.direction='sendrecv';p.sender=video.sender;if(screenStream && !pendingShare)await p.sender.replaceTrack(screenStream.getVideoTracks()[0]);await p.pc.setLocalDescription(await p.pc.createAnswer());send({type:'signal',to:m.from,data:{description:p.pc.localDescription}});}}
    else if(m.data?.candidate)await p.pc.addIceCandidate(m.data.candidate);
  }).catch(()=>status('연결 협상에 실패했습니다. 나갔다가 다시 입장해주세요.'));
  await p.queue;
}
function dropPeer(id){const p=peers.get(id);if(p){p.pc.close();p.audio.remove();peers.delete(id);}}
async function stopShare(){
  pendingShare=false;
  const old=screenStream;screenStream=null;
  old?.getTracks().forEach(t=>t.stop());
  await Promise.allSettled([...peers.values()].filter(p=>p.sender).map(p=>p.sender.replaceTrack(null)));
  send({type:'share-stop'});render();
}
function leave(message='대화를 마쳤습니다. 다시 만나고 싶을 때 들어오세요.'){
  generation++;joined=false;pendingShare=false;
  mic?.getTracks().forEach(t=>t.stop());screenStream?.getTracks().forEach(t=>t.stop());mic=null;screenStream=null;
  for(const id of peers.keys())dropPeer(id);
  const socket=ws;ws=null;socket?.close();
  members=[];presenter=null;selfId=null;clearInterval(timer);
  $('call').hidden=true;$('lobby').hidden=false;$('join').disabled=false;$('sound').hidden=true;
  $('mute').textContent='마이크 켜기';$('mute').setAttribute('aria-pressed','true');render();status(message);
}
$('join-form').addEventListener('submit',async e=>{
  e.preventDefault();$('join').disabled=true;status('마이크와 연결을 준비하고 있습니다…');const attempt=++generation;
  try{
    if(!isSecureContext || !navigator.mediaDevices?.getUserMedia)throw Error('HTTPS 주소 또는 localhost에서 열어주세요.');
    config=await fetch('/config').then(r=>{if(!r.ok)throw Error('서버 설정을 읽지 못했습니다.');return r.json();});
    const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
    if(attempt!==generation){stream.getTracks().forEach(t=>t.stop());return;}
    mic=stream;mic.getAudioTracks()[0].enabled=false;
    mic.getAudioTracks()[0].onended=()=>leave('마이크 연결이 끊겼습니다. 장치를 확인하고 다시 입장하세요.');
    if(!room){room=Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');history.replaceState(null,'','#'+room);}
    const socket=ws=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/ws`);
    const timeout=setTimeout(()=>{if(!joined && ws===socket)leave('서버에 연결하지 못했습니다. 다시 시도해주세요.');},15000);
    socket.onopen=()=>send({type:'join',room,name:$('name').value.trim()});
    let inbox=Promise.resolve();
    socket.onmessage=e=>{inbox=inbox.then(async()=>{
      if(ws!==socket)return;
      const m=JSON.parse(e.data);
      if(m.type==='error'){clearTimeout(timeout);leave(m.message);return;}
      if(m.type==='joined'){
        clearTimeout(timeout);joined=true;selfId=m.id;started=Date.now();$('lobby').hidden=true;$('call').hidden=false;
        status(config.iceServers.length?'이어폰을 사용하고 마이크를 켜서 이야기하세요.':'로컬 연결 모드입니다. 외부 인터넷에서는 운영자의 STUN/TURN 설정이 필요할 수 있어요.');
        timer=setInterval(()=>{const s=Math.floor((Date.now()-started)/1000);$('timer').textContent=[Math.floor(s/3600),Math.floor(s/60)%60,s%60].map(n=>String(n).padStart(2,'0')).join(':');},1000);
        for(const id of m.peers)await makePeer(id,true);
      }
      if(m.type==='roster'){members=m.members;presenter=m.presenter;render();}
      if(m.type==='peer-left'){dropPeer(m.id);render();}
      if(m.type==='signal')await signal(m);
      if(m.type==='share-granted'){
        if(!pendingShare||!screenStream){send({type:'share-stop'});return;}
        pendingShare=false;
        await Promise.all([...peers.values()].filter(p=>p.sender).map(p=>p.sender.replaceTrack(screenStream.getVideoTracks()[0])));render();
      }
      if(m.type==='share-denied'){await stopShare();status('다른 사람이 먼저 공유를 시작했습니다. 잠시 기다려주세요.');}
    }).catch(()=>status('연결 처리 중 오류가 발생했습니다. 다시 입장해주세요.'));};
    socket.onclose=()=>{clearTimeout(timeout);if(ws===socket)leave('서버 연결이 끊겨 통화를 종료했습니다. 다시 입장해주세요.');};
    socket.onerror=()=>status('서버 연결을 확인해주세요.');
  }catch(err){if(attempt===generation)leave(err.name==='NotAllowedError'?'마이크 사용을 허용한 뒤 다시 참여해주세요.':err.message||'마이크를 찾을 수 없습니다.');}
});
$('mute').onclick=()=>{if(!mic)return;const t=mic.getAudioTracks()[0];t.enabled=!t.enabled;$('mute').textContent=t.enabled?'음소거':'마이크 켜기';$('mute').setAttribute('aria-pressed',String(!t.enabled));send({type:'mute',muted:!t.enabled});};
$('share').onclick=async()=>{
  if(screenStream){await stopShare();return;}
  if(!navigator.mediaDevices?.getDisplayMedia){status('이 브라우저는 화면 공유를 지원하지 않습니다. 데스크톱 Chrome에서 열어주세요.');return;}
  const attempt=generation;$('share').disabled=true;
  try{
    const stream=await navigator.mediaDevices.getDisplayMedia({video:{width:{ideal:1280,max:1920},height:{ideal:720,max:1080},frameRate:{ideal:10,max:15}},audio:false});
    if(attempt!==generation||!joined){stream.getTracks().forEach(t=>t.stop());return;}
    screenStream=stream;pendingShare=true;
    stream.getVideoTracks()[0].onended=()=>stopShare();send({type:'share-start'});
  }catch(err){status(err.name==='NotAllowedError'?'화면 공유를 취소했거나 권한이 허용되지 않았습니다.':'화면 공유를 시작하지 못했습니다.');}
  finally{render();}
};
$('sound').onclick=async()=>{const results=await Promise.allSettled([...peers.values()].map(p=>p.audio.play()));$('sound').hidden=results.every(r=>r.status==='fulfilled');};
$('invite').onclick=async()=>{try{await navigator.clipboard.writeText(location.href);status('초대 링크를 복사했습니다. 링크를 받은 사람은 바로 참여할 수 있어요.');}catch{status('주소창의 링크를 복사해 전달해주세요.');}};
$('leave').onclick=()=>leave();window.addEventListener('pagehide',()=>leave());
