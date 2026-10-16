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

## 0.1.10

Correções nas notificações.

* Abrir uma conversa que você ainda não leu não toca mais o alerta: o som é só para a mensagem que chega na hora.
* "Digitando…" e "gravando áudio…" não viram mais notificação, e quando a digitação termina a mesma mensagem não é avisada de novo.
* Em grupos silenciados, ser mencionado avisa a menção, mas não transforma as mensagens seguintes em notificações.

## 0.1.9

Cinco temas novos, mais modernos.

* **Nebulosa** (índigo e lavanda), **Oceano** (azul-marinho e verde-azulado), **Jardim** (creme e verde, com nomes em serifa), **Entardecer** (coral e laranja) e **Minimal** (monocromático). Cada um tem versão clara e escura e vale também para as janelas de notificação.

## 0.1.8

IA sem chave de API.

* Novo provedor **ChatGPT**: entre com sua conta Plus ou Pro pelo login oficial da OpenAI ("Sign in with ChatGPT") e os recursos de IA usam a cota do seu plano. O login abre no navegador do sistema; o token fica cifrado no Windows e nunca passa pela janela do WhatsApp. Ao atingir o limite do plano, o ZapLite avisa e não insiste.
* **Gemini grátis**: botão "Obter chave grátis no Google AI Studio", que abre a página da chave para você colar no Painel. A cota gratuita do Google não pede cartão.
* Quatro temas novos em Personalização, cada um com cor, fonte e efeitos próprios e com versão **clara e escura** (no automático, seguem o tema do próprio WhatsApp): **Vidro Líquido** (camadas de vidro e aurora), **Brutal** (bordas grossas e sombra dura), **Terminal** (CRT de fósforo verde no escuro, visor LCD no claro) e **ICQ 2000** (Windows 2000, Tahoma), este com som de tecla ao digitar, de borracha ao apagar e "oh-oh" quando chega mensagem. Os sons vêm sintetizados pelo ZapLite, e dá para trocar cada um por um arquivo de áudio seu.
* As janelas de notificação seguem o tema escolhido (claro ou escuro), com a mesma fonte e as mesmas cores.
* No tema ICQ, cada mensagem toca um som só: se o contato tem uma regra com som próprio, vale o dele; senão, a notificação toca o "oh-oh".
* A IA passa a chamar cada pessoa pelo nome que você salvou (e não "Contato"), e fotos, áudios e vídeos aparecem como "[imagem]", "[áudio]"… com a legenda, em vez de um "?" solto.
* O botão de nota no topo da conversa não fica mais em cima do nome do contato.
* "Modelo para imagem" virou uma escolha: o padrão é usar o mesmo modelo do texto, e dá para escolher outro da lista do provedor (ou digitar um nome). Vale para todos os provedores, e cada provedor lembra a sua escolha.
* Claude Desktop: o Painel mostra quais conversas recentes da sua lista ainda não estão no arquivo local. Com o módulo "Arquivo local para o Claude" ligado, basta abrir cada uma uma vez; dali em diante ela se atualiza sozinha.
* Claude e Gemini não ganharam "entrar com a conta" de propósito: Anthropic e Google proíbem usar o login da assinatura em apps de terceiros, e o Google já bloqueou contas por isso.

## 0.1.7

Esta versão deixa as operações mais seguras e leves no uso diário.

* Respostas assistidas agora mostram uma prévia e confirmam a conversa antes de inserir texto.
* Salvamentos concorrentes preservam notas, lembretes e agendamentos; as chaves ficam protegidas no Windows.
* IA e transcrição ganharam fila, limites, cancelamento, deduplicação e limpeza de arquivos temporários.
* O monitoramento da tela foi compartilhado para reduzir trabalho repetido.
* O login pelo navegador do OpenRouter usa OAuth com PKCE.
* Arrastar arquivos para dentro da conversa voltou a funcionar.
* No botão direito, com um trecho selecionado, "Copiar seleção" copia só o trecho; a mensagem inteira continua em "Copiar mensagem inteira".
* "Responder com sugestão da IA", no botão direito, também confere a conversa antes de inserir; se ela mudou ou se já havia texto seu na caixa, a sugestão aparece no painel em vez de ir para a caixa.
* O modo NSFW borra mídias que chegam com a janela minimizada antes de ela voltar à tela.
* Desligar a velocidade de áudio agora remove os botões e volta os áudios à velocidade normal.
* Menos trabalho em segundo plano enquanto você digita.
* Segurança: "Abrir arquivo" agora abre direto só fotos, vídeos, áudios e documentos; outros tipos ficam no "Abrir a pasta". Os arquivos salvos pelo ZapLite são marcados como baixados da internet, para o Windows avisar ao abrir.
* Edições no Painel feitas depois de "Salvar e aplicar" (atalhos, regras de notificação) não se perdem mais.
* Nova Central de tarefas em IA & TRANSCRIÇÃO: veja e cancele pedidos de IA e transcrições em andamento.
* "Outra versão" da resposta assistida agora gera um texto novo de verdade.
* A resposta assistida funciona também em conversas abertas pela busca ou por link.
* "Resumir esta conversa" funciona em conversas longas: resume as mensagens mais recentes que cabem e avisa quantas ficaram de fora.
* Novo: o Claude Desktop pode consultar suas conversas do WhatsApp (só leitura, nada é enviado). Ligue o módulo "Arquivo local para o Claude", importe o histórico do celular se quiser, e use "Configurar no Claude Desktop" em IA & TRANSCRIÇÃO. O ZapLite só guarda o que já passou pela sua tela, nunca rola as conversas sozinho.
* Se uma chave de API guardada não puder ser aberta (configuração vinda de outro usuário ou computador), o resto da configuração continua valendo e o ZapLite avisa o que fazer.

Nenhuma mensagem é enviada automaticamente pela IA; o agendamento continua desligado por padrão.

## 0.1.6

Dezessete módulos novos: o ZapLite saiu de 14 para 31 dos 34 do catálogo.

* **Com IA**: traduzir mensagem, ler texto de imagem (OCR), analisar se algo
  parece golpe e um resumo do dia. Todos sob demanda — nada é enviado a
  modelo nenhum sem você pedir.
* **Do dia a dia**: notas por conversa, respostas rápidas (`/pix` vira texto),
  lembretes, ações em massa, exportar conversa, baixar todas as mídias,
  fixados extras além do limite do WhatsApp e busca por data, remetente e tipo.
* **Figurinhas**: criar do zero com texto e recorte, ou converter uma imagem
  da conversa. A remoção de fundo é por cor — funciona em fundo liso, e não
  é recorte inteligente.
* **Atalhos configuráveis** e **agendar mensagem** (nasce desligado: é o único
  recurso que envia sozinho, e a fila fica sempre visível).
* **Multi-conta**: perfis separados, uma conta por vez.
* O Painel separa o que funciona do que ainda não existe — e do que decidimos
  não fazer.

Correções: o Painel não abria na 0.1.5; um arquivo de configuração com marca
de codificação apagava suas preferências em silêncio; atalhos disparavam duas
vezes por tecla; e links de conversa não vão mais inteiros para o log.

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
