# Contribuir com o ZapLite

Curto de propósito. São cinco coisas que, ignoradas, quebram o projeto de um jeito que
não aparece na hora.

## 1. `bundle.js` é gerado — edite `injection/src/`

`src-tauri/injection/bundle.js` é artefato de build. A fonte é
`src-tauri/injection/src/`, e o esbuild o reconstrói a cada `npm run dev` / `npm run build`.
Editar o bundle à mão = perder a edição no próximo build.

```bash
npm run empacotar         # regera o bundle
npm run conferir-bundle   # falha se o bundle estiver fora de sincronia com src/
```

## 2. Arquivos só declaram; efeito colateral é chamada em `main.js`

Todo arquivo em `injection/src/` contém **só declarações** (`function`, `const`, `let`) e
**nenhum efeito colateral de topo**. Registrar um módulo, instalar um gancho, subir o boot
— tudo isso é uma chamada em `injection/src/main.js`, naquela lista, naquela ordem.

Sem isso a ordem de execução vira a ordem em que o empacotador resolve os `import`:
invisível, e diferente da ordem em que se lê o código. Já custou caro aqui — dois módulos
individualmente corretos que, juntos, recarregavam a página a cada 5 minutos.

Módulo novo, na prática:

1. `injection/src/modulos/<nome>.js`, exportando `registrar<Nome>()` que chama
   `reg({ id, apply, revert })`
2. o `import` e a chamada em `injection/src/main.js`
3. o `id` na lista `IMPLEMENTADOS` de `src/index.html` (só depois de existir de verdade —
   interruptor que não liga nada é promessa falsa)

## 3. Comando novo no Rust precisa de DOIS registros de ACL

O Tauri 2 bloqueia comandos vindos de origem remota, e a janela principal carrega
`web.whatsapp.com`. Sem os dois passos abaixo, o `invoke` é rejeitado em silêncio e o
botão simplesmente não faz nada:

1. o nome do comando em `src-tauri/build.rs`, na lista do `AppManifest::commands`
2. `allow-<comando-em-kebab-case>` em `src-tauri/capabilities/remote-whatsapp.json`
   (e em `capabilities/default.json` se o Painel também chamar — o ACL vale para todas as
   janelas, inclusive as locais)

Se você citar uma permissão inexistente, o `tauri-build` falha e o erro lista os
identificadores válidos. É a forma mais rápida de achar o nome certo.

**Nunca** cite `allow-load-settings` na capability remota: qualquer script dentro do
WhatsApp Web leria a chave de API. Para o lado remoto existe `load_settings_public`, com a
allowlist `CHAVES_PUBLICAS` em `src-tauri/src/lib.rs`. E não use `deny-load-settings` para
"proteger": o `resolve_access` do Tauri nega o comando em todas as janelas, derrubando o
Painel junto.

## 4. Seletor do WhatsApp Web mora num lugar só

`injection/src/bolhas.js` (bolhas de mensagem) e `injection/src/lista.js` (linhas de
`#pane-side`). Um seletor novo dentro de `modulos/*.js` é motivo para recusar a mudança:
já houve um caso em que o mesmo seletor estava copiado em 8 arquivos e uma mudança do
WhatsApp derrubou seis módulos de uma vez.

## 5. Rodar os testes

```bash
npm run teste-bundle      # testes do bundle injetado + compila o script do Painel e do toast
npm run conferir-bundle   # bundle.js em sincronia com injection/src/
cargo test --manifest-path src-tauri/Cargo.toml   # backend Rust
```

Os dois primeiros rodam sozinhos no CI a cada push e PR. Um teste aqui costuma amarrar uma
regra que já custou caro — se um deles quebrar por causa da sua mudança, o teste
provavelmente está certo.

---

Uma última: mudança que altera o comportamento visível merece uma linha no `CHANGELOG.md`,
na seção da versão. É de lá que sai o texto do aviso de atualização, e ele não inventa
nada para preencher espaço.
