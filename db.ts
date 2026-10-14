import { PrismaClient, Prisma } from '@prisma/client';
export const db=new PrismaClient();
export async function atomic<T>(work:(tx:Prisma.TransactionClient)=>Promise<T>):Promise<T>{
 for(let attempt=0;attempt<4;attempt++){
  try{return await db.$transaction(work,{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});}
  catch(error){if(error instanceof Prisma.PrismaClientKnownRequestError && error.code==='P2034' && attempt<3) continue;throw error;}
 }
 throw new Error('Transaction retry exhausted');
}
