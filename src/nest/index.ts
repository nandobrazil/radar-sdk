import { createRequire } from 'node:module';
import {
  Catch,
  Global,
  HttpException,
  Inject,
  Injectable,
  Module,
  RequestMethod,
  type ArgumentsHost,
  type CallHandler,
  type DynamicModule,
  type ExecutionContext,
  type FactoryProvider,
  type MiddlewareConsumer,
  type ModuleMetadata,
  type NestInterceptor,
  type NestModule,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import { APP_INTERCEPTOR, BaseExceptionFilter } from '@nestjs/core';
import { catchError, throwError, type Observable } from 'rxjs';
import type { Attributes, LogRequestOptions } from '../client.js';
import { currentContext, type RequestLike } from '../context.js';
import type { RadarOptions } from '../options.js';
import type { UserInfo } from '../protocol/index.js';
import { radar } from '../radar.js';

export const RADAR_OPTIONS = Symbol.for('@oconde/radar/options');

export type RadarModuleAsyncOptions = {
  imports?: ModuleMetadata['imports'];
  inject?: FactoryProvider['inject'];
  useFactory: (...args: never[]) => RadarOptions | Promise<RadarOptions>;
};

export function shouldCapture(error: unknown): boolean {
  return !(error instanceof HttpException) || error.getStatus() >= 500;
}

@Injectable()
export class RadarInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      const request = context.switchToHttp().getRequest<RequestLike>();
      const store = currentContext();
      const route = request?.route?.path;
      if (store && typeof route === 'string') store.route = route;
    }
    return next.handle().pipe(
      catchError((error: unknown) => {
        if (shouldCapture(error)) radar.captureError(error);
        return throwError(() => error);
      }),
    );
  }
}

@Injectable()
export class RadarService {
  debug(message: string, data?: Attributes): void {
    radar.debug(message, data);
  }

  info(message: string, data?: Attributes): void {
    radar.info(message, data);
  }

  warn(message: string, data?: Attributes): void {
    radar.warn(message, data);
  }

  error(message: string, data?: Attributes): void {
    radar.error(message, data);
  }

  logRequest(title: string, data?: Attributes, options?: LogRequestOptions): void {
    radar.logRequest(title, data, options);
  }

  captureError(error: unknown, data?: Attributes): void {
    radar.captureError(error, data);
  }

  setUser(user: UserInfo): void {
    radar.setUser(user);
  }

  track<T>(name: string, fn: () => T | Promise<T>, data?: Attributes): Promise<T> {
    return radar.track(name, fn, data);
  }

  flush(timeoutMs?: number): Promise<void> {
    return radar.flush(timeoutMs);
  }
}

@Catch()
export class RadarExceptionFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    if (shouldCapture(exception)) radar.captureError(exception);
    super.catch(exception, host);
  }
}

function nestMajorVersion(): number {
  try {
    const load = createRequire(import.meta.url);
    const { version } = load('@nestjs/core/package.json') as { version: string };
    return Number.parseInt(version, 10);
  } catch {
    return 11;
  }
}

const ALL_ROUTES = { path: nestMajorVersion() >= 11 ? '{*path}' : '*', method: RequestMethod.ALL };

@Global()
@Module({})
export class RadarModule implements NestModule, OnApplicationShutdown {
  constructor(@Inject(RADAR_OPTIONS) readonly options: RadarOptions) {}

  static forRoot(options: RadarOptions = {}): DynamicModule {
    return RadarModule.create(
      [
        {
          provide: RADAR_OPTIONS,
          useFactory: () => {
            radar.init(options);
            return options;
          },
        },
      ],
      [],
    );
  }

  static forRootAsync(options: RadarModuleAsyncOptions): DynamicModule {
    const factory = options.useFactory as (...args: unknown[]) => RadarOptions | Promise<RadarOptions>;
    return RadarModule.create(
      [
        {
          provide: RADAR_OPTIONS,
          inject: options.inject ?? [],
          useFactory: async (...args: unknown[]) => {
            const resolved = await factory(...args);
            radar.init(resolved);
            return resolved;
          },
        },
      ],
      options.imports ?? [],
    );
  }

  private static create(providers: Provider[], imports: NonNullable<ModuleMetadata['imports']>): DynamicModule {
    return {
      module: RadarModule,
      global: true,
      imports,
      providers: [...providers, RadarService, { provide: APP_INTERCEPTOR, useClass: RadarInterceptor }],
      exports: [RadarService, RADAR_OPTIONS],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(radar.middleware()).forRoutes(ALL_ROUTES);
  }

  async onApplicationShutdown(): Promise<void> {
    await radar.close();
  }
}
