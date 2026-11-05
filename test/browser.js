import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createApp } from '../server.js';
const app=createApp();await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${app.server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required']});
const errors=[];
try{
  const context=await browser.newContext({permissions:['microphone','clipboard-write'],viewport:{width:1440,height:1000}});
  context.setDefaultTimeout(10000);
  // Observe real RTCPeerConnections; no replacement of the WebRTC/media transport.
  await context.addInitScript(()=>{window.testPCs=[];const Real=window.RTCPeerConnection;window.RTCPeerConnection=class extends Real{constructor(...args){super(...args);window.testPCs.push(this);}};});
  const a=await context.newPage(), b=await context.newPage();
  for(const page of [a,b])page.on('pageerror',e=>errors.push(e.message));
  await a.goto(url);await mkdir('test-results',{recursive:true});await a.screenshot({path:'test-results/lobby.png',fullPage:true});
  await a.locator('#name').fill('하늘');await a.locator('#join').click();await a.locator('#call').waitFor({state:'visible'});
  await b.goto(a.url());await b.locator('#name').fill('바다');await b.locator('#join').click();await b.locator('#call').waitFor({state:'visible'});
  const skipMedia=process.env.SKIP_MEDIA_TESTS==='1';
  for(const page of [a,b])await page.waitForFunction(()=>window.testPCs.some(p=>p.signalingState==='stable'&&p.localDescription&&p.remoteDescription));
  if(!skipMedia)for(const page of [a,b])await page.waitForFunction(()=>window.testPCs.some(p=>p.connectionState==='connected'));
  await a.locator('#mute').click();await b.waitForFunction(()=>document.querySelector('#members').textContent.includes('마이크 켜짐'));
  if(!skipMedia)await b.waitForFunction(async()=>{const s=await window.testPCs[0].getStats();return [...s.values()].some(x=>x.type==='inbound-rtp'&&x.kind==='audio'&&x.bytesReceived>0);});
  // Synthetic canvas replaces only the OS picker. Captured video goes over real WebRTC.
  await a.evaluate(()=>{navigator.mediaDevices.getDisplayMedia=async()=>{const c=document.createElement('canvas');c.width=640;c.height=360;const ctx=c.getContext('2d');window.paintTimer=setInterval(()=>{ctx.fillStyle='#698b59';ctx.fillRect(0,0,640,360);ctx.fillStyle='white';ctx.font='30px sans-serif';ctx.fillText('Screen sharing '+Date.now(),20,120);},100);return c.captureStream(10);};});
  await a.locator('#share').click();await b.locator('#screen').waitFor({state:'visible'});if(!skipMedia)await b.waitForFunction(()=>document.querySelector('#screen').videoWidth>0);
  if(!skipMedia)await b.waitForFunction(async()=>{const s=await window.testPCs[0].getStats();return [...s.values()].some(x=>x.type==='inbound-rtp'&&x.kind==='video'&&x.framesDecoded>0);});
  assert.equal(await b.locator('#share').isDisabled(),true);
  await b.screenshot({path:'test-results/call-screen.png',fullPage:true});
  await a.locator('#share').click();await b.locator('#screen').waitFor({state:'hidden'});
  await a.locator('#share').click();await b.locator('#screen').waitFor({state:'visible'});if(!skipMedia)await b.waitForFunction(()=>document.querySelector('#screen').videoWidth>0);
  // A late joiner must receive an existing screen share.
  const c=await context.newPage();c.on('pageerror',e=>errors.push(e.message));await c.goto(a.url());await c.locator('#name').fill('나무');await c.locator('#join').click();await c.locator('#screen').waitFor({state:'visible'});if(!skipMedia)await c.waitForFunction(()=>document.querySelector('#screen').videoWidth>0);
  await a.locator('#leave').click();await b.locator('#screen').waitFor({state:'hidden'});await b.waitForFunction(()=>document.querySelector('#count').textContent==='2 / 10');
  await b.locator('#leave').click();await c.locator('#leave').click();
  // Permission denial leaves the form usable.
  await b.evaluate(()=>navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Denied','NotAllowedError');});await b.locator('#join').click();await b.waitForFunction(()=>document.querySelector('#status').textContent.includes('허용'));assert.equal(await b.locator('#join').isEnabled(),true);
  await a.setViewportSize({width:390,height:844});await a.screenshot({path:'test-results/mobile.png',fullPage:true});
  assert.deepEqual(errors,[]);console.log('PASS: signaling; mute; screen lifecycle; late join; leave cleanup; permission denial; desktop/mobile screenshots.');console.log(skipMedia?'SKIPPED: media transport and decoded frames (managed WebRTC policy).':'PASS: real audio RTP and screen RTP/decoded frames.');
}finally{await browser.close();await app.close();}
