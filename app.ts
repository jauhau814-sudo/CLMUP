import express,{type Request,type Response,type NextFunction} from 'express';
import session from 'express-session';
import connectPg from 'connect-pg-simple';
import pg from 'pg';
import helmet from 'helmet';
import argon2 from 'argon2';
import multer from 'multer';
import sharp from 'sharp';
import path from 'node:path';
import { mkdir,writeFile,unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Prisma, type User } from '@prisma/client';
import { ZodError,z } from 'zod';
import { config } from './config.js';
import { db,atomic } from './db.js';
import { ApiError,auth,roles,csrf,csrfToken,regenerate,persistSession,loginLimit,limit } from './security.js';
import * as v from './validation.js';
export const pool=new pg.Pool({connectionString:config.DATABASE_URL,max:config.NODE_ENV==='test'?1:10});
const PgStore=connectPg(session);
export const sessionStore=new PgStore({pool,tableName:'session',createTableIfMissing:false,pruneSessionInterval:900});
export const app=express();
app.disable('x-powered-by');
if(config.TRUST_PROXY==='1')app.set('trust proxy',1);
app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'","'unsafe-inline'"],scriptSrcAttr:["'unsafe-inline'"],styleSrc:["'self'","'unsafe-inline'","https://fonts.googleapis.com"],fontSrc:["'self'","https://fonts.gstatic.com"],imgSrc:["'self'","data:","blob:",'https://*.tile.openstreetmap.org',...(config.MAP_TILE_URL?[new URL(config.MAP_TILE_URL.replace('{s}','a')).origin]:[])],connectSrc:["'self'"],upgradeInsecureRequests:config.NODE_ENV==='production'?[]:null}}}));
app.use(express.json({limit:'100kb'}));
app.use(session({name:'clnup.sid',secret:config.SESSION_SECRET,store:sessionStore,resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:'lax',secure:config.NODE_ENV==='production',maxAge:7*24*3600*1000,path:'/'}}));
app.use('/api',(_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
app.use('/api',csrf);
const ok=(res:Response,data:unknown,status=200)=>res.status(status).json({data});
const userId=(res:Response)=>(res.locals.user as User).id;
const page=(req:Request)=>{const p=v.paging.parse(req.query);return {...p,skip:(p.page-1)*p.limit};};
const taskDTO=(t:any)=>({...t,photoUrl:t.photoId?'/api/uploads/'+t.photoId:'',position:{x:50,y:50}});
async function userDTO(u:User){const [tasksCompleted,photoReports]=await Promise.all([db.claim.count({where:{userId:u.id,status:'completed'}}),db.report.count({where:{userId:u.id}})]);return {id:u.id,firstName:u.firstName,lastName:u.lastName,role:u.role,phoneNumber:u.phone,points:u.points,earnedPoints:u.earnedPoints,tasksCompleted,photoReports,settings:u.settings};}
async function ownPhoto(photoId:string|undefined,uid:string){if(!photoId)return;const image=await db.upload.findFirst({where:{id:photoId,userId:uid}});if(!image)throw new ApiError(422,'INVALID_PHOTO','Загрузи своё фото.');}
async function record(tx:Prisma.TransactionClient,uid:string,eventKey:string,description:string,points=0,type='task'){await tx.activity.create({data:{userId:uid,eventKey,description,points,type}});}
const dummyHash=await argon2.hash(randomUUID(),{type:argon2.argon2id,memoryCost:65536,timeCost:3});
app.get('/api/config',(_req,res)=>ok(res,{mapTileUrl:config.MAP_TILE_URL,mapAttribution:config.MAP_ATTRIBUTION}));
app.get('/api/health',async(_req,res)=>{await db.$queryRaw`SELECT 1`;ok(res,{status:'ok'});});
app.get('/api/auth/csrf',async(req,res)=>{const token=csrfToken(req);await persistSession(req);ok(res,{token});});
app.post('/api/auth/register',loginLimit,async(req,res)=>{
 const input=v.registration.parse(req.body);await limit('register:'+input.phone,5,900);
 const passwordHash=await argon2.hash(input.password,{type:argon2.argon2id,memoryCost:65536,timeCost:3});
 const u=await db.user.create({data:{phone:input.phone,firstName:input.firstName,lastName:input.lastName,passwordHash}});
 await regenerate(req);req.session.userId=u.id;const token=csrfToken(req);await persistSession(req);ok(res,{user:await userDTO(u),token},201);
});
app.post('/api/auth/login',loginLimit,async(req,res)=>{
 const input=v.login.parse(req.body);await limit('login-phone:'+input.phone,10,900);
 const u=await db.user.findUnique({where:{phone:input.phone}});
 const valid=await argon2.verify(u?.passwordHash??dummyHash,input.password);
 if(!u||!valid)throw new ApiError(401,'INVALID_LOGIN','Неверный телефон или пароль.');
 await regenerate(req);req.session.userId=u.id;const token=csrfToken(req);await persistSession(req);ok(res,{user:await userDTO(u),token});
});
app.post('/api/auth/logout',async(req,res)=>{await new Promise<void>((resolve,reject)=>req.session.destroy(e=>e?reject(e):resolve()));res.clearCookie('clnup.sid',{path:'/',httpOnly:true,sameSite:'lax',secure:config.NODE_ENV==='production'});ok(res,{loggedOut:true});});
app.get('/api/me',auth,async(_req,res)=>ok(res,await userDTO(res.locals.user)));
app.patch('/api/me/settings',auth,async(req,res)=>{const settings=v.settingsInput.parse(req.body);const u=await db.user.update({where:{id:userId(res)},data:{settings}});ok(res,await userDTO(u));});
app.get('/api/tasks',async(req,res)=>{
 const p=page(req);const q=typeof req.query.q==='string'?req.query.q.trim().slice(0,120):'';
 const category=req.query.category&&req.query.category!=='all'?v.category.parse(req.query.category):undefined;
 const where:Prisma.TaskWhereInput={status:'ACTIVE',deadline:{gt:new Date()},category,...(q?{OR:[{title:{contains:q,mode:'insensitive'}},{location:{contains:q,mode:'insensitive'}},{description:{contains:q,mode:'insensitive'}}]}:{})};
 const [items,total]=await db.$transaction([db.task.findMany({where,skip:p.skip,take:p.limit,orderBy:[{createdAt:'desc'},{id:'asc'}]}),db.task.count({where})]);ok(res,{items:items.map(taskDTO),total,page:p.page,limit:p.limit});
});
app.get('/api/tasks/:id',async(req,res)=>{
 const t=await db.task.findUnique({where:{id:v.id.parse(req.params.id)}});if(!t)throw new ApiError(404,'NOT_FOUND','Задание не найдено.');
 if(!['ACTIVE','CLAIMED','REVIEW','COMPLETED'].includes(t.status)){
  const uid=req.session.userId;const u=uid?await db.user.findUnique({where:{id:uid}}):null;
  if(!u||(u.id!==t.creatorId&&u.role==='MEMBER'))throw new ApiError(404,'NOT_FOUND','Задание не найдено.');
 }
 ok(res,taskDTO(t));
});
app.post('/api/tasks',auth,async(req,res)=>{
 const data=v.taskInput.parse(req.body);await ownPhoto(data.photoId,userId(res));
 const previous=await db.task.findUnique({where:{clientKey:data.clientKey}});if(previous){if(previous.creatorId!==userId(res))throw new ApiError(409,'KEY_CONFLICT','Повторный ключ запроса.');if(previous.title!==data.title||previous.description!==data.description||previous.location!==data.location||previous.reward!==data.reward||previous.category!==data.category||(previous.photoId??undefined)!==data.photoId)throw new ApiError(409,'IDEMPOTENCY_CONFLICT','Этот ключ уже использован с другими данными.');return ok(res,taskDTO(previous));}
 const result=await db.task.create({data:{...data,deadline:new Date(data.deadline),creatorId:userId(res),status:'PENDING'}});ok(res,taskDTO(result),201);
});
app.post('/api/tasks/:id/claim',auth,async(req,res)=>{
 const tid=v.id.parse(req.params.id),uid=userId(res);
 const claim=await atomic(async tx=>{
  const prior=await tx.claim.findUnique({where:{taskId:tid}});if(prior){if(prior.userId===uid)return prior;throw new ApiError(409,'CLAIMED','Задание уже выбрано другим участником.');}
  const task=await tx.task.findUnique({where:{id:tid}});if(!task)throw new ApiError(404,'NOT_FOUND','Задание не найдено.');
  if(task.creatorId===uid)throw new ApiError(409,'OWN_TASK','Нельзя принимать собственное задание.');
  if(task.status!=='ACTIVE'||task.deadline<new Date())throw new ApiError(409,'UNAVAILABLE','Задание недоступно.');
  await tx.task.update({where:{id:tid},data:{status:'CLAIMED'}});return tx.claim.create({data:{taskId:tid,userId:uid}});
 });ok(res,claim,201);
});
app.get('/api/me/claims',auth,async(req,res)=>{const p=page(req),where={userId:userId(res)};const [items,total]=await db.$transaction([db.claim.findMany({where,include:{task:true},skip:p.skip,take:p.limit,orderBy:{createdAt:'desc'}}),db.claim.count({where})]);ok(res,{items:items.map(c=>({...c,task:taskDTO(c.task)})),total,page:p.page,limit:p.limit});});
app.get('/api/me/tasks',auth,async(req,res)=>{const p=page(req),where={creatorId:userId(res)};const [items,total]=await db.$transaction([db.task.findMany({where,skip:p.skip,take:p.limit,orderBy:{createdAt:'desc'}}),db.task.count({where})]);ok(res,{items:items.map(taskDTO),total,page:p.page,limit:p.limit});});
app.post('/api/tasks/:id/complete',auth,async(req,res)=>{
 const tid=v.id.parse(req.params.id),uid=userId(res),data=v.completionInput.parse(req.body);await ownPhoto(data.photoId,uid);
 const result=await atomic(async tx=>{
  const c=await tx.claim.findUnique({where:{taskId:tid}});if(!c||c.userId!==uid)throw new ApiError(403,'FORBIDDEN','Это не твоё задание.');
  if(c.status==='review')return c;
  if(c.status!=='in_progress')throw new ApiError(409,'INVALID_STATE','Отчёт уже принят.');
  await tx.task.update({where:{id:tid},data:{status:'REVIEW'}});
  await record(tx,uid,'submitted:'+c.id+':'+randomUUID(),'Фотоотчёт отправлен на проверку',0,'submission');
  return tx.claim.update({where:{id:c.id},data:{...data,status:'review',submittedAt:new Date(),rejectionReason:null}});
 });ok(res,result);
});
app.post('/api/reports',auth,async(req,res)=>{
 const data=v.reportInput.parse(req.body),uid=userId(res);await ownPhoto(data.photoId,uid);
 const prior=await db.report.findUnique({where:{clientKey:data.clientKey}});if(prior){if(prior.userId!==uid)throw new ApiError(409,'KEY_CONFLICT','Повторный ключ.');if(prior.photoId!==data.photoId||prior.description!==data.description||prior.address!==data.address||prior.category!==data.category||prior.suggestedPoints!==data.suggestedPoints)throw new ApiError(409,'IDEMPOTENCY_CONFLICT','Этот ключ уже использован с другими данными.');return ok(res,prior);}
 const result=await atomic(async tx=>{const r=await tx.report.create({data:{...data,userId:uid}});await record(tx,uid,'report:'+r.id,'Сообщение о мусоре отправлено на проверку',0,'report');return r;});ok(res,result,201);
});
app.get('/api/me/reports',auth,async(req,res)=>{const p=page(req),where={userId:userId(res)};const [items,total]=await db.$transaction([db.report.findMany({where,skip:p.skip,take:p.limit,orderBy:{createdAt:'desc'}}),db.report.count({where})]);ok(res,{items,total,page:p.page,limit:p.limit});});
app.get('/api/me/notifications',auth,async(_req,res)=>{
 const u=res.locals.user as User,settings=u.settings as {reminders:boolean;verification:boolean;points:boolean};
 const nearing=await db.claim.findMany({where:{userId:u.id,status:'in_progress',task:{deadline:{gt:new Date(),lt:new Date(Date.now()+86400000)}}},include:{task:true}});
 if(nearing.length)await db.activity.createMany({data:nearing.map(c=>({userId:u.id,eventKey:'reminder:'+c.id,type:'reminder',description:'Срок задания скоро истекает: '+c.task.title,points:0})),skipDuplicates:true});
 const types=[...(settings.reminders?['reminder']:[]),...(settings.verification?['review']:[]),...(settings.points?['task']:[])];
 const items=await db.activity.findMany({where:{userId:u.id,createdAt:{gt:u.lastSeenAt},type:{in:types}},orderBy:{createdAt:'asc'},take:50});ok(res,{items});
});
app.post('/api/me/notifications/read',auth,async(_req,res)=>{await db.user.update({where:{id:userId(res)},data:{lastSeenAt:new Date()}});ok(res,{read:true});});
app.get('/api/me/activities',auth,async(req,res)=>{const p=page(req),where={userId:userId(res)};const [items,total]=await db.$transaction([db.activity.findMany({where,skip:p.skip,take:p.limit,orderBy:{createdAt:'desc'}}),db.activity.count({where})]);ok(res,{items,total,page:p.page,limit:p.limit});});
app.get('/api/me/withdrawals',auth,async(req,res)=>{const p=page(req),where={userId:userId(res)};const [items,total]=await db.$transaction([db.withdrawal.findMany({where,skip:p.skip,take:p.limit,orderBy:{createdAt:'desc'}}),db.withdrawal.count({where})]);ok(res,{items,total,page:p.page,limit:p.limit});});
app.post('/api/withdrawals',auth,async(req,res)=>{
 const data=v.id.parse(req.body.clientKey),amount=z.number().int().min(100).max(1000000).parse(req.body.amount),uid=userId(res);
 const result=await atomic(async tx=>{
  const old=await tx.withdrawal.findUnique({where:{clientKey:data}});if(old){if(old.userId!==uid)throw new ApiError(409,'KEY_CONFLICT','Повторный ключ.');if(old.amount!==amount)throw new ApiError(409,'IDEMPOTENCY_CONFLICT','Этот ключ уже использован с другой суммой.');return old;}
  const u=await tx.user.findUniqueOrThrow({where:{id:uid}});if(u.points<amount)throw new ApiError(409,'INSUFFICIENT_BALANCE','Недостаточно баллов.');
  await tx.user.update({where:{id:uid},data:{points:{decrement:amount}}});
  const r=await tx.withdrawal.create({data:{userId:uid,amount,clientKey:data}});await record(tx,uid,'withdrawal:'+r.id,'Баллы зарезервированы по заявке на вывод',-amount,'withdrawal');return r;
 });ok(res,result,201);
});
app.post('/api/withdrawals/:id/cancel',auth,async(req,res)=>{
 const uid=userId(res),wid=v.id.parse(req.params.id);
 const result=await atomic(async tx=>{const r=await tx.withdrawal.findUnique({where:{id:wid}});if(!r||r.userId!==uid)throw new ApiError(404,'NOT_FOUND','Заявка не найдена.');if(r.status==='CANCELLED')return r;if(r.status!=='PENDING')throw new ApiError(409,'INVALID_STATE','Заявка уже обработана.');await tx.user.update({where:{id:uid},data:{points:{increment:r.amount}}});await record(tx,uid,'refund:'+r.id,'Заявка отменена, баллы возвращены',r.amount,'refund');return tx.withdrawal.update({where:{id:wid},data:{status:'CANCELLED'}});});ok(res,result);
});
app.get('/api/rating',async(req,res)=>{
 const p=page(req),period=typeof req.query.period==='string'?req.query.period:'all';if(!['all','month','year'].includes(period))throw new ApiError(422,'VALIDATION','Неверный период.');
 const now=new Date(),since=period==='month'?new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)):period==='year'?new Date(Date.UTC(now.getUTCFullYear(),0,1)):new Date(0);
 const groups=await db.activity.groupBy({by:['userId'],where:{createdAt:{gte:since},points:{gt:0},type:{in:['task','bonus']}},_sum:{points:true},orderBy:[{_sum:{points:'desc'}},{userId:'asc'}],skip:p.skip,take:p.limit});
 const users=await db.user.findMany({where:{id:{in:groups.map(g=>g.userId)}},select:{id:true,firstName:true,lastName:true}});
 const totals=await db.activity.groupBy({by:['userId'],where:{createdAt:{gte:since},points:{gt:0},type:{in:['task','bonus']}}});
 ok(res,{items:groups.map((g,index)=>({...users.find(u=>u.id===g.userId),points:g._sum.points??0,rank:p.skip+index+1})),total:totals.length,page:p.page,limit:p.limit});
});
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:10*1024*1024,files:1},fileFilter:(_req,file,callback)=>{if(!['image/jpeg','image/png','image/webp'].includes(file.mimetype))return callback(new ApiError(415,'FILE_TYPE','Разрешены JPEG, PNG и WebP.'));callback(null,true);}});
app.post('/api/uploads',auth,async(req,_res,next)=>{await limit('upload:'+req.session.userId,60,3600);next();},upload.single('file'),async(req,res)=>{
 if(!req.file)throw new ApiError(422,'FILE_REQUIRED','Выбери фото.');
 let bytes:Buffer;
 try{const image=sharp(req.file.buffer,{limitInputPixels:20000000});const metadata=await image.metadata();if(!['jpeg','png','webp'].includes(metadata.format??''))throw new Error('format');bytes=await image.rotate().resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true}).jpeg({quality:85}).toBuffer();}
 catch{throw new ApiError(415,'INVALID_IMAGE','Файл не является допустимым изображением.');}
 const filename=randomUUID()+'.jpg';const directory=path.resolve(config.UPLOAD_DIR);await mkdir(directory,{recursive:true});await writeFile(path.join(directory,filename),bytes,{flag:'wx',mode:0o600});
 try{const file=await db.upload.create({data:{userId:userId(res),filename,size:bytes.length}});ok(res,{id:file.id,url:'/api/uploads/'+file.id},201);}catch(error){await unlink(path.join(directory,filename));throw error;}
});
app.get('/api/uploads/:id',async(req,res)=>{
 const file=await db.upload.findUnique({where:{id:v.id.parse(req.params.id)}});if(!file)throw new ApiError(404,'NOT_FOUND','Фото не найдено.');
 const published=await db.task.count({where:{photoId:file.id,status:{in:['ACTIVE','CLAIMED','REVIEW','COMPLETED']}}});
 if(!published){const uid=req.session.userId,u=uid?await db.user.findUnique({where:{id:uid}}):null;if(!u||(u.id!==file.userId&&u.role==='MEMBER'))throw new ApiError(404,'NOT_FOUND','Фото не найдено.');}
 res.setHeader('Content-Type','image/jpeg');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Disposition','inline; filename="photo.jpg"');res.sendFile(path.resolve(config.UPLOAD_DIR,file.filename));
});
app.use('/api/moderation',auth,roles('MODERATOR','ADMIN'));
app.get('/api/moderation/queue',async(req,res)=>{
 const p=page(req);const [tasks,completions,reports]=await Promise.all([db.task.findMany({where:{status:'PENDING'},take:p.limit,skip:p.skip,orderBy:{createdAt:'asc'}}),db.claim.findMany({where:{status:'review'},include:{task:true},take:p.limit,skip:p.skip,orderBy:{submittedAt:'asc'}}),db.report.findMany({where:{status:'PENDING'},take:p.limit,skip:p.skip,orderBy:{createdAt:'asc'}})]);const [tasksTotal,completionsTotal,reportsTotal]=await Promise.all([db.task.count({where:{status:'PENDING'}}),db.claim.count({where:{status:'review'}}),db.report.count({where:{status:'PENDING'}})]);ok(res,{tasks:tasks.map(taskDTO),completions,reports,totals:{tasks:tasksTotal,completions:completionsTotal,reports:reportsTotal},page:p.page,limit:p.limit});
});
app.post('/api/moderation/tasks/:id',async(req,res)=>{
 const tid=v.id.parse(req.params.id),uid=userId(res),input=v.reviewInput.parse(req.body);
 const result=await atomic(async tx=>{const t=await tx.task.findUnique({where:{id:tid}});if(!t)throw new ApiError(404,'NOT_FOUND','Задание не найдено.');if(t.creatorId===uid)throw new ApiError(403,'SELF_REVIEW','Нельзя проверять своё задание.');if(t.status!=='PENDING')throw new ApiError(409,'INVALID_STATE','Задание уже обработано.');await tx.review.create({data:{reviewerId:uid,taskId:tid,action:input.decision,reason:input.reason}});if(t.creatorId)await record(tx,t.creatorId,'task-reviewed:'+tid,'Задание '+(input.decision==='accept'?'опубликовано':'отклонено: '+input.reason),0,'review');return tx.task.update({where:{id:tid},data:{status:input.decision==='accept'?'ACTIVE':'REJECTED',rejectionReason:input.reason}});});ok(res,taskDTO(result));
});
app.post('/api/moderation/completions/:id',async(req,res)=>{
 const cid=v.id.parse(req.params.id),uid=userId(res),input=v.reviewInput.parse(req.body);
 const result=await atomic(async tx=>{
  const c=await tx.claim.findUnique({where:{id:cid},include:{task:true}});if(!c)throw new ApiError(404,'NOT_FOUND','Отчёт не найден.');if(c.userId===uid||c.task.creatorId===uid)throw new ApiError(403,'SELF_REVIEW','Нельзя проверять собственную работу или своё задание.');if(c.status!=='review')throw new ApiError(409,'INVALID_STATE','Отчёт уже обработан.');
  await tx.review.create({data:{reviewerId:uid,taskId:c.taskId,action:input.decision,reason:input.reason}});
  if(input.decision==='accept'){await tx.user.update({where:{id:c.userId},data:{points:{increment:c.task.reward},earnedPoints:{increment:c.task.reward}}});await record(tx,c.userId,'reward:'+c.id,'Принята уборка: '+c.task.title,c.task.reward);}
  else await record(tx,c.userId,'returned:'+c.id+':'+randomUUID(),'Отчёт возвращён: '+input.reason,0,'review');
  await tx.task.update({where:{id:c.taskId},data:{status:input.decision==='accept'?'COMPLETED':'CLAIMED'}});
  return tx.claim.update({where:{id:cid},data:{status:input.decision==='accept'?'completed':'in_progress',completedAt:input.decision==='accept'?new Date():null,rejectionReason:input.reason}});
 });ok(res,result);
});
app.post('/api/moderation/reports/:id',async(req,res)=>{
 const rid=v.id.parse(req.params.id),uid=userId(res),input=v.reviewInput.parse(req.body);
 const result=await atomic(async tx=>{const r=await tx.report.findUnique({where:{id:rid}});if(!r)throw new ApiError(404,'NOT_FOUND','Сообщение не найдено.');if(r.userId===uid)throw new ApiError(403,'SELF_REVIEW','Нельзя проверять своё сообщение.');if(r.status!=='PENDING')throw new ApiError(409,'INVALID_STATE','Сообщение уже обработано.');await tx.review.create({data:{reviewerId:uid,reportId:rid,action:input.decision,reason:input.reason}});await record(tx,r.userId,'report-reviewed:'+rid,'Сообщение '+(input.decision==='accept'?'принято':'отклонено: '+input.reason),0,'review');return tx.report.update({where:{id:rid},data:{status:input.decision==='accept'?'ACCEPTED':'REJECTED',rejectionReason:input.reason}});});ok(res,result);
});
app.get('/api/moderation/withdrawals',auth,roles('ADMIN'),async(req,res)=>{
 const p=page(req),where={status:'PENDING' as const};
 const [items,total]=await db.$transaction([db.withdrawal.findMany({where,skip:p.skip,take:p.limit,orderBy:{createdAt:'asc'}}),db.withdrawal.count({where})]);ok(res,{items,total,page:p.page,limit:p.limit});
});
app.post('/api/moderation/withdrawals/:id',auth,roles('ADMIN'),async(req,res)=>{
 const wid=v.id.parse(req.params.id),input=v.reviewInput.parse(req.body);
 if(input.decision!=='reject')throw new ApiError(503,'PAYOUT_NOT_CONFIGURED','Платёжный провайдер не подключён. Выплата не выполнена.');
 const result=await atomic(async tx=>{const r=await tx.withdrawal.findUnique({where:{id:wid}});if(!r)throw new ApiError(404,'NOT_FOUND','Заявка не найдена.');if(r.status!=='PENDING')throw new ApiError(409,'INVALID_STATE','Заявка уже обработана.');await tx.user.update({where:{id:r.userId},data:{points:{increment:r.amount}}});await record(tx,r.userId,'refund:'+r.id,'Отказ в заявке на вывод: '+input.reason,r.amount,'refund');return tx.withdrawal.update({where:{id:wid},data:{status:'REJECTED'}});});ok(res,result);
});
app.use('/api',(_req,_res)=>{throw new ApiError(404,'NOT_FOUND','Маршрут не найден.');});
app.use(express.static(path.resolve('public'),{index:'index.html'}));
app.use((error:unknown,req:Request,res:Response,_next:NextFunction)=>{
 if(res.headersSent)return;
 let status=500,code='INTERNAL',message='Не удалось выполнить запрос. Повтори позже.';let details:unknown;
 if(error instanceof ApiError){status=error.status;code=error.code;message=error.message;}
 else if(error instanceof ZodError){status=422;code='VALIDATION';message='Проверь поля формы.';details=error.issues.map(i=>({field:i.path.join('.'),message:i.message}));}
 else if(error instanceof multer.MulterError){status=error.code==='LIMIT_FILE_SIZE'?413:422;code='UPLOAD';message='Фото должно быть до 10 МБ, один файл за запрос.';}
 else if(error instanceof Prisma.PrismaClientKnownRequestError && ['P2002','P2034'].includes(error.code)){status=409;code='CONFLICT';message='Запись уже существует или была изменена. Обнови данные.';}
 else if(error && typeof error==='object' && 'type' in error && error.type==='entity.too.large'){status=413;code='BODY_SIZE';message='Запрос слишком большой.';}
 else if(error instanceof SyntaxError && 'body' in error){status=400;code='JSON';message='Некорректный JSON.';}
 else console.error('request_failed',{method:req.method,route:req.path,errorType:error instanceof Error?error.name:'Unknown'});
 res.status(status).json({error:{code,message,...(details?{details}:{})}});
});
export async function closeResources(){sessionStore.close();await pool.end();await db.$disconnect();}
