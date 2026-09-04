# ZapLite

Cliente **não oficial** e leve do WhatsApp Web para Windows, em [Tauri](https://tauri.app)
(WebView2 nativo). Instalador de poucos MB, consumo de memória muito menor que o app
oficial, sessão persistente (adeus QR code a cada abertura) e um catálogo de 34 módulos
ligáveis por um painel próprio.

---

## ⚠️ Aviso — leia antes de instalar

**Este é um cliente de terceiros. Os Termos de Serviço da Meta não permitem clientes de
terceiros para o WhatsApp, e contas podem ser banidas.** O risco é real e recai sobre
quem instala. Não existe promessa em contrário aqui.

Outras coisas que precisam ser ditas de frente:

- **"WhatsApp" é marca registrada da Meta Platforms, Inc.** Este projeto não tem
  relação nenhuma com a Meta: não é afiliado, autorizado nem endossado por ela.
- **O instalador não é assinado** por certificado de código. O Windows vai mostrar o
  aviso do SmartScreen ("Windows protegeu o computador"). É preciso clicar em *Mais
  informações → Executar assim mesmo* — o que também significa que você está confiando
  no arquivo por conta própria.
- **O app depende de ler o DOM do WhatsApp Web, que muda sem aviso.** Durante o
  desenvolvimento isso quebrou o app seis vezes. Não é um defeito que se conserta de
  uma vez: manutenção contínua é a natureza do projeto. Se você não quer manter, não
  dependa disto para nada importante.
- É um projeto pessoal, publicado como código. Não é um produto, não tem suporte
  comercial e não deve ser vendido — distribuir isto como produto pago traria risco de
  bloqueio de conta para os usuários e risco jurídico para quem publica.

Como ferramenta sua, rodando na sua máquina, com a conta sendo sua e o risco sendo seu:
é outro caso.

---

## O que é

A janela principal carrega `web.whatsapp.com` num WebView2. Antes de a página subir,
injetamos `bundle.js`, que registra os módulos. Um segundo processo (janela "Painel")
mostra a UI de configuração; o que você liga lá é salvo em `settings.json` e aplicado na
hora, sem recarregar. O backend em Rust cuida do que o navegador não pode fazer sozinho:
transcrição local, chamadas de IA, salvar arquivos, atalho global, always-on-top,
notificações próprias, multi-conta e a atualização assinada.

## O que não é

- **Não é um cliente de protocolo.** Não usa Baileys, whatsapp-web.js nem nenhuma
  biblioteca não oficial que fale com o servidor do WhatsApp. Nada aqui conversa com o
  servidor fora do fluxo normal da própria página.
- **Não é um bot.** Só um módulo do catálogo envia mensagem sozinho (agendar), e ele
  nasce desligado por causa disso.
- **Não é multiplataforma.** É Windows + WebView2, e o backend assume isso.
- **Não é "seguro contra banimento".** Ver o aviso acima.

## Requisitos

Para **usar**:

- Windows 10/11 com **WebView2 Runtime** (já vem no Windows atualizado)
- Para os módulos de IA (resumo, tradução, rascunho, OCR, detector de golpe): uma chave
  de API do provedor que você escolher, colada no Painel
- Para transcrição **local** de áudio: nada. O Painel instala o motor.

Para **compilar**: além do acima, **Rust** (estável) e **Node 18+**.

## Instalar

Não há release oficial assinada. Você compila (abaixo) ou usa um instalador NSIS gerado
por `npm run build`, ciente do aviso do SmartScreen.

O app se atualiza sozinho a partir de um manifesto assinado no domínio do desenvolvedor
(ver *Lançar uma versão nova*). Nada é instalado sem o usuário mandar: a verificação roda
dois minutos depois da abertura e a instalação é um botão no Painel › **ATUALIZAÇÃO**,
depois das notas.

## Compilar

```bash
npm install
npm run dev      # desenvolvimento
npm run build    # gera o instalador (.exe) em src-tauri/target/release/bundle
```

A primeira compilação leva de 5 a 15 minutos (baixa e compila algumas centenas de crates)
e a pasta `src-tauri/target` cresce para uns 2 a 4 GB. Depois disso, cada `npm run dev`
sobe em segundos. Os ícones já vêm gerados em `src-tauri/icons/`.

Testes e conferência:

```bash
npm run teste-bundle      # testes do bundle injetado + compila o script do Painel
npm run conferir-bundle   # falha se bundle.js estiver fora de sincronia com injection/src/
```

**Peso.** `profile.release` está com `opt-level="s"`, `lto`, `strip` e `panic=abort` para
o binário ficar o menor possível. O instalador NSIS costuma sair na casa de **5–10 MB**,
contra centenas de MB do Electron oficial.

---

## Como o código está organizado

```
src/                       janelas locais (HTML): index.html = Painel, toast.html = notificações
scripts/                   empacotador, build, publicação (Node, ESM)
src-tauri/injection/
  src/                     ⬅ o código que você edita
  bundle.js                ⬅ GERADO. Não edite à mão.
  bundle.test.js           testes do bundle (node, sem dependência)
src-tauri/src/             backend Rust
src-tauri/capabilities/    ACL do Tauri (ver a armadilha abaixo)
```

### `bundle.js` é gerado

O arquivo injetado na página é **artefato de build**. A fonte é `src-tauri/injection/src/`,
e `node scripts/empacotar.mjs` (rodado por `npm run dev` e `npm run build`) o produz com
esbuild. Editar `bundle.js` à mão significa perder a edição no próximo build.
`npm run conferir-bundle` existe justamente para gritar quando os dois divergem.

### Módulos ESM + `main.js` como ponto de composição

Cada arquivo em `injection/src/` contém **só declarações** — `function`, `const`, `let` —
e **nenhum efeito colateral de topo**. Todo efeito colateral (instalar o gancho de
WebSocket, registrar um módulo, pendurar `__ZAPLITE_RELOAD__`, subir o boot) é uma chamada
em `injection/src/main.js`, naquela lista, naquela ordem.

Isso não é estética. Sem essa regra, a ordem de execução passa a ser a ordem em que o
empacotador resolve os `import` — invisível, e diferente da ordem em que alguém lê o
código. Foi uma composição implícita assim (dois módulos corretos que, juntos,
recarregavam a página a cada 5 minutos) que custou caro neste projeto.

A camada compartilhada, por arquivo:

| Arquivo | O que é |
|---|---|
| `nucleo.js` | settings, CSS, `until`, `applyAll` — a base de todo módulo |
| `ponte.js` | o `invoke` para o Rust |
| `bolhas.js` | **um lugar só** para achar/ler bolhas de mensagem (ver *seletores*) |
| `lista.js` | idem, para as linhas da lista de conversas (`#pane-side`) |
| `conn-core.js` | camada de conexão: heartbeat e transições, sempre ativa |
| `dock.js`, `painel.js` | botão **Z**, aba lateral e o menu |
| `ia.js`, `midia.js`, `links.js`, `figurinha.js` | serviços compartilhados |
| `boot.js` | a subida, chamada por último |
| `modulos/*.js` | um arquivo por módulo, cada um exportando `registrar…()` |

Adicionar um módulo = um arquivo em `modulos/` exportando `registrar…()` que chama
`reg({ id, apply, revert })`, mais a chamada correspondente em `main.js`, mais o `id` na
lista `IMPLEMENTADOS` de `src/index.html`.

### Rust, por submódulo

| Arquivo | O que é |
|---|---|
| `lib.rs` | composição do app, settings, comandos gerais, atalhos globais |
| `connection/` | camada de conexão, dividida: `tipos` (vocabulário puro), `estado` (`Inner` e o monitor), `decisao` (a autoridade única sobre disparar recuperação), `watchdog` (o laço), `log` (o único caminho até `connection.log`), `comandos` (a superfície da ponte), `testes` |
| `ai.rs` | IA multi-provedor, com `ai_complete` normalizando formato e erro |
| `whisper.rs` | instalação e download do motor/modelos, com verificação e retomada |
| `notify.rs` | notificações próprias (janelas de toast, regras por contato) |
| `contas.rs` | multi-conta: perfil do WebView2, `settings.json` e log por conta |
| `diagnostico.rs` | o relatório de texto do Painel, já redigido |
| `update.rs` | atualização assinada, com aviso e consentimento |
| `protocol.rs` | links `whatsapp://` abrindo no ZapLite |

---

## Armadilha do ACL remoto (leia antes de adicionar um comando)

O Tauri 2 trata a webview como não confiável e **bloqueia comandos vindos de uma origem
remota** salvo declaração explícita. Como a janela principal carrega `web.whatsapp.com`,
todo comando novo precisa de dois passos — senão o `invoke` é rejeitado e o botão
simplesmente não faz nada:

1. Adicionar o nome do comando em `src-tauri/build.rs`, na lista do `AppManifest::commands`
2. Adicionar `allow-<comando-em-kebab-case>` nas permissões de
   `src-tauri/capabilities/remote-whatsapp.json`

Se você citar uma permissão que não existe, o `tauri-build` falha e o erro lista todos os
identificadores válidos — a forma mais rápida de descobrir o nome certo.

O ACL vale para **todas** as janelas, não só a remota: como o `build.rs` declara um
manifesto de comandos, até a janela local do Painel precisa citar `allow-<comando>` na
`capabilities/default.json`. Comando ausente da capability = `invoke` rejeitado.

### Segredos nunca vão para a janela remota

`settings.json` guarda a chave da API em claro, então existem dois comandos de leitura:

| Comando | Quem pode chamar | O que devolve |
|---|---|---|
| `load_settings` | só a janela `settings` (Painel, conteúdo local) | o settings inteiro, chave inclusive |
| `load_settings_public` | a janela `main` (`web.whatsapp.com`) | só `modules`, `theme`, `hide`, `notify`, `aiTone` |

A allowlist é a constante `CHAVES_PUBLICAS` em `src-tauri/src/lib.rs`. Se um módulo
injetado passar a precisar de uma chave nova, adicione-a lá — e **nunca** cite
`allow-load-settings` na `remote-whatsapp.json`: qualquer script rodando dentro do
WhatsApp Web (XSS, CDN comprometido, extensão) chamaria o mesmo comando e leria o
`sk-ant-…`. Os módulos de IA não precisam da chave no JS: `ai_complete` e
`transcribe_audio` leem o `settings.json` do lado Rust.

Também não tente proteger isso com `deny-load-settings` na capability remota. O
`resolve_access` do Tauri considera o comando negado se ele aparecer em *qualquer* `deny`,
ignorando o filtro por origem — o Painel pararia junto.

---

## Os seletores são frágeis, e por isso moram num lugar só

Módulos marcados **interceptação** dependem da estrutura interna do WhatsApp Web e podem
quebrar quando ele atualiza. Os seletores de DOM também mudam de tempos em tempos.

Isso já aconteceu, e caro: a classe `message-in`/`message-out` **sumiu** do WhatsApp Web
(medido em 16/08/2026: 0 ocorrências com conversa aberta e cheia) e, como o seletor estava
copiado em 8 lugares, um único sumiço derrubou resumo, sugestão de resposta,
anti-apagadas, transcrição, velocidade de áudio e menu do botão direito de uma vez.

Hoje existe **um lugar só** — `injection/src/bolhas.js`, com `bolhasVisiveis()`,
`bolhaDe()`, `ehDeSaida()`, `textoDaBolha()`, `idDaBolha()` — e todo módulo passa por ele;
`injection/src/lista.js` faz o mesmo papel para a lista de conversas. Se o WhatsApp mudar
de novo, o conserto é lá e vale para todos. Cada função usa vários sinais (atributo, ícone
`tail-in`/`tail-out`, geometria da bolha no painel) para não depender de um detalhe só.

**Regra da casa:** um seletor do WhatsApp Web novo em qualquer `modulos/*.js` é motivo
para recusar a mudança. Ele pertence a `bolhas.js` ou `lista.js`.

---

## Os 34 módulos do catálogo

O catálogo mora em `src/index.html` (`CATALOG`), e a separação entre o que existe e o que
não existe é **estrutural**, não um rótulo: quem não tem código não ganha interruptor.
Interruptor que não liga nada é promessa falsa, e promessa falsa contamina a confiança até
no que funciona.

- **30 têm código e interruptor** (a lista `IMPLEMENTADOS`, no mesmo arquivo).
- **1 está construído fora da grade**: multi-conta — não é módulo da página, é estrutura
  do app (perfil do WebView2, `settings.json` e `connection.log` por conta) e mora na aba
  **CONTAS**.
- **2 estão marcados como planejados**: compressor de vídeo (22) e gravador de tela (23).
  A estrutura já os suporta; falta o corpo.
- **1 está marcado como recusado**: *ler sem confirmar* (`noReadReceipt`). Não é "para
  depois" — foi decidido não fazer, porque dessincronizaria a conta. O motivo inteiro está
  escrito no cartão dele no Painel.

Ao implementar um módulo, mova o `id` para `IMPLEMENTADOS`: ele sai sozinho da área de
planejados e ganha interruptor.

## Onde ficam as opções

Três caminhos, todos levando ao mesmo lugar:

- Um botão **Z** dentro do próprio cabeçalho do WhatsApp, junto dos botões nativos
- Uma aba **Z** encostada na borda direita da janela
- O atalho **Ctrl+Shift+Z**, que abre o Painel direto

O menu lista só os módulos ligados, então muda conforme você configura. Tem também um item
**Diagnóstico**, que testa cada comando nativo e mostra qual falhou e por quê.

## Transcrição local (Whisper)

Abra **Painel › IA & TRANSCRIÇÃO › Transcrição**. A seção mostra o estado real (o
`whisper-cli` foi achado? onde? qual modelo está configurado, existe, que tamanho tem?) e,
se faltar algo, oferece:

- **Instalar o motor** — baixa os binários oficiais do whisper.cpp (release `b4938`) e
  extrai para `%LOCALAPPDATA%\br.com.zaplite.app\whisper\engine`. Variante **CPU** (8 MB,
  roda em qualquer x64) ou **BLAS** (20 MB, mais rápido); a **CUDA** (640 MB) só aparece
  se houver driver NVIDIA na máquina.
- **Escolher o modelo** — `tiny` → `large-v3` (75 MB a 3,1 GB), cada um com uma linha
  honesta sobre qualidade e velocidade. O download tem barra de progresso e botão de
  cancelar; vários modelos convivem e trocar entre os já baixados não rebaixa nada.

**Por que isto fica no app e não no instalador NSIS:** o instalador tem ~2 MB e os modelos
vão de 75 MB a 3 GB — embutir inviabiliza o download, baixar durante o NSIS é frágil e sem
retomada, e dentro do app o usuário troca de modelo depois sem reinstalar nada.

O download vai para `<arquivo>.part` e só recebe o nome definitivo depois de conferido
(tamanho exato anunciado pelo servidor **e** assinatura do formato — `lmgg` nos 4 primeiros
bytes de um `ggml-*.bin`), então nunca sobra um `.bin` truncado com cara de válido. Queda
de rede preserva o `.part` para retomar por `Range:`; cancelar apaga.

**Quem já tem Whisper próprio não é atropelado**: `whisperModel`/`whisperCli` apontando
para caminhos que existem continuam valendo, e o motor instalado pelo app é último recurso
na busca. `ffmpeg` é opcional (o próprio ZapLite converte o áudio); só entra como
retaguarda se a página não conseguir decodificar.

---

## Lançar uma versão nova (atualização assinada)

O ZapLite se atualiza sozinho a partir de um manifesto no domínio do desenvolvedor. O
endereço mora num lugar só — `src-tauri/tauri.conf.json` → `plugins.updater.endpoints[0]`.
Trocar a estrutura do site é trocar essa linha; o script de publicação monta a URL do
instalador a partir dela.

O ritual, inteiro:

```powershell
# 1. onde está a chave privada (FORA do repositório, sem senha)
$env:TAURI_SIGNING_PRIVATE_KEY_PATH = "$env:USERPROFILE\.zaplite-keys\zaplite-updater.key"

# 2. suba o número em src-tauri/tauri.conf.json  ("version": "0.1.7")
# 3. escreva o que mudou em CHANGELOG.md, numa seção "## 0.1.7"
# 4. compile: sai o instalador NSIS e o .sig ao lado dele
npm run build

# 5. assine, monte o manifesto e junte tudo numa pasta
npm run publicar
```

O passo 5 deixa `publicacao/latest.json` e `publicacao/ZapLite_<versão>_x64-setup.exe`.
**Suba os dois** para o diretório apontado pelo endpoint. Pronto: as instalações que já
existem por aí avisam sozinhas na próxima abertura.

Detalhes que importam:

- **A chave privada nunca entra no repositório.** Os scripts só recebem o *caminho*, por
  `TAURI_SIGNING_PRIVATE_KEY_PATH`, e param com mensagem clara se ela não estiver
  definida. O `.gitignore` cobre `*.key`, `*.key.pub` e `.zaplite-keys/`.
- **A chave pública está embutida** em `tauri.conf.json` → `plugins.updater.pubkey`. É ela
  que faz o app recusar um instalador que não veio de você — inclusive se alguém tomar o
  domínio. Trocar a chave privada exige trocar a pública aqui e reinstalar todo mundo à
  mão.
- **Se não houver seção da versão no `CHANGELOG.md`**, o manifesto sai sem `notes` e o
  aviso mostra só o número. O script avisa em voz alta quando isso acontece.
- A pasta `publicacao/` é ignorada pelo git de propósito: instalador não é código.

## Notas de depuração (o que já mordeu)

1. **Painel abre em branco.** Causa: um `@import` de fonte remota no topo do CSS. Ele
   bloqueia a pintura da página, e o WebView2 mostra branco enquanto espera. Hoje o app usa
   só fontes já presentes no Windows e não busca nada na rede para desenhar a interface. Se
   voltar a acontecer, procure recursos remotos no `<head>`.
2. **Módulo novo não liga em instalação existente.** Causa: aplicar os padrões só quando
   `settings.json` não existia. Quem já tinha o arquivo nunca recebia módulos novos. Hoje
   os padrões são mesclados: o que você salvou vence, o que nunca viu usa o padrão.
3. **Botão não faz nada.** Quase sempre é o ACL do Tauri barrando a origem remota. Use o
   item **Diagnóstico** no menu, que testa cada comando e mostra a falha exata.
4. **Erro silencioso.** O `invoke` propaga erros e todo handler mostra o problema num
   painel na tela. Se algo falhar sem aviso, isso é um bug em si.
5. **Alguma coisa parou depois de uma atualização do WhatsApp.** Comece por
   `injection/src/bolhas.js` e `lista.js` — é onde os seletores moram.

---

## Contribuir

Leia [CONTRIBUTING.md](CONTRIBUTING.md). O resumo: `bundle.js` é gerado, `main.js` é o
único lugar com efeito colateral, comando novo precisa de `build.rs` + capability, e
`npm run teste-bundle` tem que passar.

Bugs e sugestões vão pelos modelos em [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE).
Para relatar bug, cole o diagnóstico: **Painel › SOBRE › copiar diagnóstico** — ele já
redige chaves, contatos e conteúdo de conversa.

Problema de segurança **não** vai para issue pública: ver [SECURITY.md](.github/SECURITY.md).

## Licença

[MIT](LICENSE) © 2026 Alexandre Ieva.

A licença cobre o código deste repositório e nada mais — não concede direito sobre a marca
"WhatsApp", que é da Meta Platforms, Inc., nem altera os Termos de Serviço dela.
