import {randomBytes} from 'node:crypto';
import {writeFileSync,existsSync} from 'node:fs';
if(existsSync('.env')){console.log('.env already exists; not overwritten.');process.exit(0);}
const password=randomBytes(24).toString('hex');
writeFileSync('.env',`POSTGRES_PASSWORD=${password}\nDATABASE_URL=postgresql://clnup:${password}@localhost:5432/clnup\nSESSION_SECRET=${randomBytes(48).toString('hex')}\nAPP_ORIGIN=http://localhost:3000\nPORT=3000\nNODE_ENV=development\nUPLOAD_DIR=./uploads\nTRUST_PROXY=0\n`,{mode:0o600});
console.log('Created .env with random database and session secrets.');
