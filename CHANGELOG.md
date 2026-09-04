# Notas de versão do ZapLite

Este arquivo é a **fonte das notas** que aparecem no aviso de atualização.
O `npm run publicar` procura aqui a seção da versão que está em
`src-tauri/tauri.conf.json` e copia o texto para o campo `notes` do
`latest.json`.

Regras, para o aviso nunca mentir:

* Uma seção por versão, com o título exatamente `## X.Y.Z` — sem `v`, sem data
  no título, sem sufixo.
* O corpo é o texto que o usuário vai ler, em português e no tom de quem
  explica, não no tom de *commit*.
* **Se não houver seção (ou ela estiver vazia), o `latest.json` sai sem o campo
  `notes` e o aviso mostra só o número da versão.** Nada é inventado para
  preencher espaço.

<!-- Escreva a versão nova AQUI EM CIMA, logo abaixo desta linha. -->

## 0.1.5

Notificações mais configuráveis e o começo das atualizações automáticas.

* **Fixar notificação**: além de "lembrar depois" e "silenciar", cada aviso
  agora tem um botão 📌. Fixado, ele só sai quando você fecha no ✕ — nem o
  tempo nem a chegada de novos avisos derrubam.
* **Escolha o canto da tela** onde os avisos aparecem, por regra. Cada canto
  empilha por conta própria, então regras diferentes não brigam por espaço.
* **Dois formatos novos**: `painel`, maior, para ler a mensagem inteira sem
  abrir a conversa; e `mini`, de uma linha, para grupo movimentado que você
  quer só saber que chegou.
* **Tamanho e transparência** ajustáveis por regra. A transparência volta ao
  normal quando você passa o mouse.
* **Atualização automática**: a partir desta versão o ZapLite avisa quando há
  versão nova, mostra o que mudou e só instala com a sua permissão. Toda
  atualização é assinada e verificada antes de rodar.

## 0.1.4

- Atualização automática assinada: o ZapLite passa a avisar quando existe uma
  versão nova, mostrar o que mudou e instalar só quando você mandar.
- O pacote é verificado por assinatura antes de rodar. Um instalador trocado no
  caminho é recusado.
