# Changelog

## 0.4.1

### Correções

- `logRequests: { sample: 0 }` não registra nenhuma requisição. Antes, 0 era tratado como valor inválido e virava 1, guardando todas.

## 0.4.0

### Novo

- `logRequests` aceita filtros e amostragem: `{ include, exclude, sample }`. `include` e `exclude` recebem caminhos ou rotas (`'/dashboard'` vale para `/dashboard` e tudo abaixo dele) ou RegExp, testados no caminho e na rota do framework. `sample` (de 0 a 1) guarda só essa fração das requisições, sorteada de forma uniforme, e cada log guardado leva `sampleRate`, que o Radar usa para estimar os totais. `logRequests: true` e `false` continuam valendo.
- `traceFetch.ignore`: hosts (o nome exato ou `.dominio`) ou RegExp testadas em `host + caminho` que não viram log `http.client`. As chamadas continuam saindo normalmente.

### Correções

- Uma RegExp com a flag `g` em `propagateTo` deixava de mandar o `x-request-id` em chamadas alternadas.

## 0.3.0

### Novo

- `traceFetch`: cada `fetch` de saída vira um log `http.client` com método, host, caminho (sem a query, com trechos que parecem segredo mascarados), status e duração, ou o erro com a causa (`fetch failed (ECONNREFUSED)`). Para os hosts de `propagateTo`, o SDK manda o `x-request-id` da requisição atual, sem trocar um que o app já tenha posto. Chamadas para o próprio Radar ficam de fora. Desligado por padrão.

### Correções

- O nome da função inferido do código original não se confunde mais com chaves e com a palavra `function` dentro de comentários de várias linhas (como os de JSDoc).

## 0.2.0

### Novo

- `@oconde/radar/sveltekit`: `radarHandle` (contexto, `x-request-id`, log `http.request`; opção `requestId` para usar o id do app), `radarHandleError`, `radarClientErrors` (rota que recebe erros do navegador), `moveClientSourceMaps` e `composeServerSourceMaps`.
- `@oconde/radar/browser`: `reportClientError`, `handleErrorWithRadar` e `listenForClientErrors`, sem dependência de Node.
- Erros do navegador trazem o que a pessoa fez logo antes: `listenForClientErrors` guarda o último clique ou envio de formulário (elemento e texto visível, nunca o valor digitado; links com texto longo, números ou `@` vão sem o texto, e e-mails e números viram `<email>` e `<número>`) e a rota grava em `ui.action`, `ui.element`, `ui.label` e `ui.msBefore`. No modo `requestDetail: 'route'` o texto do elemento não é enviado. `captureActions: false` desliga.
- Frames do navegador ganham o nome da função do código original (inferido do source map), em vez de ficarem sem nome.
- Comando `radar-sourcemaps [buildDir]`: depois do `vite build`, tira os source maps de `build/client` e reescreve os caminhos para continuarem apontando para o código. Também junta os dois níveis de mapa do servidor (o do Vite e o do `adapter-node`), para a stack do servidor apontar direto para o arquivo em `src/`, e não para `.svelte-kit/output/server`.
- `radar.withContext`, `radar.checkIn` e `radar.cron` para workers e tarefas agendadas.
- `radar.captureException` para quem já tem a exceção montada.

### Mudanças de comportamento

- **Agrupamento de erros:** frames que, pelo source map, caem em `node_modules` deixam de contar como código do app, e arquivos gerados com `sourcemap: 'hidden'` passam a usar o `.map` ao lado. As duas coisas mudam a impressão digital de alguns erros: no deploy que atualizar o SDK, erros já conhecidos podem reaparecer como novos uma vez.
- `radarHandleError()` e `handleErrorWithRadar()` sem handler interno imprimem o erro no console e deixam o SvelteKit usar a mensagem padrão (antes devolviam "Internal Error", inclusive no 404).
- Um `x-request-id` com caracteres fora do ASCII imprimível é trocado por um id gerado.
- Check-ins cortam `environment` em 64 caracteres, `release` em 128 e `durationMs` em 7 dias, como o servidor exige.

### Correções

- Express: segredos em parâmetros do caminho (como `/reset/:token`) eram enviados sem máscara quando a requisição terminava no middleware de erro do app.

## 0.1.0

Primeira versão: NestJS, Express, logs, erros com trecho de código, requisições e mascaramento de dados sensíveis.
