# @oconde/radar

SDK do [Radar](https://radar.oconde.dev) para Node.js e NestJS: logs, erros com trecho de código e contexto de requisição. Sem dependências em runtime.

## Instalação

```bash
npm install @oconde/radar
```

Node 20 ou mais novo. Funciona em ESM e CommonJS, do NestJS 10 em diante.

## NestJS

```ts
import { Module } from '@nestjs/common';
import { RadarModule } from '@oconde/radar/nest';

@Module({
  imports: [RadarModule.forRoot({ key: process.env.RADAR_KEY, release: process.env.GIT_SHA })],
})
export class AppModule {}
```

Com `ConfigService`:

```ts
RadarModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({ key: config.get('RADAR_KEY') }),
});
```

O módulo registra sozinho o contexto por requisição, um log `http.request` por requisição e a captura dos erros 5xx lançados nos handlers. Chame `app.enableShutdownHooks()` para o Radar enviar a fila ao desligar.

Nos services, nada precisa ser injetado:

```ts
import { radar } from '@oconde/radar';

radar.info('webhook.olx.lead', { leadId });
```

Quem prefere injeção usa `RadarService`, que tem os mesmos métodos.

Erros lançados em guards e pipes não passam pelo interceptor. Se o app não tem filtro de exceção próprio, registre o do Radar:

```ts
import { APP_FILTER } from '@nestjs/core';
import { RadarExceptionFilter } from '@oconde/radar/nest';

providers: [{ provide: APP_FILTER, useClass: RadarExceptionFilter }];
```

Se já tem, acrescente no `catch` dele: `if (status >= 500) radar.captureError(exception)`. O mesmo erro nunca é enviado duas vezes.

## Express

```ts
import { radar } from '@oconde/radar';

radar.init({ key: process.env.RADAR_KEY });
app.use(radar.middleware());
```

## API

| Função | O que faz |
|---|---|
| `radar.init(options)` | configura uma vez; chamadas seguintes são ignoradas |
| `radar.debug/info/warn/error(message, data?)` | log com `data` como atributos; dentro de uma requisição sai com o `requestId` e o usuário |
| `radar.logRequest(title, data?, { level?, redact? }?)` | log com a requisição atual inteira: método, URL, rota, params, query, headers, body, IP |
| `radar.captureError(error, data?)` | erro com stack, trecho de código, requisição, usuário e runtime |
| `radar.setUser({ id, email, name })` | usuário da requisição atual |
| `radar.track(name, fn, data?)` | mede `fn`, registra sucesso ou falha com `durationMs`, captura e relança o erro |
| `radar.middleware()` | middleware Express de contexto (`x-request-id`) |
| `radar.flush(timeoutMs?)` / `radar.close(timeoutMs?)` | envia a fila; `close` também desliga |
| `radar.settings` | opções em uso (só leitura); `radar.settings.console` diz se o Radar já imprime no stdout, útil para um logger próprio não duplicar linhas |

Mensagens de log são chaves estáveis (`webhook.olx.lead`); o que varia vai em `data`.

## Opções

| Opção | Padrão | |
|---|---|---|
| `key` | — | sem chave nada é enviado |
| `endpoint` | `https://radar-ingest.oconde.dev` | |
| `environment` | `NODE_ENV` ou `production` | |
| `release` | — | ex.: o SHA do commit |
| `console` | `false` | imprime cada log como JSON no stdout, mesmo sem chave |
| `minLevel` | `info` | |
| `redact` | `mask` | `none` guarda tokens e senhas inteiros |
| `requestDetail` | `full` | `route` manda da requisição só o método e a rota (`/students/:studentId`), com status e duração: sem URL concreta, query, params, headers, corpo, IP nem user agent. Para apps com dado sensível (saúde, LGPD) |
| `logRequests` | `true` | log `http.request` automático |
| `ignorePaths` | `['/healthz', '/health']` | |
| `captureUnhandled` | `true` | `uncaughtException` e `unhandledRejection`; o processo cai como cairia sem o Radar |
| `debug` | `false` | mostra problemas internos do SDK |

## Dados sensíveis

Com `redact: 'mask'` (padrão), o SDK mascara antes de enviar:

- headers e chaves (no corpo, na query, nos parâmetros da rota, no caminho da URL e nos atributos) cujo nome tenha uma destas palavras: `password`, `senha`, `secret`, `token`, `auth`, `authorization`, `cookie`, `apikey`, `api key`, `private key`, `access key`, `signature`, `jwt`, `session`, `credential`, `cpf`, `card`, `cvv`, `cvc`, `pin`, `otp`, além da chave `key` sozinha e dos headers `x-…-key`, `x-…-secret` e `x-…-token`. A comparação é por palavra: `cardio` e `passos` não são mascarados;
- qualquer valor com cara de credencial (`Bearer …`, `Basic …`, JWT), seja qual for a chave.

Tokens e chaves saem como `Bearer eyJh…5x9Q #a1b2c3d4`: dá para ver se veio, qual era e se dois valores são iguais. Senhas, CPF, cartão, CVV, PIN e OTP saem só como `••• #a1b2c3d4`, sem nenhum pedaço do valor. A impressão digital é um HMAC com chave derivada da chave do projeto, então não dá para descobrir o valor por força bruta sem ela.

`redact: 'none'` (no `init` ou por chamada de `logRequest`) guarda os valores inteiros.

## Trecho de código nos erros

O SDK lê os source maps sozinho. Em projetos TypeScript, ligue no `tsconfig`:

```json
{ "compilerOptions": { "sourceMap": true, "inlineSources": true } }
```

Com `inlineSources`, o código vai dentro do `.map` e a imagem de produção não precisa conter `src/`.

## Garantias

Nenhuma função lança erro para o app (exceto `track`, que relança o erro de `fn`). A fila fica em memória (até 1000 eventos), é enviada a cada 2 s ou 100 eventos e tenta de novo com espera crescente se o Radar estiver fora. O SDK não registra `SIGTERM`.

Formato dos dados enviados: [PROTOCOL.md](PROTOCOL.md).
