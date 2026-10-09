# @oconde/radar

SDK do [Radar](https://radar.oconde.dev) para Node.js, NestJS e SvelteKit: logs, erros com trecho de código, contexto de requisição, tarefas agendadas e erros do navegador. Sem dependências em runtime.

**Documentação completa: https://radar.oconde.dev/docs/**

## Instalação

```bash
npm install @oconde/radar
```

Node 20 ou mais novo. Funciona em ESM e CommonJS, do NestJS 10 em diante. Gere a chave do projeto no painel do Radar e ponha em `RADAR_KEY`.

## NestJS

```ts
import { Module } from '@nestjs/common';
import { RadarModule } from '@oconde/radar/nest';

@Module({
  imports: [RadarModule.forRoot({ key: process.env.RADAR_KEY, release: process.env.GIT_SHA })],
})
export class AppModule {}
```

O módulo registra o contexto por requisição, um log `http.request` por requisição e a captura dos erros 5xx. Nos services:

```ts
import { radar } from '@oconde/radar';

radar.info('webhook.olx.lead', { leadId });
```

## Express

```ts
import { radar } from '@oconde/radar';

radar.init({ key: process.env.RADAR_KEY });
app.use(radar.middleware());
```

Depois das rotas, para os erros dos handlers chegarem ao Radar:

```ts
import type { ErrorRequestHandler } from 'express';

const reportErrors: ErrorRequestHandler = (error, req, res, next) => {
  radar.captureError(error);
  next(error);
};

app.use(reportErrors);
```

Exemplo completo em [Express e Node](https://radar.oconde.dev/docs/sdk/express/).

## SvelteKit

```ts
import { sequence } from '@sveltejs/kit/hooks';
import { radar } from '@oconde/radar';
import { radarHandle, radarHandleError } from '@oconde/radar/sveltekit';

radar.init({ key: process.env.RADAR_KEY, release: process.env.GIT_SHA });

export const handle = sequence(radarHandle(), yourHandle);
export const handleError = radarHandleError();
```

Se o app já gera o próprio id de requisição, passe-o e coloque o `radarHandle` depois do handle que o cria: `radarHandle({ requestId: (event) => event.locals.requestId })`.

Erros do navegador vão por uma rota do próprio app, sem expor a chave. Ela limita tamanho e frequência por visitante e no total; atrás de proxy, configure `ADDRESS_HEADER`/`XFF_DEPTH` do adapter-node para o IP do visitante ser o real:

```ts title="src/routes/api/radar/client-errors/+server.ts"
import { radarClientErrors } from '@oconde/radar/sveltekit';

export const POST = radarClientErrors();
```

```ts
import { handleErrorWithRadar, listenForClientErrors } from '@oconde/radar/browser';

listenForClientErrors();
export const handleError = handleErrorWithRadar();
```

Com `build: { sourcemap: 'hidden' }` no Vite e `radar-sourcemaps` depois do build, os mapas saem de `build/client` e o servidor mostra o código original. Detalhes em [SvelteKit](https://radar.oconde.dev/docs/sdk/sveltekit/) e [Erros do navegador](https://radar.oconde.dev/docs/sdk/browser/).

## Tarefas agendadas

```ts
await radar.cron('nightly-report', () => buildReport());
```

`radar.cron` avisa o Radar no início, no fim e na falha, e o Radar alerta se a tarefa atrasar ou falhar. Em scripts sem o SDK, o check-in é um `POST` (veja o [PROTOCOL.md](PROTOCOL.md)). Para jobs e workers, `radar.withContext(fn)` dá a cada execução o próprio `requestId`. Detalhes em [Tarefas agendadas](https://radar.oconde.dev/docs/sdk/cron/).

## Erros com o seu código

Ligue no `tsconfig` para os erros mostrarem as linhas do TypeScript:

```json
{ "compilerOptions": { "sourceMap": true, "inlineSources": true } }
```

## Na documentação

- [Começar em 5 minutos](https://radar.oconde.dev/docs/start/getting-started/)
- [Todas as opções](https://radar.oconde.dev/docs/sdk/options/)
- [Dados sensíveis e `requestDetail: 'route'`](https://radar.oconde.dev/docs/sdk/sensitive-data/)
- [Garantias: fila, lotes e o que acontece quando o Radar cai](https://radar.oconde.dev/docs/sdk/guarantees/)
- [Referência da API](https://radar.oconde.dev/docs/reference/sdk-api/)
- [Protocolo de envio](https://radar.oconde.dev/docs/reference/protocol/) (também em [PROTOCOL.md](PROTOCOL.md), para quem escreve um SDK em outra linguagem)

## Licença

MIT
