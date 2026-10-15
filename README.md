# iPaaS Helper

Extensão Chrome (Manifest V3) que adiciona utilitários ao TOTVS iPaaS: captura de
sessão, ajudantes no builder, execução de integrações e acompanhamento da
execução com destaque do caminho no canvas.

## Funcionalidades

- Captura da sessão a partir do `document.cookie` da aba (funciona em janela
  normal e anônima).
- Painel no builder: origem das funções (em uso por nó, por função, ou sem uso)
  e resumo das condições.
- Botão "Executar" sobre o nó inicial (webhook), com payload de exemplo montado a
  partir do próprio fluxo. O JWT da sessão nunca é enviado na execução.
- Modal de acompanhamento (ancorada à esquerda) com lista de steps, mensagens
  filhas de splitter e botão "Executar novamente".
- Destaque do caminho da execução no canvas, colorido por status
  (amarelo = processando, verde = concluído, vermelho = erro), com animação de
  acender suave. Steps de condição são marcados no rastro.

## Instalar a partir de um Release (sem build)

Cada versão publicada tem um `.zip` pronto na aba
[Releases](https://github.com/dugabriel/ipaas-extension/releases) do repositório
(gerado automaticamente pelo GitHub Actions).

1. Baixe o `ipaas-helper-vX.Y.Z.zip` do Release mais recente e extraia.
2. Abra `chrome://extensions` e ative o **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação** e selecione a pasta extraída.

Se preferir buildar você mesmo, siga as seções abaixo.

## Pré-requisitos

- Node.js 18+ e npm.
- Google Chrome (ou outro navegador baseado em Chromium).

## Build

```bash
npm install
npm run build
```

O build gera a pasta `dist/`, que é a extensão pronta para carregar. Rode
`npm run build` novamente sempre que alterar o código.

Scripts úteis:

- `npm run build` — gera a `dist/`.
- `npm run package` — gera a `dist/` e empacota em `ipaas-helper.zip`.
- `npm run dev` — build em modo de desenvolvimento (watch) do Vite.
- `npm test` — roda a suíte de testes (vitest).

## Instalar no Chrome

1. Abra `chrome://extensions`.
2. Ative o **Modo do desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação** (Load unpacked).
4. Selecione a pasta `dist/` gerada pelo build.

A extensão "iPaaS Helper" aparece na lista. Abra o iPaaS
(`https://ipaas.totvs.app`) e, ao entrar em um diagrama no builder, o painel do
helper aparece na página.

### Depois de alterar o código

1. Rode `npm run build` de novo.
2. Em `chrome://extensions`, clique em recarregar (⟳) no card da extensão.
3. Dê **F5** na aba do iPaaS para recarregar o content script.

## Uso rápido

1. Entre em um diagrama no builder do iPaaS.
2. Se pedir, capture a sessão pelo popup da extensão ("Capturar sessão").
3. Use o botão **▶ Executar** sobre o nó inicial para disparar a integração.
4. Acompanhe os steps na modal; o caminho acende no canvas conforme a execução
   avança.

## Estrutura

- `src/` — código-fonte (content script, service worker, popup, helpers).
- `test/` — testes (vitest + fast-check).
- `manifest.json` — manifesto MV3.
- `vite.config.ts` — build com `@crxjs/vite-plugin`.
