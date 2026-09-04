# Política de segurança

## Como relatar

**Não abra issue pública para falha de segurança.** Use um destes caminhos:

1. **GitHub → aba Security → "Report a vulnerability"** (private vulnerability reporting),
   se estiver habilitado no repositório; ou
2. **e-mail para `eu@alexandreieva.tech`**, com "ZapLite / segurança" no assunto.

Este é um projeto pessoal, mantido por uma pessoa só, sem programa de recompensa e sem
compromisso de SLA. O que dá para prometer: resposta em até 7 dias e crédito no
`CHANGELOG.md` se você quiser.

## O que ajuda no relato

- versão do ZapLite (Painel › **SOBRE**) e do Windows
- o que um atacante consegue fazer, concretamente, e a partir de onde
- passo a passo para reproduzir
- se for possível, o **diagnóstico** (Painel › SOBRE › *copiar diagnóstico*) — ele já
  redige chaves, contatos e conteúdo de conversa

**Nunca** anexe sua chave de API, seu `settings.json` bruto, um `connection.log` bruto ou
capturas com conversas visíveis. Se o problema exigir esse tipo de dado, diga isso no
relato e combinamos o caminho antes de você enviar qualquer coisa.

## Superfície que mais importa

Se você for procurar, estes são os pontos onde uma falha dói de verdade:

- **A fronteira entre a janela remota e o Rust.** A janela principal carrega
  `web.whatsapp.com`, ou seja, código de terceiro. Qualquer comando alcançável dali é
  alcançável por um script injetado na página (XSS, CDN comprometido, extensão do
  navegador). O ACL está em `src-tauri/capabilities/remote-whatsapp.json` e a lista de
  comandos em `src-tauri/build.rs`.
- **Vazamento da chave de API.** `load_settings` só pode ser chamado pela janela local do
  Painel; a janela remota tem `load_settings_public`, limitado pela constante
  `CHAVES_PUBLICAS` em `src-tauri/src/lib.rs`. Uma chave sensível que escape por essa
  allowlist é bug de segurança.
- **A cadeia de atualização.** O instalador é baixado de um domínio comum; o que o protege
  é a assinatura verificada contra a chave pública embutida em
  `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). Qualquer caminho que instale um
  binário sem essa verificação é bug de segurança.
- **A redação do diagnóstico** (`src-tauri/src/diagnostico.rs`). Ele é feito para ser
  colado em e-mail e issue: se algum dado sensível sobreviver à redação — chave, número,
  identificador de conversa, texto de mensagem — isso é bug de segurança, não cosmético.

## O que está fora de escopo

- O **risco de banimento da conta**: é conhecido, está documentado no README e é inerente a
  um cliente não oficial. Não é vulnerabilidade.
- O **aviso do SmartScreen**: o instalador não é assinado por certificado de código, e isso
  está dito no README.
- Falhas do próprio WhatsApp Web: reporte à Meta.
