import {app,closeResources} from './app.js';
import {config} from './config.js';
import {db} from './db.js';
await db.$connect();
const server=app.listen(config.PORT,'0.0.0.0',()=>console.log('CLNUP listening on port '+config.PORT));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(async()=>{await closeResources();process.exit(0);}));
