import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

export function createApp({iceServers = [], origin = '', maxConnections = 200} = {}) {
  const rooms = new Map();
  const files = {'/':['index.html','text/html'], '/app.js':['app.js','text/javascript'], '/style.css':['style.css','text/css']};
  const server = http.createServer(async (req,res) => {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Permissions-Policy','camera=(), microphone=(self), display-capture=(self)');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'");
    if(req.method !== 'GET') {res.writeHead(405).end();return;}
    const path = new URL(req.url,'http://localhost').pathname;
    if(path === '/health') {res.writeHead(200,{'Content-Type':'application/json'}).end('{"ok":true}'); return;}
    if(path === '/config') {res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({iceServers})); return;}
    if(!files[path]) {res.writeHead(404).end();return;}
    try {res.writeHead(200,{'Content-Type':files[path][1]}); res.end(await readFile(new URL('./public/'+files[path][0],import.meta.url)));}
    catch {res.end();}
  });
  const wss = new WebSocketServer({noServer:true,maxPayload:65536});
  server.on('upgrade',(req,socket,head) => {
    const expected = origin || `http://${req.headers.host}`;
    if(req.url !== '/ws' || req.headers.origin !== expected || wss.clients.size >= maxConnections) {socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
    wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws));
  });
  const send = (ws,data) => {if(ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(data));};
  const roster = room => {for(const p of room.values()) send(p.ws,{type:'roster',members:[...room.values()].map(({id,name,muted})=>({id,name,muted})),presenter:room.presenter||null});};
  wss.on('connection', ws => {
    let member, room, key, count=0, since=Date.now();
    ws.alive=true;
    const deadline=setTimeout(()=>{if(!member) ws.close(1008,'Join timeout');},15000);
    ws.on('pong',()=>ws.alive=true);
    ws.on('message',raw=>{
      if(Date.now()-since>1000){count=0;since=Date.now();}
      if(++count>150){ws.close(1008,'Rate limit');return;}
      let m; try {m=JSON.parse(raw);}catch{ws.close(1008,'Invalid JSON');return;}
      if(!m || typeof m !== 'object')return;
      if(m.type==='join' && !member){
        if(typeof m.room!=='string'|| !/^[a-f0-9]{32}$/.test(m.room)||typeof m.name!=='string'||!m.name.trim()||m.name.length>32){send(ws,{type:'error',message:'올바른 초대 링크와 이름이 필요합니다.'});return;}
        key=m.room;room=rooms.get(key)||new Map();
        if(room.size>=10){send(ws,{type:'error',message:'방이 가득 찼습니다. 최대 10명까지 참여할 수 있어요.'});return;}
        rooms.set(key,room);member={id:randomUUID(),name:m.name.trim(),muted:true,ws};
        const peers=[...room.keys()];room.set(member.id,member);clearTimeout(deadline);
        send(ws,{type:'joined',id:member.id,peers});roster(room);return;
      }
      if(!member)return;
      if(m.type==='signal' && typeof m.to==='string' && room.has(m.to)) send(room.get(m.to).ws,{type:'signal',from:member.id,data:m.data});
      if(m.type==='mute' && typeof m.muted==='boolean'){member.muted=m.muted;roster(room);}
      if(m.type==='share-start'){
        if(room.presenter && room.presenter!==member.id)send(ws,{type:'share-denied'});
        else{room.presenter=member.id;send(ws,{type:'share-granted'});roster(room);}
      }
      if(m.type==='share-stop' && room.presenter===member.id){room.presenter=null;roster(room);}
    });
    ws.on('error',()=>{});
    ws.on('close',()=>{
      clearTimeout(deadline);
      if(!member)return;
      room.delete(member.id);if(room.presenter===member.id)room.presenter=null;
      for(const p of room.values())send(p.ws,{type:'peer-left',id:member.id});
      if(room.size)roster(room);else rooms.delete(key);
    });
  });
  const heartbeat=setInterval(()=>{for(const ws of wss.clients){if(!ws.alive)ws.terminate();else{ws.alive=false;ws.ping();}}},25000);
  return {server,rooms,close:()=>new Promise(resolve=>{clearInterval(heartbeat);for(const ws of wss.clients)ws.terminate();wss.close();server.close(resolve);})};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  let iceServers;try{iceServers=JSON.parse(process.env.ICE_SERVERS_JSON||'[]');if(!Array.isArray(iceServers))throw Error();}catch{throw Error('ICE_SERVERS_JSON must be a JSON array');}
  const app=createApp({iceServers,origin:process.env.PUBLIC_ORIGIN||''});
  const port=Number(process.env.PORT||3000);
  app.server.listen(port,process.env.HOST||'127.0.0.1',()=>console.log(`Maru Call: http://localhost:${port}`));
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>app.close().then(()=>process.exit(0)));
}
