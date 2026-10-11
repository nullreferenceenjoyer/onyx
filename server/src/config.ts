import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.PORT ?? 8081),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://onyx:onyx@localhost:5432/onyx',
  // браузеры ограничивают срок жизни cookie 400 днями
  sessionDays: Math.min(400, Number(process.env.SESSION_DAYS ?? 365)),
  allowRegistration: (process.env.ALLOW_REGISTRATION ?? 'true') !== 'false',
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB ?? 50),
  staticDir: process.env.STATIC_DIR ?? path.resolve(here, '../../client/dist'),
};
