import { randomBytes,timingSafeEqual,createHash } from 'node:crypto';
import type { Request,Response,NextFunction } from 'express';
import type { Role } from '@prisma/client';
import { db } from './db.js';
import { config } from './config.js';
declare module 'express-session' { interface SessionData { userId?:string; csrf?:string } }
export class ApiError extends Error {constructor(public status:number,public code:string,message:string){super(message);}}
export function csrfToken(req:Request){return req.session.csrf ??= randomBytes(32).toString('hex');}
export function csrf(req:Request,_res:Response,next:NextFunction){
 if(['GET','HEAD','OPTIONS'].includes(req.method)) return next();
 const token=req.get('x-csrf-token')??'';const expected=req.session.csrf??'';
 const origin=req.get('origin');
 if((origin && origin!==config.APP_ORIGIN) || !expected || !/^[a-f0-9]{64}$/.test(token) || token.length!==expected.length || !timingSafeEqual(Buffer.from(token),Buffer.from(expected))) throw new ApiError(403,'CSRF','Обнови страницу и повтори действие.');
 next();
}
export async function auth(req:Request,res:Response,next:NextFunction){
 if(!req.session.userId)throw new ApiError(401,'AUTH_REQUIRED','Войди в аккаунт.');
 const user=await db.user.findUnique({where:{id:req.session.userId}});
 if(!user)throw new ApiError(401,'AUTH_REQUIRED','Сессия недействительна.');
 res.locals.user=user;next();
}
export function roles(...allowed:Role[]){return (_req:Request,res:Response,next:NextFunction)=>{if(!allowed.includes(res.locals.user.role))throw new ApiError(403,'FORBIDDEN','Недостаточно прав.');next();};}
export async function limit(key:string,max:number,seconds:number){
 const bucket=Math.floor(Date.now()/(seconds*1000));
 const digest=createHash('sha256').update(key).digest('hex');
 const count=await db.rateBucket.upsert({where:{key:digest+':'+bucket},create:{key:digest+':'+bucket,count:1,expiresAt:new Date((bucket+1)*seconds*1000)},update:{count:{increment:1}}});
 if(count.count>max)throw new ApiError(429,'RATE_LIMIT','Слишком много попыток. Повтори позже.');
}
export async function loginLimit(req:Request,_res:Response,next:NextFunction){await limit('auth:'+req.ip,20,900);next();}
export function regenerate(req:Request){return new Promise<void>((resolve,reject)=>req.session.regenerate(e=>e?reject(e):resolve()));}
export function persistSession(req:Request){return new Promise<void>((resolve,reject)=>req.session.save(e=>e?reject(e):resolve()));}
