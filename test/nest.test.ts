import 'reflect-metadata';
import { Body, Controller, Get, HttpException, Inject, Module, Param, Post, UseGuards, type CanActivate, type INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RadarExceptionFilter, RadarModule, RadarService } from '../src/nest/index.js';
import type { ErrorEvent, LogEvent } from '../src/protocol/index.js';
import { radar } from '../src/radar.js';
import { startFakeIngest, type FakeIngest } from './helpers/fake-ingest.js';

class ExplodingGuard implements CanActivate {
  canActivate(): boolean {
    throw new Error('guard exploded');
  }
}

@Controller('stores')
class StoresController {
  constructor(@Inject(RadarService) private readonly radarService: RadarService) {}

  @Post(':storeId/leads')
  receive(@Param('storeId') storeId: string, @Body() _body: unknown) {
    radar.logRequest('Lead recebido', { storeId });
    this.radarService.info('lead.saved', { storeId });
    return { ok: true };
  }

  @Get('boom')
  boom(): never {
    throw new Error('service exploded');
  }

  @Get('missing')
  missing(): never {
    throw new HttpException('not here', 404);
  }

  @Get('guarded')
  @UseGuards(ExplodingGuard)
  guarded() {
    return { ok: true };
  }
}

@Module({
  imports: [
    RadarModule.forRootAsync({
      useFactory: () => ({ key: 'rk_test', endpoint: process.env.TEST_RADAR_ENDPOINT, environment: 'test', captureUnhandled: false }),
    }),
  ],
  controllers: [StoresController],
  providers: [{ provide: APP_FILTER, useClass: RadarExceptionFilter }],
})
class AppModule {}

let server: FakeIngest;
let app: INestApplication;

beforeAll(async () => {
  server = await startFakeIngest();
  process.env.TEST_RADAR_ENDPOINT = server.url;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
});

afterAll(async () => {
  await app.close();
  await server.close();
});

const logs = () => server.events().filter((event): event is LogEvent => event.type === 'log');
const errors = () => server.events().filter((event): event is ErrorEvent => event.type === 'error');

describe('RadarModule', () => {
  it('shares one requestId across the automatic log, logRequest and the service', async () => {
    await request(app.getHttpServer()).post('/stores/42/leads').set('x-request-id', 'nest-1').send({ name: 'Ana' }).expect(201);
    await vi.waitFor(async () => {
      await radar.flush();
      expect(logs().filter((event) => event.requestId === 'nest-1')).toHaveLength(3);
    });
    const byMessage = Object.fromEntries(logs().filter((event) => event.requestId === 'nest-1').map((event) => [event.message, event]));
    expect(byMessage['Lead recebido']!.request).toMatchObject({
      method: 'POST',
      route: '/stores/:storeId/leads',
      params: { storeId: '42' },
      body: { name: 'Ana' },
    });
    expect(byMessage['lead.saved']!.attrs).toEqual({ storeId: '42' });
    expect(byMessage['http.request']!.attrs).toMatchObject({ method: 'POST', route: '/stores/:storeId/leads', status: 201 });
  });

  it('captures 5xx once even with the filter, skips 4xx HttpException and catches guard errors', async () => {
    await request(app.getHttpServer()).get('/stores/boom').set('x-request-id', 'nest-2').expect(500);
    await request(app.getHttpServer()).get('/stores/missing').expect(404);
    await request(app.getHttpServer()).get('/stores/guarded').expect(500);
    await vi.waitFor(async () => {
      await radar.flush();
      expect(errors()).toHaveLength(2);
    });
    expect(errors().map((event) => event.exception.message).sort()).toEqual(['guard exploded', 'service exploded']);
    expect(errors().find((event) => event.exception.message === 'service exploded')).toMatchObject({
      requestId: 'nest-2',
      request: { method: 'GET', route: '/stores/boom' },
    });
  });

  it('exposes RadarService for injection', () => {
    expect(app.get(RadarService)).toBeInstanceOf(RadarService);
  });
});
