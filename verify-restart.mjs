import 'dotenv/config';
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {PrismaClient} from '@prisma/client';
if(!process.env.TEST_DATABASE_URL)throw Error('Use an isolated TEST_DATABASE_URL.');
const origin='http://127.0.0.1:31991';
const env={...process.env,DATABASE_URL:process.env.TEST_DATABASE_URL,APP_ORIGIN:origin,PORT:'31991',NODE_ENV:'test',SESSION_SECRET:randomBytes(48).toString('hex')};
let server,cookie='',token,uid;
async function start(){server=spawn(process.execPath,['dist/index.js'],{env,stdio:['ignore','pipe','inherit']});server.stdout.on('data',()=>{});for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error('Server exited before becoming healthy.');try{const r=await fetch(origin+'/api/health');if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('Server did not start.');}
async function stop(){if(!server||server.exitCode!==null)return;await new Promise(resolve=>{server.once('exit',resolve);server.kill('SIGTERM');});}
async function api(route,body){const r=await fetch(origin+'/api'+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','Origin':origin,'Cookie':cookie,...(body?{'X-CSRF-Token':token}:{})},body:body?JSON.stringify(body):undefined});for(const raw of r.headers.getSetCookie()){if(raw.startsWith('clnup.sid='))cookie=raw.split(';')[0];}const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return data.data;}
const db=new PrismaClient({datasourceUrl:process.env.TEST_DATABASE_URL});
try{await start();token=(await api('/auth/csrf')).token;const phone='+7'+String(Math.floor(1000000000+Math.random()*8999999999));const auth=await api('/auth/register',{phone,firstName:'Restart',lastName:randomUUID(),password:randomBytes(16).toString('base64url')});token=auth.token;uid=auth.user.id;const task=await api('/tasks',{clientKey:randomUUID(),title:'Persistence check',description:'Safe test cleanup task for checking persistence.',location:'Test location',reward:100,category:'trash',difficulty:'easy',deadline:new Date(Date.now()+86400000).toISOString()});await stop();await start();const me=await api('/me');assert.equal(me.id,uid);const tasks=await api('/me/tasks');assert.ok(tasks.items.some(t=>t.id===task.id));console.log('PASS: actual Node server process restart preserves HttpOnly session and task records.');}
finally{await stop();if(uid){await db.task.deleteMany({where:{creatorId:uid}});await db.user.delete({where:{id:uid}});}await db.$disconnect();}
