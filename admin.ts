import 'dotenv/config';
import {PrismaClient} from '@prisma/client';
import argon2 from 'argon2';
import {randomBytes} from 'node:crypto';
import {phone} from '../src/validation.js';
const db=new PrismaClient();
const number=phone.parse(process.argv[2]);
const role=process.argv[3]==='MODERATOR'?'MODERATOR':'ADMIN';
const password=randomBytes(18).toString('base64url');
try{
 const exists=await db.user.findUnique({where:{phone:number}});
 if(exists)throw Error('Account exists. To prevent silent privilege escalation, use a new phone.');
 await db.user.create({data:{phone:number,firstName:'Модератор',lastName:'CLNUP',role,passwordHash:await argon2.hash(password,{type:argon2.argon2id,memoryCost:65536,timeCost:3})}});
 console.log('Created '+role+'. Phone: '+number+'\nOne-time generated password (save securely): '+password);
}finally{await db.$disconnect();}
