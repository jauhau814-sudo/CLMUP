import 'dotenv/config';
import { z } from 'zod';
const result = z.object({
 DATABASE_URL:z.string().url(),
 SESSION_SECRET:z.string().min(48),
 APP_ORIGIN:z.string().url().default('http://localhost:3000'),
 NODE_ENV:z.enum(['development','test','production']).default('development'),
 PORT:z.coerce.number().int().min(1).max(65535).default(3000),
 UPLOAD_DIR:z.string().default('./uploads'),
 MAP_TILE_URL:z.string().default('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'),
 MAP_ATTRIBUTION:z.string().default('© OpenStreetMap contributors'),
 TRUST_PROXY:z.enum(['0','1']).default('0')
}).safeParse(process.env);
if (!result.success) throw new Error('Invalid configuration: '+result.error.issues.map(i=>i.path.join('.')).join(', '));
export const config=result.data;
if(config.NODE_ENV==='production' && !config.APP_ORIGIN.startsWith('https://')) throw new Error('Production requires HTTPS APP_ORIGIN');

if(config.MAP_TILE_URL && !config.MAP_TILE_URL.startsWith("https://")) throw new Error("MAP_TILE_URL must use HTTPS or be empty");
