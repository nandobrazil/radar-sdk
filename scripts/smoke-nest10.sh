#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$ROOT"
npm run build >/dev/null
TARBALL="$ROOT/$(npm pack --silent)"

cd "$WORK"
npm init -y >/dev/null
npm install --silent --no-audit --no-fund "$TARBALL" @nestjs/common@10 @nestjs/core@10 @nestjs/platform-express@10 reflect-metadata rxjs typescript@5.1 @types/node@20 >/dev/null

cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "module": "commonjs",
    "moduleResolution": "node",
    "target": "ES2021",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": false,
    "outDir": "dist"
  },
  "include": ["main.ts"]
}
JSON

cat > main.ts <<'TS'
import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { radar } from '@oconde/radar';
import { RadarModule, RadarService } from '@oconde/radar/nest';

@Controller()
class PingController {
  constructor(private readonly radarService: RadarService) {}

  @Get('ping')
  ping() {
    this.radarService.info('ping');
    radar.logRequest('ping request');
    return { ok: true };
  }
}

@Module({ imports: [RadarModule.forRoot({ captureUnhandled: false })], controllers: [PingController] })
class AppModule {}

async function main() {
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  const address = app.getHttpServer().address();
  const response = await fetch(`http://127.0.0.1:${address.port}/ping`);
  const requestId = response.headers.get('x-request-id');
  await app.close();
  if (response.status !== 200 || !requestId) {
    console.error('smoke failed', response.status, requestId);
    process.exit(1);
  }
  console.log('smoke ok', requestId);
}

void main();
TS

npx tsc -p tsconfig.json
node dist/main.js
rm -f "$TARBALL"
