/*! P1..P4 — links `whatsapp://` abrindo no ZapLite.

   O caminho inteiro, de ponta a ponta:

     navegador → Windows → `zaplite.exe "whatsapp://send?phone=…"`
       → o plugin de instância única entrega os argv à instância VIVA
       → `rotear` interpreta, guarda o alvo e traz a janela para a frente
       → o bundle pega o alvo (`take_pending_deeplink`) e abre a conversa

   Três decisões que valem a leitura:

   * **Registro manual em `HKCU`, sem `tauri-plugin-deep-link`.** O plugin
     resolve o esquema, mas no Windows ele registra o protocolo no `setup` do
     app (ou no instalador) e não oferece nem "guardar o que havia" nem
     "devolver ao aplicativo oficial". Aqui o registro é OPT-IN, com backup
     fiel e desfazer — e isso é a funcionalidade, não um detalhe. Trinta linhas
     de `winreg` fazem exatamente isso, sob controle nosso.

   * **Nada é automático.** O ZapLite só vira handler quando o usuário aperta o
     botão no Painel. Os comandos vivem apenas na capability do Painel
     (conteúdo local): `web.whatsapp.com` não registra protocolo.

   * **O `text=` PREENCHE, nunca envia.** Regra dura do projeto. O rascunho nem
     sequer viaja na URL para a qual navegamos — quem o escreve na caixa é o
     bundle, com `insertText`, sem nenhum `Enter` em lugar nenhum.
*/

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// Um pedido velho não abre conversa do nada. Mesma ideia do `PEDIDO_CHAT_TTL`
/// do Y2, com folga maior: aqui o app pode estar SUBINDO do zero (processo
/// novo + WhatsApp Web carregando), e isso leva bem mais que um clique em toast.
const PENDENTE_TTL: Duration = Duration::from_secs(180);

/// Teto do rascunho. O texto vem de FORA do app (quem escreveu o link) — sem
/// teto, um `text=` de megabytes viraria uma colagem gigante na caixa.
const TEXTO_MAX: usize = 4096;

// ===========================================================================
// Interpretação da URL  (P3)
// ===========================================================================

/// O que um link pede. Já **saneado**: `phone` é só dígitos e já passou pela
/// validação, `code` é só alfanumérico, `text` já perdeu os controles.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Alvo {
    /// telefone em dígitos, sem `+` e sem separadores. Vazio quando não há.
    pub phone: String,
    /// código de convite de grupo. Vazio quando não há.
    pub code: String,
    /// rascunho para a caixa de mensagem. NUNCA enviado. Vazio quando não há.
    pub text: String,
}

impl Alvo {
    /// Um alvo sem telefone e sem código não abre nada — e um "abrir nada" que
    /// atravessa o sistema todo é justamente o que vira janela em branco.
    fn utilizavel(&self) -> bool {
        !self.phone.is_empty() || !self.code.is_empty()
    }
}

fn hex(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// `%XX` e `+`. Byte inválido não estoura nem some: fica o `%` literal, que é
/// o que um decodificador tolerante faz. UTF-8 quebrado vira `U+FFFD` em vez
/// de erro — o texto é de EXIBIÇÃO, não tem por que derrubar a abertura.
fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < b.len() => match (hex(b[i + 1]), hex(b[i + 2])) {
                (Some(h), Some(l)) => {
                    out.push(h * 16 + l);
                    i += 3;
                }
                _ => {
                    out.push(b'%');
                    i += 1;
                }
            },
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Valor de um parâmetro da query, já decodificado. Chave sem `=` conta como
/// vazia; chave repetida devolve a PRIMEIRA (a última seria mais fácil de
/// injetar com um `&phone=` extra grudado no fim de um link legítimo).
fn param(query: &str, chave: &str) -> Option<String> {
    for par in query.split('&') {
        let (k, v) = match par.split_once('=') {
            Some((k, v)) => (k, v),
            None => (par, ""),
        };
        if k.trim().eq_ignore_ascii_case(chave) {
            return Some(pct_decode(v));
        }
    }
    None
}

/// Telefone utilizável a partir de qualquer coisa que veio de fora.
///
/// Só dígitos — `+`, espaço, hífen, parêntese e o que mais o autor do link
/// tiver escrito caem fora. Depois VALIDA: E.164 tem no máximo 15 dígitos, e
/// abaixo de 8 não existe número internacional discável. Fora da faixa devolve
/// `None`, e `None` aqui significa "não abre conversa nenhuma" — não
/// "abre com o que sobrou".
fn sanear_telefone(bruto: &str) -> Option<String> {
    let so_digitos: String = bruto.chars().filter(|c| c.is_ascii_digit()).collect();
    if (8..=15).contains(&so_digitos.len()) {
        Some(so_digitos)
    } else {
        None
    }
}

/// Código de convite de grupo. Alfanumérico ASCII (mais `-` e `_`, que
/// aparecem em códigos base64url). Qualquer outro caractere invalida o código
/// inteiro em vez de ser removido: um código "consertado" abriria um convite
/// que não é o do link.
fn sanear_codigo(bruto: &str) -> Option<String> {
    let b = bruto.trim();
    if b.is_empty() || b.len() > 64 {
        return None;
    }
    if b.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Some(b.to_string())
    } else {
        None
    }
}

/// Rascunho vindo de fora. Sai o que não é texto de mensagem: controles (menos
/// `\n` e `\t`) e o BOM. Depois, teto de caracteres.
fn sanear_texto(bruto: &str) -> String {
    bruto
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .filter(|c| *c != '\u{feff}')
        .take(TEXTO_MAX)
        .collect()
}

/// `whatsapp://send?phone=…[&text=…]` e `whatsapp://chat?code=…`.
///
/// Devolve `None` para tudo que não abre conversa: outro esquema, ação
/// desconhecida, telefone que não passa na validação, `text=` sozinho. `None`
/// é o caminho SEGURO — quem chama não navega, não abre janela, não faz nada.
pub fn parse_whatsapp_url(url: &str) -> Option<Alvo> {
    let u = url.trim();
    // O esquema pode chegar em qualquer caixa (`WhatsApp://`); o resto não é
    // normalizado, porque `text=` distingue maiúsculas.
    let resto = if u.len() >= 11 && u[..11].eq_ignore_ascii_case("whatsapp://") {
        &u[11..]
    } else {
        return None;
    };
    // O Windows costuma entregar a URL com um `/` sobrando no fim quando não
    // há query nenhuma; e há gerador que escreve `send/?phone=`.
    let (caminho, query) = match resto.split_once('?') {
        Some((c, q)) => (c, q),
        None => (resto, ""),
    };
    let acao = caminho.trim_end_matches('/').trim().to_ascii_lowercase();
    let texto = param(query, "text").map(|t| sanear_texto(&t)).unwrap_or_default();

    match acao.as_str() {
        // `send` é a forma comum; `""` cobre `whatsapp://?phone=…`.
        "send" | "" => {
            let phone = sanear_telefone(&param(query, "phone")?)?;
            Some(Alvo { phone, code: String::new(), text: texto })
        }
        "chat" => {
            // `chat` aceita as duas: convite de grupo (`code`) e telefone.
            if let Some(c) = param(query, "code").and_then(|c| sanear_codigo(&c)) {
                return Some(Alvo { phone: String::new(), code: c, text: texto });
            }
            let phone = sanear_telefone(&param(query, "phone")?)?;
            Some(Alvo { phone, code: String::new(), text: texto })
        }
        _ => None,
    }
}

/// Extrai a URL `whatsapp://` de uma linha de comando. Ignora `argv[0]` (o
/// caminho do próprio exe) e qualquer coisa que não seja o nosso esquema —
/// argumento de outra natureza não vira alvo.
pub fn url_dos_args(args: &[String]) -> Option<String> {
    args.iter()
        .skip(1)
        .find(|a| a.trim().len() >= 11 && a.trim()[..11].eq_ignore_ascii_case("whatsapp://"))
        .map(|a| a.trim().to_string())
}

// ===========================================================================
// Pedido pendente + roteamento  (P2)
// ===========================================================================

/// O alvo esperando a página. Mesma razão do `pedido_chat` do Y2: o `emit` do
/// Tauri não tem buffer, e no arranque a frio a página nem existe ainda.
#[derive(Default)]
pub struct DeepLinkState {
    pendente: Mutex<Option<(Alvo, Instant)>>,
}

/// Guarda o alvo. Substitui um pendente anterior: dois cliques seguidos querem
/// o SEGUNDO link, não o primeiro.
pub fn guardar(app: &AppHandle, alvo: Alvo) {
    let st = app.state::<DeepLinkState>();
    *st.pendente.lock().unwrap() = Some((alvo, Instant::now()));
}

/// Uma URL chegou pela linha de comando com o app JÁ VIVO (segunda invocação).
/// Guarda, traz a janela para a frente e avisa a página. Se a URL não valer
/// nada, o app só registra e segue — não abre janela, não navega, não estoura.
pub fn rotear(app: &AppHandle, url: &str) {
    let alvo = match parse_whatsapp_url(url) {
        Some(a) if a.utilizavel() => a,
        _ => {
            crate::connection::note_window_event(app, &format!("link whatsapp:// ignorado (não interpretável): {url}"));
            return;
        }
    };
    crate::connection::note_window_event(
        app,
        &format!(
            "link whatsapp:// recebido pela instância viva (phone={}, code={}, rascunho={} carac.)",
            if alvo.phone.is_empty() { "-" } else { &alvo.phone },
            if alvo.code.is_empty() { "-" } else { &alvo.code },
            alvo.text.chars().count()
        ),
    );
    guardar(app, alvo.clone());
    // A janela vem para a frente ANTES do evento: se a página estiver no meio
    // de uma recuperação e o evento se perder, pelo menos o usuário vê o app.
    crate::focar_janela_principal(app);
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("zaplite://deep-link", &alvo);
    }
}

/// A página pergunta se há alvo esperando. Consome (um link abre uma conversa,
/// não uma por reload) e descarta o que passou do TTL.
#[tauri::command]
pub fn take_pending_deeplink(app: AppHandle) -> Option<Alvo> {
    let st = app.state::<DeepLinkState>();
    let mut p = st.pendente.lock().unwrap();
    match p.take() {
        Some((alvo, quando)) if quando.elapsed() <= PENDENTE_TTL => Some(alvo),
        _ => None,
    }
}

// ===========================================================================
// Registro do protocolo em HKCU  (P1)
// ===========================================================================

use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
use winreg::RegKey;

/// `HKCU` e só. Nada de `HKLM`: registro por usuário não pede elevação e não
/// muda o Windows de mais ninguém na máquina.
const CHAVE_PROTO: &str = r"Software\Classes\whatsapp";
const CHAVE_ZAPLITE: &str = r"Software\ZapLite";
/// ProgId próprio + "Programas Padrão". MEDIDO nesta máquina (21/08/2026): o
/// WhatsApp oficial é o pacote da Microsoft Store
/// (`5319275A.51895FA4EA97F_…`), e um app EMPACOTADO declara o esquema no
/// repositório de estado do Windows, não no registro. Efeito medido: com
/// `HKCU\Software\Classes\whatsapp\shell\open\command` apontando para o
/// zaplite.exe, `AssocQueryString(ASSOCSTR_COMMAND)` ainda devolvia
/// `0x80070483` (sem associação) e `ASSOCSTR_FRIENDLYAPPNAME` devolvia
/// "WhatsApp Beta" — ou seja, o shell resolvia pelo pacote e ignorava a chave
/// clássica. Um esquema de controle (`zaplite-sonda://`), que ninguém disputa,
/// foi entregue ao ZapLite pela MESMA chave, na mesma máquina: o que falta não
/// é a chave, é a POSSE do esquema.
///
/// Trocar a posse exige um `UserChoice`, cujo `Hash` é calculado por um
/// algoritmo não documentado da Microsoft — é justamente a trava que impede um
/// programa de sequestrar o padrão sem o usuário. Então o caminho suportado é
/// este: registrar o ZapLite em "Programas Padrão", que é o que o coloca na
/// lista de Configurações → Aplicativos → Aplicativos padrão para "links
/// whatsapp". A escolha continua sendo um ato do usuário, que é como tem que
/// ser. Em máquina onde o WhatsApp oficial é o instalador Win32 clássico (sem
/// pacote), a chave de `Software\Classes\whatsapp` sozinha já resolve.
const PROGID: &str = "ZapLite.whatsapp";
const CHAVE_PROGID: &str = r"Software\Classes\ZapLite.whatsapp";
const CHAVE_CAPS: &str = r"Software\ZapLite\Capabilities";
const CHAVE_REGAPPS: &str = r"Software\RegisteredApplications";
/// Onde o retrato do que havia antes fica guardado (JSON, como REG_SZ).
const VALOR_BACKUP: &str = "ProtocolBackup";
/// Carimbo dentro da própria chave do protocolo: é como sabemos que o handler
/// atual é NOSSO, e é o que o desinstalador confere antes de apagar (ver
/// `nsis/hooks.nsh`). Guarda o caminho do exe — serve de marca e de conferência.
const MARCA: &str = "ZapLite";

/// Retrato fiel de uma chave do registro. Só valores de texto: um protocolo é
/// feito de strings, e restaurar "quase" seria pior que restaurar nada.
#[derive(Default, Serialize, Deserialize)]
struct No {
    valores: Vec<(String, String)>,
    filhos: Vec<(String, No)>,
}

#[derive(Serialize, Deserialize)]
struct Backup {
    /// A chave existia antes de mexermos? Se NÃO, restaurar é APAGAR — deixar
    /// uma chave vazia para trás é o "lixo" que o pedido proíbe.
    existia: bool,
    raiz: No,
}

fn hkcu() -> RegKey {
    RegKey::predef(HKEY_CURRENT_USER)
}

fn ler_no(k: &RegKey) -> No {
    let mut n = No::default();
    for v in k.enum_values().flatten() {
        if let Ok(s) = k.get_value::<String, _>(&v.0) {
            n.valores.push((v.0, s));
        }
    }
    for nome in k.enum_keys().flatten() {
        if let Ok(sub) = k.open_subkey(&nome) {
            n.filhos.push((nome, ler_no(&sub)));
        }
    }
    n
}

fn escrever_no(k: &RegKey, n: &No) -> Result<(), String> {
    for (nome, val) in &n.valores {
        k.set_value(nome, val).map_err(|e| e.to_string())?;
    }
    for (nome, filho) in &n.filhos {
        let (sub, _) = k.create_subkey(nome).map_err(|e| e.to_string())?;
        escrever_no(&sub, filho)?;
    }
    Ok(())
}

/// Apaga a árvore inteira, tolerando "não existia".
fn apagar_arvore(caminho: &str) -> Result<(), String> {
    match hkcu().delete_subkey_all(caminho) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn exe_atual() -> Result<String, String> {
    std::env::current_exe()
        .map_err(|e| e.to_string())
        .map(|p| p.to_string_lossy().into_owned())
}

/// O que responde por `whatsapp://` agora, do jeito que o Painel precisa
/// mostrar. `descricao` é a frase que aparece na tela — em português claro,
/// porque "quem responde pelo esquema" é exatamente a dúvida do usuário.
#[derive(Serialize)]
pub struct EstadoProtocolo {
    /// o handler atual é ESTE ZapLite
    pub registrado: bool,
    /// `shell\open\command` que está lá agora ("" quando não há nenhum)
    pub comando: String,
    pub descricao: String,
    /// há retrato do estado anterior guardado (ou seja, dá para devolver)
    pub tem_backup: bool,
    pub exe: String,
}

fn comando_atual() -> String {
    hkcu()
        .open_subkey_with_flags(format!(r"{CHAVE_PROTO}\shell\open\command"), KEY_READ)
        .and_then(|k| k.get_value::<String, _>(""))
        .unwrap_or_default()
}

fn marca_atual() -> Option<String> {
    hkcu()
        .open_subkey_with_flags(CHAVE_PROTO, KEY_READ)
        .and_then(|k| k.get_value::<String, _>(MARCA))
        .ok()
}

fn tem_backup() -> bool {
    hkcu()
        .open_subkey_with_flags(CHAVE_ZAPLITE, KEY_READ)
        .and_then(|k| k.get_value::<String, _>(VALOR_BACKUP))
        .is_ok()
}

pub fn estado() -> EstadoProtocolo {
    let exe = exe_atual().unwrap_or_default();
    let comando = comando_atual();
    let marca = marca_atual();
    let chave_existe = hkcu().open_subkey_with_flags(CHAVE_PROTO, KEY_READ).is_ok();
    let nosso = marca.is_some();
    // "nosso, mas de OUTRA instalação" é um estado real: o usuário reinstalou
    // o ZapLite em outra pasta e a chave ficou apontando para o exe antigo.
    let mesma_instalacao = marca.as_deref() == Some(exe.as_str());

    let descricao = if nosso && mesma_instalacao {
        // Honestidade sobre o limite MEDIDO: se o WhatsApp oficial for o app
        // da Microsoft Store, ele declara o esquema no repositório de estado do
        // Windows e ganha do registro clássico. Prometer no Painel que "agora é
        // o ZapLite" e o usuário ver o app oficial abrir seria pior que não ter
        // o botão. Ver o comentário do `PROGID`.
        "O ZapLite está registrado para os links whatsapp:// (este ZapLite). \
         Se o WhatsApp oficial for o aplicativo da Microsoft Store, o Windows ainda pode \
         preferi-lo: nesse caso abra Configurações → Aplicativos → Aplicativos padrão, \
         procure ZapLite e escolha-o para \"links whatsapp\". Essa escolha é sua, e só sua — \
         nenhum programa pode fazê-la por você."
            .to_string()
    } else if nosso {
        format!(
            "Um ZapLite responde pelos links whatsapp://, mas é OUTRA instalação: {}. \
             Ligue de novo aqui para apontar para este ZapLite.",
            marca.unwrap_or_default()
        )
    } else if !comando.is_empty() {
        format!("Outro programa responde pelos links whatsapp://: {comando}")
    } else if chave_existe {
        "O aplicativo oficial do WhatsApp responde pelos links whatsapp:// \
         (registro da Microsoft Store, sem linha de comando própria)."
            .to_string()
    } else {
        "Nenhum programa está registrado para links whatsapp:// nesta conta do Windows.".to_string()
    };

    EstadoProtocolo { registrado: nosso && mesma_instalacao, comando, descricao, tem_backup: tem_backup(), exe }
}

/// Liga o registro. **Só o botão do Painel chega aqui.**
///
/// O retrato do estado anterior é tirado UMA vez: chamar de novo (por exemplo
/// depois de mover o exe) reaponta o comando sem sobrescrever o backup — senão
/// o "devolver ao oficial" passaria a restaurar o ZapLite em cima do ZapLite.
pub fn registrar() -> Result<EstadoProtocolo, String> {
    let exe = exe_atual()?;

    if !tem_backup() {
        let raiz = match hkcu().open_subkey_with_flags(CHAVE_PROTO, KEY_READ) {
            Ok(k) => ler_no(&k),
            Err(_) => No::default(),
        };
        let existia = hkcu().open_subkey_with_flags(CHAVE_PROTO, KEY_READ).is_ok();
        let json = serde_json::to_string(&Backup { existia, raiz }).map_err(|e| e.to_string())?;
        let (zl, _) = hkcu().create_subkey(CHAVE_ZAPLITE).map_err(|e| e.to_string())?;
        zl.set_value(VALOR_BACKUP, &json).map_err(|e| e.to_string())?;
        // Migalhas que o NSIS consegue ler sem interpretar JSON — ver
        // `nsis/hooks.nsh`. O desinstalador não tem parser, então o que ele
        // precisa restaurar fica também em valores simples.
        zl.set_value("ProtocolBackupExistia", &(if existia { 1u32 } else { 0u32 }))
            .map_err(|e| e.to_string())?;
        zl.set_value("ProtocolBackupDefault", &valor_de(CHAVE_PROTO, ""))
            .map_err(|e| e.to_string())?;
        zl.set_value("ProtocolBackupUrlProtocol", &valor_de(CHAVE_PROTO, "URL Protocol"))
            .map_err(|e| e.to_string())?;
        zl.set_value("ProtocolBackupCommand", &comando_atual()).map_err(|e| e.to_string())?;
    }

    // Do zero: sobrescrever por cima deixaria subchaves do handler anterior
    // convivendo com as nossas.
    apagar_arvore(CHAVE_PROTO)?;
    let (proto, _) = hkcu().create_subkey(CHAVE_PROTO).map_err(|e| e.to_string())?;
    proto.set_value("", &"URL:WhatsApp (ZapLite)").map_err(|e| e.to_string())?;
    // Valor VAZIO e presente: é assim que o shell reconhece um esquema de URL.
    proto.set_value("URL Protocol", &"").map_err(|e| e.to_string())?;
    proto.set_value(MARCA, &exe).map_err(|e| e.to_string())?;
    let (icone, _) = proto.create_subkey("DefaultIcon").map_err(|e| e.to_string())?;
    icone.set_value("", &format!("\"{exe}\",0")).map_err(|e| e.to_string())?;
    let (cmd, _) = proto.create_subkey(r"shell\open\command").map_err(|e| e.to_string())?;
    // `"%1"` entre aspas: sem elas, uma URL com espaço vira dois argumentos.
    cmd.set_value("", &format!("\"{exe}\" \"%1\"")).map_err(|e| e.to_string())?;

    registrar_programa_padrao(&exe)?;
    Ok(estado())
}

/// "Programas Padrão": o que faz o ZapLite APARECER em Configurações →
/// Aplicativos → Aplicativos padrão como opção para "links whatsapp". Sem
/// isto, numa máquina onde o WhatsApp oficial é o app da Store, o usuário não
/// tem nem como escolher o ZapLite — ver o comentário do `PROGID`.
///
/// Tudo aqui é NOSSO (ProgId próprio, capacidades próprias, um valor com o
/// nosso nome em `RegisteredApplications`): não há estado de terceiro para
/// guardar, e `restaurar` apaga exatamente o que este bloco criou.
fn registrar_programa_padrao(exe: &str) -> Result<(), String> {
    let (progid, _) = hkcu().create_subkey(CHAVE_PROGID).map_err(|e| e.to_string())?;
    progid.set_value("", &"Conversa do WhatsApp (ZapLite)").map_err(|e| e.to_string())?;
    let (icone, _) = progid.create_subkey("DefaultIcon").map_err(|e| e.to_string())?;
    icone.set_value("", &format!("\"{exe}\",0")).map_err(|e| e.to_string())?;
    let (pcmd, _) = progid.create_subkey(r"shell\open\command").map_err(|e| e.to_string())?;
    pcmd.set_value("", &format!("\"{exe}\" \"%1\"")).map_err(|e| e.to_string())?;

    let (caps, _) = hkcu().create_subkey(CHAVE_CAPS).map_err(|e| e.to_string())?;
    caps.set_value("ApplicationName", &"ZapLite").map_err(|e| e.to_string())?;
    caps.set_value(
        "ApplicationDescription",
        &"Cliente leve do WhatsApp Web. Abre links de conversa na janela que já está aberta.",
    )
    .map_err(|e| e.to_string())?;
    let (urls, _) = caps.create_subkey("URLAssociations").map_err(|e| e.to_string())?;
    urls.set_value("whatsapp", &PROGID).map_err(|e| e.to_string())?;

    let (regapps, _) = hkcu().create_subkey(CHAVE_REGAPPS).map_err(|e| e.to_string())?;
    // Chave COMPARTILHADA com outros programas: aqui só se ACRESCENTA um valor
    // com o nosso nome. Apagar a chave inteira tiraria o Firefox, o Thunderbird
    // e quem mais estiver registrado da lista de aplicativos padrão.
    regapps.set_value("ZapLite", &CHAVE_CAPS).map_err(|e| e.to_string())?;
    Ok(())
}

/// Desfaz o `registrar_programa_padrao`. Nada aqui é de terceiro: some o nosso
/// ProgId, some o nosso ramo de capacidades e some **o nosso valor** dentro de
/// `RegisteredApplications` — a chave em si fica, porque é de todo mundo.
fn desregistrar_programa_padrao() {
    let _ = apagar_arvore(CHAVE_PROGID);
    let _ = apagar_arvore(CHAVE_CAPS);
    if let Ok(regapps) = hkcu().open_subkey_with_flags(CHAVE_REGAPPS, winreg::enums::KEY_ALL_ACCESS) {
        let _ = regapps.delete_value("ZapLite");
    }
}

fn valor_de(caminho: &str, nome: &str) -> String {
    hkcu()
        .open_subkey_with_flags(caminho, KEY_READ)
        .and_then(|k| k.get_value::<String, _>(nome))
        .unwrap_or_default()
}

/// Devolve `whatsapp://` a quem respondia antes — exatamente ao que havia.
/// Se não havia chave nenhuma, APAGA em vez de deixar uma casca vazia.
pub fn restaurar() -> Result<EstadoProtocolo, String> {
    desregistrar_programa_padrao();
    let bkp: Option<Backup> = hkcu()
        .open_subkey_with_flags(CHAVE_ZAPLITE, KEY_READ)
        .and_then(|k| k.get_value::<String, _>(VALOR_BACKUP))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());

    match bkp {
        Some(b) => {
            apagar_arvore(CHAVE_PROTO)?;
            if b.existia {
                let (proto, _) = hkcu().create_subkey(CHAVE_PROTO).map_err(|e| e.to_string())?;
                escrever_no(&proto, &b.raiz)?;
            }
        }
        None => {
            // Sem retrato: só mexe se a chave for comprovadamente NOSSA. Sem a
            // marca, não tocamos no registro de terceiro.
            if marca_atual().is_some() {
                apagar_arvore(CHAVE_PROTO)?;
            }
        }
    }

    // O backup só some depois de a restauração ter dado certo.
    if let Ok(zl) = hkcu().open_subkey_with_flags(CHAVE_ZAPLITE, winreg::enums::KEY_ALL_ACCESS) {
        for v in [VALOR_BACKUP, "ProtocolBackupExistia", "ProtocolBackupDefault", "ProtocolBackupUrlProtocol", "ProtocolBackupCommand"] {
            let _ = zl.delete_value(v);
        }
    }
    // Se a nossa chave ficou vazia, ela também vai embora.
    if let Ok(zl) = hkcu().open_subkey_with_flags(CHAVE_ZAPLITE, KEY_READ) {
        if zl.enum_values().flatten().count() == 0 && zl.enum_keys().flatten().count() == 0 {
            let _ = apagar_arvore(CHAVE_ZAPLITE);
        }
    }
    Ok(estado())
}

/// O exe se mudou de lugar e o registro ficou apontando para o caminho antigo?
/// Chamado no `setup`. **Não liga nada**: só corrige um registro que o usuário
/// JÁ tinha ligado, e que sem isto mandaria o Windows abrir um exe inexistente.
pub fn reapontar_se_preciso(app: &AppHandle) {
    let exe = match exe_atual() {
        Ok(e) => e,
        Err(_) => return,
    };
    match marca_atual() {
        Some(m) if m != exe => {
            if registrar().is_ok() {
                crate::connection::note_window_event(
                    app,
                    &format!("registro de whatsapp:// reapontado de '{m}' para '{exe}'"),
                );
            }
        }
        _ => {}
    }
}

// ===========================================================================
// Comandos — SÓ a capability do Painel os cita (ver capabilities/default.json)
// ===========================================================================

#[tauri::command]
pub fn protocolo_status() -> EstadoProtocolo {
    estado()
}

#[tauri::command]
pub fn protocolo_registrar(app: AppHandle) -> Result<EstadoProtocolo, String> {
    let r = registrar();
    crate::connection::note_window_event(
        app.app_handle(),
        &match &r {
            Ok(_) => "ZapLite registrado como handler de whatsapp:// (HKCU)".to_string(),
            Err(e) => format!("falha ao registrar whatsapp://: {e}"),
        },
    );
    r
}

#[tauri::command]
pub fn protocolo_restaurar(app: AppHandle) -> Result<EstadoProtocolo, String> {
    let r = restaurar();
    crate::connection::note_window_event(
        app.app_handle(),
        &match &r {
            Ok(e) => format!("registro de whatsapp:// devolvido ao estado anterior ({})", e.descricao),
            Err(e) => format!("falha ao devolver o registro de whatsapp://: {e}"),
        },
    );
    r
}

// ===========================================================================

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn formas_usuais_do_link_abrem_a_conversa_certa() {
        let a = parse_whatsapp_url("whatsapp://send?phone=5511999998888").unwrap();
        assert_eq!(a.phone, "5511999998888");
        assert!(a.text.is_empty() && a.code.is_empty());

        // `+`, espaço e parêntese são decoração humana, não parte do número.
        let a = parse_whatsapp_url("whatsapp://send?phone=%2B55%20(11)%2099999-8888").unwrap();
        assert_eq!(a.phone, "5511999998888");

        // rascunho decodificado, com o `+` da query virando espaço
        let a = parse_whatsapp_url("whatsapp://send?phone=5511999998888&text=oi+bom%20dia").unwrap();
        assert_eq!(a.text, "oi bom dia");

        let a = parse_whatsapp_url("whatsapp://chat?code=ABCdef123-_x").unwrap();
        assert_eq!(a.code, "ABCdef123-_x");
        assert!(a.phone.is_empty());

        // esquema em outra caixa e barra sobrando continuam sendo o mesmo link
        assert_eq!(
            parse_whatsapp_url("WhatsApp://send/?phone=5511999998888").unwrap().phone,
            "5511999998888"
        );
    }

    #[test]
    fn url_malformada_devolve_none_em_vez_de_abrir_qualquer_coisa() {
        // P3: nada aqui pode virar "abre com o que sobrou". `None` é o caminho
        // seguro — quem chama não navega e não abre janela.
        for u in [
            "",
            "whatsapp://",
            "whatsapp://send",                       // sem phone
            "whatsapp://send?text=oi",               // rascunho sem destino
            "whatsapp://send?phone=",                // vazio
            "whatsapp://send?phone=abc",             // sem dígito nenhum
            "whatsapp://send?phone=123",             // curto demais
            "whatsapp://send?phone=1234567890123456789", // longo demais (>15)
            "whatsapp://apagar?phone=5511999998888", // ação desconhecida
            "https://web.whatsapp.com/send?phone=5511999998888", // outro esquema
            "javascript:alert(1)",
            "whatsapp://chat?code=../../etc",        // código com caractere fora da faixa
        ] {
            assert!(parse_whatsapp_url(u).is_none(), "deveria recusar: {u}");
        }
    }

    #[test]
    fn o_texto_do_link_e_tratado_como_hostil() {
        // O `text=` vem de FORA do app: de uma página, de um e-mail, de um QR.
        // Controles fora (senão colam CR/NUL na caixa) e teto de tamanho.
        let a = parse_whatsapp_url("whatsapp://send?phone=5511999998888&text=a%00b%0Dc%0Ad").unwrap();
        assert_eq!(a.text, "abc\nd");

        let gigante = "x".repeat(TEXTO_MAX * 3);
        let a = parse_whatsapp_url(&format!("whatsapp://send?phone=5511999998888&text={gigante}")).unwrap();
        assert_eq!(a.text.chars().count(), TEXTO_MAX);

        // `phone` repetido: vale o PRIMEIRO. Grudar `&phone=…` no fim de um
        // link legítimo não troca o destinatário.
        let a = parse_whatsapp_url("whatsapp://send?phone=5511999998888&phone=5511000000000").unwrap();
        assert_eq!(a.phone, "5511999998888");
    }

    #[test]
    fn so_o_nosso_esquema_vira_alvo_na_linha_de_comando() {
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        // argv[0] é o exe; nunca um alvo, mesmo que o caminho contenha o texto.
        assert_eq!(url_dos_args(&args(&["C:\\whatsapp://x\\zaplite.exe"])), None);
        assert_eq!(
            url_dos_args(&args(&["zaplite.exe", "whatsapp://send?phone=5511999998888"])).as_deref(),
            Some("whatsapp://send?phone=5511999998888")
        );
        // argumento de outra natureza não vira alvo
        assert_eq!(url_dos_args(&args(&["zaplite.exe", "--debug", "https://exemplo.com"])), None);
    }

    #[test]
    fn alvo_sem_destino_nao_e_utilizavel() {
        assert!(!Alvo::default().utilizavel());
        assert!(!Alvo { text: "oi".into(), ..Default::default() }.utilizavel());
        assert!(Alvo { phone: "5511999998888".into(), ..Default::default() }.utilizavel());
        assert!(Alvo { code: "abc".into(), ..Default::default() }.utilizavel());
    }

    /// O retrato do registro tem que voltar IGUAL — inclusive o caso real desta
    /// máquina, em que a chave existe só com `URL Protocol` e sem `shell`.
    #[test]
    fn o_retrato_do_registro_reproduz_a_chave_original() {
        let original = No {
            valores: vec![("".into(), "URL:whatsapp".into()), ("URL Protocol".into(), "".into())],
            filhos: vec![],
        };
        let json = serde_json::to_string(&Backup { existia: true, raiz: original }).unwrap();
        let volta: Backup = serde_json::from_str(&json).unwrap();
        assert!(volta.existia);
        assert_eq!(volta.raiz.valores.len(), 2);
        assert_eq!(volta.raiz.valores[0].1, "URL:whatsapp");
        assert!(volta.raiz.filhos.is_empty());

        // E o caso "não havia nada": restaurar é APAGAR, não recriar vazio.
        let json = serde_json::to_string(&Backup { existia: false, raiz: No::default() }).unwrap();
        let volta: Backup = serde_json::from_str(&json).unwrap();
        assert!(!volta.existia);
    }
}
