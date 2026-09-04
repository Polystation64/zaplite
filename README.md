# ZapLite

Cliente leve e turbinado do WhatsApp Web para Windows, em **Tauri** (WebView2 nativo).
Instalador de poucos MB, consumo de memória muito menor que o app oficial, sessão
persistente (adeus QR code a cada abertura) e 30 módulos ligáveis por um painel próprio.

## Como funciona

A janela principal carrega `web.whatsapp.com` num WebView2. Antes da página subir,
injetamos `bundle.js`, que registra os módulos. Um segundo processo (janela "Painel")
mostra a UI de configuração; o que você liga lá é salvo em `settings.json` e aplicado
na hora, sem recarregar. O backend em Rust cuida do que o navegador não pode fazer
sozinho: transcrição local, chamadas de IA, salvar arquivos, atalho global e always-on-top.

Nada aqui conversa com o servidor do WhatsApp fora do fluxo normal da página. **Não** usa
bibliotecas não oficiais (Baileys, whatsapp-web.js), então não há o risco de banimento
que elas trazem.

## Pré-requisitos (uma vez)

- **Rust** + **Node 18+**
- **WebView2 Runtime** (já vem no Windows 10/11 atualizado)
- Para IA (resumo, tradução, rascunho, OCR): uma **chave da API Anthropic**, colada no Painel
- Para transcrição **local** de áudio: nada. O Painel instala.

### Transcrição (Whisper)

Abra **Painel › IA & TRANSCRIÇÃO › Transcrição**. A seção mostra o estado real
(o `whisper-cli` foi achado? onde? qual modelo está configurado, existe, que tamanho
tem?) e, se faltar algo, oferece:

- **Instalar o motor** — baixa os binários oficiais do whisper.cpp (release `b4938`)
  e extrai para `%LOCALAPPDATA%\br.com.zaplite.app\whisper\engine`. Variante **CPU**
  (8 MB, roda em qualquer x64) ou **BLAS** (20 MB, mais rápido); a **CUDA** (640 MB)
  só aparece se houver driver NVIDIA na máquina.
- **Escolher o modelo** — `tiny` → `large-v3` (75 MB a 3,1 GB), cada um com uma linha
  honesta sobre qualidade e velocidade. O download tem barra de progresso e botão de
  cancelar; vários modelos convivem e trocar entre os já baixados não rebaixa nada.

**Por que isto fica no app e não no instalador NSIS:** o instalador tem ~2 MB e os
modelos vão de 75 MB a 3 GB — embutir inviabiliza o download, baixar durante o NSIS
é frágil e sem retomada, e dentro do app o usuário troca de modelo depois sem
reinstalar nada.

O download vai para `<arquivo>.part` e só recebe o nome definitivo depois de conferido
(tamanho exato anunciado pelo servidor **e** assinatura do formato — `lmgg` nos 4
primeiros bytes de um `ggml-*.bin`), então nunca sobra um `.bin` truncado com cara de
válido. Queda de rede preserva o `.part` para retomar por `Range:`; cancelar apaga.

**Quem já tem Whisper próprio não é atropelado**: `whisperModel`/`whisperCli`
apontando para caminhos que existem continuam valendo, e o motor instalado pelo app é
último recurso na busca. `ffmpeg` é opcional (o próprio ZapLite converte o áudio); só
entra como retaguarda se a página não conseguir decodificar.

## Rodar

```bash
npm install
npm run dev      # desenvolvimento
npm run build    # gera o instalador (.exe) em src-tauri/target/release/bundle
```

A primeira compilação leva de 5 a 15 minutos (baixa e compila algumas centenas de crates)
e a pasta `src-tauri/target` cresce para uns 2 a 4 GB. Depois disso, cada `npm run dev`
sobe em segundos. Os ícones já vêm gerados em `src-tauri/icons/`.

## Peso

`profile.release` está com `opt-level="s"`, `lto`, `strip` e `panic=abort` para o binário
ficar o menor possível. O instalador NSIS costuma sair na casa de **5–10 MB**, contra
centenas de MB do Electron oficial.

## Onde ficam as opções

Três caminhos, todos levando ao mesmo lugar:

- Um botão **Z** dentro do próprio cabeçalho do WhatsApp, junto dos botões nativos
- Uma aba **Z** encostada na borda direita da janela
- O atalho **Ctrl+Shift+Z**, que abre o Painel direto

O menu lista só os módulos ligados, então muda conforme você configura. Tem também um item
**Diagnóstico**, que testa cada comando nativo e mostra qual falhou e por quê.

## Menu do botão direito (módulo 32)

Clique com o botão direito em qualquer mensagem e o menu se adapta ao tipo:

| Tipo | Ações |
|---|---|
| Áudio | Transcrever (Whisper local) |
| Imagem | Extrair texto (OCR), salvar em Downloads |
| Texto | Copiar, traduzir, responder com sugestão da IA, checar se é golpe |

Fora de mensagens o menu nativo do WhatsApp continua funcionando normalmente.

## Armadilha do ACL remoto (importante se você for adicionar comandos)

O Tauri 2 trata a webview como não confiável e **bloqueia comandos vindos de uma origem
remota** salvo declaração explícita. Como a janela principal carrega `web.whatsapp.com`,
todo comando novo precisa de dois passos, senão o `invoke` é rejeitado e o botão simplesmente
não faz nada:

1. Adicionar o nome do comando em `src-tauri/build.rs`, na lista do `AppManifest::commands`
2. Adicionar `allow-<comando-em-kebab-case>` nas permissões de `capabilities/remote-whatsapp.json`

Se você citar uma permissão que não existe, o `tauri-build` falha e o erro lista todos os
identificadores válidos, o que é a forma mais rápida de descobrir o nome certo.

O ACL vale para **todas** as janelas, não só a remota: como o `build.rs` declara um manifesto
de comandos, até a janela local do Painel precisa citar `allow-<comando>` na
`capabilities/default.json`. Comando ausente da capability = `invoke` rejeitado.

### Segredos nunca vão para a janela remota

`settings.json` guarda a chave da API Anthropic em claro, então existem dois comandos de leitura:

| Comando | Quem pode chamar | O que devolve |
|---|---|---|
| `load_settings` | só a janela `settings` (Painel, conteúdo local) | o settings inteiro, chave inclusive |
| `load_settings_public` | a janela `main` (web.whatsapp.com) | só `modules`, `theme`, `hide`, `notify`, `aiTone` |

A allowlist é a constante `CHAVES_PUBLICAS` em `src/lib.rs`. Se um módulo injetado passar a
precisar de uma chave nova, adicione-a lá — e **nunca** cite `allow-load-settings` na
`remote-whatsapp.json`: qualquer script rodando dentro do WhatsApp Web (XSS, CDN comprometido,
extensão) chamaria o mesmo comando e leria o `sk-ant-...`. Os módulos de IA não precisam da
chave no JS: `ai_complete` e `transcribe_audio` leem o `settings.json` do lado Rust.

Também não tente proteger isso com `deny-load-settings` na capability remota. O
`resolve_access` do Tauri considera o comando negado se ele aparecer em *qualquer* `deny`,
ignorando o filtro por origem — o Painel pararia junto.

## Notificações próprias (módulo 31)

Substitui a notificação nativa por janelas de toast do próprio app, com regras por contato.
Enquanto o módulo está ligado, o `window.Notification` da página é silenciado para não duplicar
o aviso (e é devolvido intacto quando você desliga o módulo).

Cada regra casa pelo nome do contato ou grupo (`contém` ou `exato`), e a primeira que bater vence.
Quem não casa com nenhuma usa a regra padrão. Por regra você define:

| Opção | O que faz |
|---|---|
| Janela | `card`, `faixa` (banner largo), `destaque` (VIP, maior e com pulso) ou `discreto` |
| Som | 6 timbres sintetizados via WebAudio, ou o caminho de um `.wav`/`.mp3` seu |
| Cor | acento da janela, por contato |
| Volume | 0 a 100% |
| Fecha em | segundos até sumir sozinha |
| Persistente | não expira, só fecha no clique |
| Repetir som | reemite o som a cada N segundos enquanto estiver aberta |
| Ocultar prévia | mostra só "Nova mensagem", sem o conteúdo |
| Não notificar | silencia aquele contato por completo |

Os sons são **sintetizados em WebAudio**, não são arquivos: o instalador não engorda nem um KB
por causa deles. Os toasts empilham no canto inferior direito, pausam a contagem quando o mouse
passa por cima, e clicar abre a conversa correspondente trazendo o WhatsApp para a frente.

## Status dos 32 módulos

Já implementados no `bundle.js` / Rust:
1 número não salvo · 4 anti-apagadas · 11 transcrição local · 12 resumo · 14 sugerir resposta ·
21 velocidade de áudio · 24 always-on-top · 25 tema/acento · 26 esconder itens ·
27 atalho global · 29 blur ao sair do foco · **31 notificações por contato** · **32 menu do botão direito**.

Aparecem no painel como planejados (a estrutura já suporta, falta o corpo do módulo):
2 agendar · 3 respostas rápidas · 5 marcar não lidas · 6 ler sem confirmar · 7 fixar sem limite ·
8 notas por contato · 9 lembretes · 10 busca avançada · 13 tradução · 15 OCR · 16 detector de golpe ·
17 resumo diário · 18/19 figurinhas · 20 download em massa · 22 compressor · 23 gravador ·
28 multi-conta · 30 exportar.

Adicionar um módulo novo = escrever um objeto `{id, apply, revert}` no `bundle.js`. O painel
já lista todos pelo catálogo.

## Aviso

Módulos marcados **interceptação** dependem da estrutura interna do WhatsApp Web e podem
quebrar quando ele atualiza. São os que mexem em confirmação de leitura, mensagens apagadas
e afins. Os seletores de DOM também mudam de tempos em tempos e podem precisar de ajuste.

Isso já aconteceu: a classe `message-in`/`message-out` **sumiu** do WhatsApp Web (medido em
16/08/2026: 0 ocorrências com conversa aberta e cheia), e como o seletor estava copiado em 8
lugares, um único sumiço derrubou resumo, sugestão de resposta, anti-apagadas, transcrição,
velocidade de áudio e menu do botão direito de uma vez. Hoje existe **um lugar só** no
`bundle.js` — `bolhasVisiveis()`, `bolhaDe()`, `ehDeSaida()`, `textoDaBolha()`, `idDaBolha()`
— e todo módulo passa por ele. Se o WhatsApp mudar de novo, o conserto é lá e vale para todos.
Cada função usa vários sinais (atributo, ícone `tail-in`/`tail-out`, geometria da bolha no
painel) para não depender de um detalhe só.

## Lançar uma versão nova (atualização assinada)

O ZapLite se atualiza sozinho a partir de um manifesto no domínio do desenvolvedor.
O endereço mora num lugar só — `src-tauri/tauri.conf.json` → `plugins.updater.endpoints[0]`,
hoje `https://alexandreieva.tech/zaplite/latest.json`. Trocar a estrutura do site é trocar
essa linha; o script de publicação monta a URL do instalador a partir dela.

O ritual, inteiro:

```powershell
# 1. onde está a chave privada (fora do repositório, sem senha)
$env:TAURI_SIGNING_PRIVATE_KEY_PATH = "$env:USERPROFILE\.zaplite-keys\zaplite-updater.key"

# 2. suba o número em src-tauri/tauri.conf.json  ("version": "0.1.5")
# 3. escreva o que mudou em CHANGELOG.md, numa seção "## 0.1.5"
# 4. compile: sai o instalador NSIS e o .sig ao lado dele
npm run build

# 5. assine, monte o manifesto e junte tudo numa pasta
npm run publicar
```

O passo 5 deixa `publicacao/latest.json` e `publicacao/ZapLite_<versão>_x64-setup.exe`.
**Suba os dois** para `https://alexandreieva.tech/zaplite/`. Pronto: as instalações que já
existem por aí avisam sozinhas na próxima abertura.

Detalhes que importam:

* **A chave privada nunca entra aqui.** Os scripts só recebem o *caminho*, por
  `TAURI_SIGNING_PRIVATE_KEY_PATH`, e param com mensagem clara se ela não estiver definida.
  O `.gitignore` cobre `*.key`, `*.key.pub` e `.zaplite-keys/`.
* **A chave pública está embutida** em `tauri.conf.json` → `plugins.updater.pubkey`. É ela
  que faz o app recusar um instalador que não veio de você — inclusive se alguém tomar o
  domínio. Trocar a chave privada exige trocar a pública aqui e reinstalar todo mundo à mão.
* **Se não houver seção da versão no `CHANGELOG.md`**, o manifesto sai sem `notes` e o
  aviso mostra só o número. O script avisa em voz alta quando isso acontece.
* Nada é instalado sem o usuário mandar. A verificação automática roda dois minutos depois
  da abertura, e a instalação é um botão no Painel › **ATUALIZAÇÃO** — depois das notas.

## Sobre distribuir isto

Este projeto é um invólucro do WhatsApp Web para uso pessoal. Vale ser direto sobre os limites:
os Termos de Serviço do WhatsApp não permitem clientes de terceiros distribuídos, e "WhatsApp"
é marca registrada da Meta, então o nome e o visual não podem ser usados num produto comercial.
Distribuir isto como produto pago traria risco de bloqueio de conta para os usuários e risco
jurídico para quem publica.

Como ferramenta sua, rodando na sua máquina, é outro caso e não há problema.

## Notas de depuração (o que já mordeu)

Coisas que quebraram durante o desenvolvimento e como identificar se voltarem:

1. **Painel abre em branco.** Causa: um `@import` de fonte remota no topo do CSS.
   Ele bloqueia a pintura da página, e o WebView2 mostra branco enquanto espera.
   Hoje o app usa só fontes já presentes no Windows e não busca nada na rede
   para desenhar a interface. Se voltar a acontecer, procure recursos remotos no `<head>`.

2. **Módulo novo não liga em instalação existente.** Causa: aplicar os padrões só
   quando `settings.json` não existia. Quem já tinha o arquivo nunca recebia módulos novos.
   Hoje os padrões são mesclados: o que você salvou vence, o que nunca viu usa o padrão.

3. **Botão não faz nada.** Quase sempre é o ACL do Tauri barrando a origem remota.
   Use o item **Diagnóstico** no menu, que testa cada comando e mostra a falha exata.

4. **Erro silencioso.** O `invoke` propaga erros e todo handler mostra o problema
   num painel na tela. Se algo falhar sem aviso, isso é um bug em si.
