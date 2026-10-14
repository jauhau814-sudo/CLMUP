import {execFileSync} from 'node:child_process';
const invoke=args=>execFileSync('docker',['compose',...args],{stdio:'inherit'});
const exists=execFileSync('docker',['compose','exec','-T','db','psql','-U','clnup','-d','postgres','-tAc',"SELECT 1 FROM pg_database WHERE datname='clnup_test'"],{encoding:'utf8'}).trim();
if(!exists)invoke(['exec','-T','db','createdb','-U','clnup','clnup_test']);
invoke(['exec','-T','app','sh','-c','export DATABASE_URL="${DATABASE_URL%/clnup}/clnup_test"; export TEST_DATABASE_URL="$DATABASE_URL"; npm run db:migrate && npm test']);
