import 'dotenv/config';
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {randomBytes,randomUUID} from 'node:crypto';
import sharp from 'sharp';
if(!process.env.TEST_DATABASE_URL)throw new Error('Set TEST_DATABASE_URL to an isolated migrated PostgreSQL test database.');
process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
process.env.NODE_ENV='test';
process.env.SESSION_SECRET=randomBytes(48).toString('hex');
process.env.APP_ORIGIN='http://localhost:3000';
const {app,closeResources}=await import('../src/app.js');
const {db}=await import('../src/db.js');
const run=randomUUID();
const phone=()=>'+7'+Math.floor(1000000000+Math.random()*8999999999);
const password=randomBytes(16).toString('base64url');
const ids:string[]=[];
const clients:any={};
const tokens:any={};
const image=await sharp({create:{width:32,height:32,channels:3,background:'#aa7852'}}).png().toBuffer();
let taskId:string,claimId:string,uploadId:string;
async function send(who:string,method:string,url:string,body?:any){let r=(clients[who] as any)[method](url).set('Origin','http://localhost:3000');if(method!=='get')r=r.set('X-CSRF-Token',tokens[who]);if(body)r=r.send(body);return r;}
async function register(name:string,role?:'ADMIN'|'MODERATOR'){
 clients[name]=request.agent(app);const csrf=await clients[name].get('/api/auth/csrf');assert.equal(csrf.status,200);tokens[name]=csrf.body.data.token;
 const p=phone();const response=await send(name,'post','/api/auth/register',{phone:p,firstName:name,lastName:run,password});assert.equal(response.status,201,JSON.stringify(response.body));tokens[name]=response.body.data.token;ids.push(response.body.data.user.id);if(role)await db.user.update({where:{id:response.body.data.user.id},data:{role}});return {id:response.body.data.user.id,phone:p};
}
before(async()=>{await db.$connect();await register('creator');await register('worker');await register('other');await register('moderator','MODERATOR');await register('admin','ADMIN');});
after(async()=>{
 try{const where={in:ids};await db.review.deleteMany({where:{reviewerId:where}});await db.activity.deleteMany({where:{userId:where}});await db.claim.deleteMany({where:{userId:where}});await db.task.deleteMany({where:{creatorId:where}});await db.report.deleteMany({where:{userId:where}});await db.withdrawal.deleteMany({where:{userId:where}});const files=await db.upload.findMany({where:{userId:where}});await db.upload.deleteMany({where:{userId:where}});const {unlink}=await import('node:fs/promises');const path=await import('node:path');for(const file of files)await unlink(path.resolve(process.env.UPLOAD_DIR??'./uploads',file.filename)).catch(()=>{});await db.user.deleteMany({where:{id:where}});await db.session.deleteMany({where:{OR:ids.map(id=>({sess:{path:['userId'],equals:id}}))}});await db.rateBucket.deleteMany();}finally{await closeResources();}
});
test('validation, CSRF, authentication, role isolation and strong password hashes',async()=>{
 assert.equal((await request(app).get('/api/me')).status,401);
 assert.equal((await request(app).post('/api/auth/register').send({})).status,403);
 assert.equal((await send('other','post','/api/tasks',{})).status,422);
 assert.equal((await send('other','get','/api/moderation/queue')).status,403);
 assert.equal((await send('moderator','get','/api/moderation/withdrawals')).status,403);
 const user=await db.user.findUniqueOrThrow({where:{id:ids[0]}});assert.match(user.passwordHash,/^\$argon2id\$/);assert.ok(!user.passwordHash.includes(password));
 const me=await send('worker','get','/api/me');assert.ok(!('passwordHash' in me.body.data));assert.ok(!('password' in me.body.data));
 const invalidOrigin=await clients.other.post('/api/tasks').set('Origin','https://attacker.test').set('X-CSRF-Token',tokens.other).send({});assert.equal(invalidOrigin.status,403);
});
test('upload validates file bytes, protects private files, and blocks foreign image ownership',async()=>{
 const response=await clients.worker.post('/api/uploads').set('X-CSRF-Token',tokens.worker).attach('file',image,{filename:'../../image.png',contentType:'image/png'});assert.equal(response.status,201,JSON.stringify(response.body));uploadId=response.body.data.id;
 assert.equal((await request(app).get('/api/uploads/'+uploadId)).status,404);
 const own=await send('worker','get','/api/uploads/'+uploadId);assert.equal(own.status,200);assert.match(own.headers['content-type'],/image\/jpeg/);
 const fake=await clients.worker.post('/api/uploads').set('X-CSRF-Token',tokens.worker).attach('file',Buffer.from('<script>alert(1)</script>'),{filename:'file.png',contentType:'image/png'});assert.equal(fake.status,415);
 const svg=await clients.worker.post('/api/uploads').set('X-CSRF-Token',tokens.worker).attach('file',Buffer.from('<svg/>'),{filename:'file.svg',contentType:'image/svg+xml'});assert.equal(svg.status,415);
 const invalid=await send('other','post','/api/reports',{photoId:uploadId,description:'Чужая фотография участка',address:'Тестовый адрес',category:'trash',suggestedPoints:100,clientKey:randomUUID()});assert.equal(invalid.status,422);
});
test('propose, publish, search, paginate, claim and reject self claim; idempotent repeats',async()=>{
 const data={clientKey:randomUUID(),title:'Test '+run,description:'Уборка безопасного участка '+run,location:'Тестовый адрес '+run,reward:150,category:'trash',difficulty:'easy',deadline:new Date(Date.now()+86400000).toISOString()};
 const created=await send('creator','post','/api/tasks',data);assert.equal(created.status,201,JSON.stringify(created.body));taskId=created.body.data.id;
 const again=await send('creator','post','/api/tasks',data);assert.equal(again.body.data.id,taskId);
 const unpublished=await request(app).get('/api/tasks?q='+run);assert.equal(unpublished.body.data.total,0);
 assert.equal((await send('creator','post','/api/moderation/tasks/'+taskId,{decision:'accept'})).status,403);
 const review=await send('moderator','post','/api/moderation/tasks/'+taskId,{decision:'accept'});assert.equal(review.status,200,JSON.stringify(review.body));
 const search=await request(app).get('/api/tasks?q='+run+'&category=trash&limit=1');assert.equal(search.body.data.total,1);assert.equal(search.body.data.items[0].id,taskId);
 assert.equal((await request(app).get('/api/tasks?page=0')).status,422);
 assert.equal((await send('creator','post','/api/tasks/'+taskId+'/claim')).status,409);
 const claimed=await send('worker','post','/api/tasks/'+taskId+'/claim');assert.equal(claimed.status,201);claimId=claimed.body.data.id;
 assert.equal((await send('worker','post','/api/tasks/'+taskId+'/claim')).body.data.id,claimId);
 assert.equal((await send('other','post','/api/tasks/'+taskId+'/claim')).status,409);
});
test('completion ownership, review, exactly one reward and persistence across Prisma reconnection',async()=>{
 assert.equal((await send('other','post','/api/tasks/'+taskId+'/complete',{photoId:uploadId,description:'Фотоотчёт после уборки'})).status,422);
 assert.equal((await send('worker','post','/api/tasks/'+taskId+'/complete',{description:'Нет фото'})).status,422);
 const data={photoId:uploadId,description:'Мусор собран и передан в согласованный контейнер'};
 const completed=await send('worker','post','/api/tasks/'+taskId+'/complete',data);assert.equal(completed.status,200,JSON.stringify(completed.body));
 assert.equal((await send('worker','post','/api/tasks/'+taskId+'/complete',data)).status,200);
 let me=await send('worker','get','/api/me');assert.equal(me.body.data.points,0);
 assert.equal((await send('worker','post','/api/moderation/completions/'+claimId,{decision:'accept'})).status,403);
 assert.equal((await send('moderator','post','/api/moderation/completions/'+claimId,{decision:'accept'})).status,200);
 assert.equal((await send('moderator','post','/api/moderation/completions/'+claimId,{decision:'accept'})).status,409);
 me=await send('worker','get','/api/me');assert.equal(me.body.data.points,150);assert.equal(me.body.data.tasksCompleted,1);
 await db.$disconnect();await db.$connect();assert.equal((await db.user.findUniqueOrThrow({where:{id:ids[1]}})).points,150);
 assert.equal(await db.activity.count({where:{eventKey:'reward:'+claimId}}),1);
});
test('report review is persistent, no fabricated rewards; settings and withdrawals reserve/refund once',async()=>{
 const data={photoId:uploadId,description:'Сообщение об упаковке у дорожки',address:'Тестовая дорожка',category:'trash',suggestedPoints:100,clientKey:randomUUID()};
 const report=await send('worker','post','/api/reports',data);assert.equal(report.status,201);assert.equal((await send('worker','post','/api/reports',data)).body.data.id,report.body.data.id);
 assert.equal((await send('moderator','post','/api/moderation/reports/'+report.body.data.id,{decision:'reject'})).status,422);
 assert.equal((await send('moderator','post','/api/moderation/reports/'+report.body.data.id,{decision:'accept'})).status,200);
 assert.equal((await send('worker','get','/api/me')).body.data.points,150);
 const settings={language:'en',reminders:false,verification:true,points:true};assert.equal((await send('worker','patch','/api/me/settings',settings)).status,200);assert.deepEqual((await send('worker','get','/api/me')).body.data.settings,settings);
 const withdrawal={amount:100,clientKey:randomUUID()};const w=await send('worker','post','/api/withdrawals',withdrawal);assert.equal(w.status,201,JSON.stringify(w.body));assert.equal((await send('worker','post','/api/withdrawals',withdrawal)).body.data.id,w.body.data.id);assert.equal((await send('worker','get','/api/me')).body.data.points,50);
 assert.equal((await send('worker','post','/api/withdrawals',{amount:100,clientKey:randomUUID()})).status,409);
 assert.equal((await send('other','post','/api/withdrawals/'+w.body.data.id+'/cancel')).status,404);
 assert.equal((await send('admin','post','/api/moderation/withdrawals/'+w.body.data.id,{decision:'accept'})).status,503);
 assert.equal((await send('worker','post','/api/withdrawals/'+w.body.data.id+'/cancel')).status,200);assert.equal((await send('worker','post','/api/withdrawals/'+w.body.data.id+'/cancel')).status,200);assert.equal((await send('worker','get','/api/me')).body.data.points,150);
 const rating=await request(app).get('/api/rating');assert.ok(rating.body.data.items.some((u:any)=>u.id===ids[1]&&u.points===150));assert.ok(!rating.body.data.items.some((u:any)=>'phone' in u));
});
test('login logout invalidation and durable database rate limiting',async()=>{
 const u=await db.user.findUniqueOrThrow({where:{id:ids[2]}});
 const other=request.agent(app);const c=await other.get('/api/auth/csrf');let token=c.body.data.token;
 const invalid=await other.post('/api/auth/login').set('X-CSRF-Token',token).send({phone:u.phone,password:'wrong'});assert.equal(invalid.status,401);
 const login=await other.post('/api/auth/login').set('X-CSRF-Token',token).send({phone:u.phone,password});assert.equal(login.status,200);token=login.body.data.token;
 assert.equal((await other.get('/api/me')).status,200);assert.equal((await other.post('/api/auth/logout').set('X-CSRF-Token',token)).status,200);assert.equal((await other.get('/api/me')).status,401);
 let status=0;for(let i=0;i<22;i++){const r=await clients.other.post('/api/auth/login').set('X-CSRF-Token',tokens.other).send({phone:phone(),password:'wrong'});status=r.status;if(status===429)break;}assert.equal(status,429);
});
