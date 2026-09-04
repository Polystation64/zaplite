//! 28 — MULTI-CONTA.
//!
//! # O que isto é, e o que NÃO é
//!
//! O catálogo prometia "contas pessoal e trabalho **em abas**". Abas — duas
//! sessões VIVAS ao mesmo tempo — não foi entregue, e a razão é estrutural,
//! não falta de vontade. Está escrita em `MULTI_CONTA_LIMITE` logo abaixo,
//! e a descrição no Painel foi reescrita para dizer exatamente o que existe.
//!
//! O que existe: **uma conta de cada vez, com isolamento total entre elas.**
//! Criar, listar, remover e trocar. A troca reinicia o app na conta escolhida.
//!
//! # A decisão que importa: isola por PERFIL, não por chave
//!
//! Havia duas formas de não misturar os dados das contas:
//!
//!   (a) por CHAVE, tudo no mesmo `settings.json`: `{"contas": {"trabalho":
//!       {"modules": …, "contactNotes": …}}}`. Barato de implementar e
//!       **errado**: passa a existir um caminho de leitura para cada dado do
//!       app, e basta UM que esqueça de prefixar a conta para as notas do
//!       trabalho aparecerem na conta pessoal. São hoje 34 módulos, `notify`
//!       com as regras por contato, `contactNotes`, `pinExtra`, `reminders`,
//!       `quickReplies` — dezenas de caminhos, cada um uma chance de vazar.
//!       Vazamento de dado entre contas é silencioso: ninguém percebe até ver
//!       a anotação do cliente na conta pessoal.
//!
//!   (b) por PERFIL, uma árvore de diretórios por conta — é o que está aqui.
//!       `settings.json`, `connection.log` e o perfil do WebView2 saem todos
//!       de `pasta_da_conta()`. Não existe caminho de código que possa
//!       "esquecer" a conta, porque nenhum caminho de código conhece a conta:
//!       eles conhecem uma pasta. Misturar dado entre contas deixa de ser um
//!       bug possível e passa a ser impossível por construção.
//!
//! A conta `principal` resolve para **exatamente os caminhos de hoje** — a
//! mesma `app_config_dir()`, o mesmo perfil padrão do WebView2. Quem nunca
//! criar uma segunda conta não tem um único byte movido de lugar, e a sessão
//! logada que já está no disco continua onde está. Isso é requisito, não
//! detalhe: mover o perfil do WebView2 é deslogar o usuário.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

/// A conta que existe desde sempre e não pode ser removida. O nome está no
/// código, e não no `contas.json`, porque ela é a que resolve para os
/// caminhos ORIGINAIS do app — ela existe mesmo com o registro vazio ou
/// corrompido.
pub const PRINCIPAL: &str = "principal";

/// O que NÃO foi entregue, e por quê. Está aqui, em constante, para o Painel
/// mostrar o texto exato e para ninguém precisar reconstruir o raciocínio.
pub const MULTI_CONTA_LIMITE: &str = "\
Duas contas ABERTAS ao mesmo tempo não existem neste app, e a razão é estrutural:

· INSTÂNCIA ÚNICA — o guarda de instância única (tauri-plugin-single-instance) \
deriva o mutex do identificador do app (`br.com.zaplite.app`), e não aceita uma \
chave por conta. Um segundo processo do ZapLite, com qualquer argumento, é morto \
antes de abrir janela. Ele não é enfeite: sem ele, o segundo processo colidia no \
registro do atalho global e o app morria sem janela e sem uma linha de log.

· UMA JANELA `main` — o monitor de conexão, o watchdog, o `__ZAPLITE_RELOAD__` \
do Painel, os toasts e o `connection.log` são todos indexados pela janela de \
rótulo `main`. Duas janelas `main` não existem; fazer os cinco passarem a ser \
por-janela é uma reforma da camada de conexão, que é a parte do app que mais \
custou a ficar estável.

O que existe é uma conta de cada vez, com isolamento TOTAL: cada conta tem a \
própria sessão do WhatsApp (perfil do WebView2), o próprio settings.json — logo \
os próprios módulos, notas, regras de notificação, fixados extras, respostas \
rápidas, lembretes e agendamentos — e o próprio connection.log. Trocar de conta \
reinicia o ZapLite na conta escolhida.";

/// Uma conta no registro. Só isto: o resto mora na pasta dela.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Conta {
    /// Nome de pasta: `[a-z0-9-]`, curto. Nunca muda.
    pub slug: String,
    /// O que o usuário lê. Pode mudar sem mexer em disco nenhum.
    pub rotulo: String,
}

/* --------------------------------------------------------------------------
   Slug — o nome que vira PASTA. Vem de texto que o usuário digita, então a
   sanitização é de segurança, não de estética: um `..` ou uma barra aqui
   escapariam da pasta do app.
   -------------------------------------------------------------------------- */

/// PURA e testada. Devolve `None` quando não sobra nada utilizável.
pub fn slug_de(rotulo: &str) -> Option<String> {
    let mut s = String::new();
    for c in rotulo.trim().to_lowercase().chars() {
        let c = match c {
            'á' | 'à' | 'â' | 'ã' | 'ä' => 'a',
            'é' | 'ê' | 'ë' => 'e',
            'í' | 'ï' => 'i',
            'ó' | 'ô' | 'õ' | 'ö' => 'o',
            'ú' | 'ü' => 'u',
            'ç' => 'c',
            c => c,
        };
        if c.is_ascii_alphanumeric() {
            s.push(c);
        } else if !s.is_empty() && !s.ends_with('-') {
            s.push('-');
        }
        if s.len() >= 24 {
            break;
        }
    }
    while s.ends_with('-') {
        s.pop();
    }
    // Nomes reservados: `contas` é o próprio arquivo do registro, e
    // `principal` é a conta que não mora em `contas/`.
    if s.is_empty() || s == "contas" || s == PRINCIPAL {
        return None;
    }
    Some(s)
}

/// PURA e testada. Um slug que veio de fora (argv, `contas.json` editado à
/// mão) só é aceito se for exatamente o que `slug_de` produziria. É esta
/// função que impede `--conta ../../Windows` de virar caminho.
pub fn slug_aceito(bruto: &str) -> Option<String> {
    if bruto == PRINCIPAL {
        return Some(PRINCIPAL.to_string());
    }
    let limpo = slug_de(bruto)?;
    if limpo == bruto {
        Some(limpo)
    } else {
        None
    }
}

/* --------------------------------------------------------------------------
   A conta ATIVA deste processo. Fixada UMA vez, no começo do `run()`, a
   partir do argv — e nunca mais muda. É o que permite `pasta_da_conta` ser
   consultada de qualquer lugar sem passar estado adiante, e o que faz o
   `LOG_PATH` (um `OnceLock` em connection/log.rs) continuar correto.
   -------------------------------------------------------------------------- */

static ATIVA: OnceLock<String> = OnceLock::new();

/// PURA e testada: acha o `--conta <slug>` no argv. Qualquer coisa que não
/// passe por `slug_aceito` é ignorada — cai na conta principal, que é o
/// comportamento de hoje.
pub fn conta_dos_args(args: &[String]) -> Option<String> {
    let mut it = args.iter().skip(1);
    while let Some(a) = it.next() {
        if a == "--conta" {
            return it.next().and_then(|s| slug_aceito(s.trim()));
        }
        if let Some(v) = a.strip_prefix("--conta=") {
            return slug_aceito(v.trim());
        }
    }
    None
}

/// Fixa a conta deste processo. Chamado uma única vez, no topo do `run()`.
pub fn fixar_ativa(args: &[String]) {
    let _ = ATIVA.set(conta_dos_args(args).unwrap_or_else(|| PRINCIPAL.to_string()));
}

pub fn ativa() -> &'static str {
    ATIVA.get().map(|s| s.as_str()).unwrap_or(PRINCIPAL)
}

/* --------------------------------------------------------------------------
   Caminhos.
   -------------------------------------------------------------------------- */

/// A raiz de configuração do APP (não da conta). Só o registro de contas mora
/// aqui — nada de dado de conta.
pub fn raiz(app: &AppHandle) -> PathBuf {
    app.path().app_config_dir().expect("config dir")
}

/// A pasta da conta ativa. Para `principal` é a raiz — bit por bit o caminho
/// que o app usa desde a versão 0.1.5.
pub fn pasta_da_conta(app: &AppHandle) -> PathBuf {
    pasta_de(app, ativa())
}

pub fn pasta_de(app: &AppHandle, slug: &str) -> PathBuf {
    let r = raiz(app);
    if slug == PRINCIPAL {
        r
    } else {
        r.join("contas").join(slug)
    }
}

/// O perfil do WebView2 da conta ativa — a sessão logada do WhatsApp.
/// `None` para a principal: passar `data_directory` mudaria a pasta em que a
/// sessão de hoje vive e deslogaria o usuário. Não passar é o que preserva.
pub fn perfil_webview(app: &AppHandle) -> Option<PathBuf> {
    if ativa() == PRINCIPAL {
        return None;
    }
    Some(pasta_da_conta(app).join("webview"))
}

/* --------------------------------------------------------------------------
   O registro: `contas.json`, na RAIZ. Fora do settings.json de propósito —
   se ele morasse dentro do settings de uma conta, a lista de contas sumiria
   ao trocar de conta, e um settings.json quebrado levaria junto o caminho de
   volta para as outras contas.
   -------------------------------------------------------------------------- */

fn caminho_registro(app: &AppHandle) -> PathBuf {
    raiz(app).join("contas.json")
}

/// PURA e testada. Aceita BOM pelo mesmo motivo do settings.json, e uma
/// entrada torta não derruba as outras: o que não passa em `slug_aceito` sai.
/// A `principal` é sempre a primeira e sempre existe.
pub fn interpretar_registro(bruto: Option<&str>) -> Vec<Conta> {
    let mut fora: Vec<Conta> = vec![Conta {
        slug: PRINCIPAL.to_string(),
        rotulo: "Conta principal".to_string(),
    }];
    let Some(bruto) = bruto else { return fora };
    let texto = bruto.strip_prefix('\u{feff}').unwrap_or(bruto);
    let Ok(v) = serde_json::from_str::<Value>(texto) else {
        return fora;
    };
    let Some(lista) = v.get("contas").and_then(|c| c.as_array()) else {
        return fora;
    };
    for item in lista {
        let Some(slug) = item.get("slug").and_then(|s| s.as_str()) else {
            continue;
        };
        let Some(slug) = slug_aceito(slug) else { continue };
        if slug == PRINCIPAL || fora.iter().any(|c| c.slug == slug) {
            continue;
        }
        let rotulo = item
            .get("rotulo")
            .and_then(|r| r.as_str())
            .unwrap_or("")
            .chars()
            .take(40)
            .collect::<String>();
        let rotulo = if rotulo.trim().is_empty() { slug.clone() } else { rotulo };
        fora.push(Conta { slug, rotulo });
    }
    fora
}

fn ler_registro(app: &AppHandle) -> Vec<Conta> {
    let bruto = std::fs::read_to_string(caminho_registro(app)).ok();
    interpretar_registro(bruto.as_deref())
}

fn gravar_registro(app: &AppHandle, contas: &[Conta]) -> Result<(), String> {
    let dir = raiz(app);
    let _ = std::fs::create_dir_all(&dir);
    // A principal não vai para o arquivo: ela existe por construção.
    let corpo: Vec<&Conta> = contas.iter().filter(|c| c.slug != PRINCIPAL).collect();
    let json = serde_json::json!({ "contas": corpo });
    std::fs::write(
        caminho_registro(app),
        serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

/* --------------------------------------------------------------------------
   Comandos. Só o PAINEL os cita (capabilities/default.json): a janela do
   WhatsApp Web não tem nada que fazer com a lista de contas do usuário —
   nem para ler, quanto mais para trocar.
   -------------------------------------------------------------------------- */

#[derive(Serialize)]
pub struct EstadoContas {
    pub ativa: String,
    pub contas: Vec<Conta>,
    /// Onde ficam os dados de cada conta, para o usuário conferir.
    pub pastas: Vec<String>,
    pub limite: &'static str,
}

#[tauri::command]
pub fn contas_estado(app: AppHandle) -> EstadoContas {
    let contas = ler_registro(&app);
    let pastas = contas
        .iter()
        .map(|c| pasta_de(&app, &c.slug).display().to_string())
        .collect();
    EstadoContas {
        ativa: ativa().to_string(),
        contas,
        pastas,
        limite: MULTI_CONTA_LIMITE,
    }
}

#[tauri::command]
pub fn conta_criar(app: AppHandle, rotulo: String) -> Result<Conta, String> {
    let slug = slug_de(&rotulo).ok_or(
        "esse nome não sobra nada utilizável como pasta. Use letras e números \
         (ex.: “Trabalho”, “Loja 2”).",
    )?;
    let mut contas = ler_registro(&app);
    if contas.iter().any(|c| c.slug == slug) {
        return Err(format!("já existe uma conta chamada “{slug}”."));
    }
    if contas.len() >= 8 {
        return Err("o teto é 8 contas. Cada uma é um perfil inteiro do WhatsApp em disco.".into());
    }
    let nova = Conta {
        slug: slug.clone(),
        rotulo: rotulo.trim().chars().take(40).collect(),
    };
    // A pasta nasce aqui, vazia. Nada de sessão: o QR só aparece quando o
    // usuário TROCAR para ela — criar não abre janela nenhuma.
    let _ = std::fs::create_dir_all(pasta_de(&app, &slug).join("webview"));
    contas.push(nova.clone());
    gravar_registro(&app, &contas)?;
    crate::connection::note_diag(&app, &format!("conta criada: {slug}"));
    Ok(nova)
}

/// Tira do registro. **Não apaga a pasta** — lá dentro está a sessão logada
/// daquela conta, e apagar sessão de WhatsApp por clique de menu é o tipo de
/// destruição irreversível que este app não faz. Devolve o caminho, para o
/// usuário apagar à mão se quiser.
#[tauri::command]
pub fn conta_remover(app: AppHandle, slug: String) -> Result<String, String> {
    if slug == PRINCIPAL {
        return Err("a conta principal não pode ser removida: ela é a instalação do app.".into());
    }
    if slug == ativa() {
        return Err("essa é a conta ABERTA agora. Troque para outra e então remova.".into());
    }
    let mut contas = ler_registro(&app);
    let antes = contas.len();
    contas.retain(|c| c.slug != slug);
    if contas.len() == antes {
        return Err(format!("não existe conta “{slug}”."));
    }
    gravar_registro(&app, &contas)?;
    crate::connection::note_diag(&app, &format!("conta removida do registro: {slug}"));
    Ok(pasta_de(&app, &slug).display().to_string())
}

/// Reinicia o ZapLite na conta escolhida.
///
/// A ordem é a única que funciona com o guarda de instância única:
///   1. `single_instance::destroy` solta o mutex e destrói a janela-alvo —
///      sem isto o processo NOVO se vê como segunda instância e morre;
///   2. o processo novo sobe com `--conta <slug>`;
///   3. este aqui sai.
#[tauri::command]
pub fn conta_trocar(app: AppHandle, slug: String) -> Result<(), String> {
    let slug = slug_aceito(&slug).ok_or("nome de conta inválido.")?;
    if slug != PRINCIPAL && !ler_registro(&app).iter().any(|c| c.slug == slug) {
        return Err(format!("não existe conta “{slug}”."));
    }
    if slug == ativa() {
        return Err("essa conta já é a que está aberta.".into());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    crate::connection::note_diag(&app, &format!("trocando de conta: {} → {slug}", ativa()));

    tauri_plugin_single_instance::destroy(&app);
    std::process::Command::new(exe)
        .arg("--conta")
        .arg(&slug)
        .spawn()
        .map_err(|e| format!("não consegui abrir o ZapLite na conta “{slug}”: {e}"))?;
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn slug_nunca_escapa_da_pasta_do_app() {
        // O caso que importa: texto de usuário virando caminho.
        assert_eq!(slug_de("../../Windows"), Some("windows".into()));
        assert_eq!(slug_de("C:\\Users\\alexa"), Some("c-users-alexa".into()));
        assert_eq!(slug_de("..").as_deref(), None);
        assert_eq!(slug_de("   ").as_deref(), None);
        assert_eq!(slug_de("///").as_deref(), None);
        // Reservados.
        assert_eq!(slug_de("contas").as_deref(), None);
        assert_eq!(slug_de("Principal").as_deref(), None);
        // Uso normal, com acento.
        assert_eq!(slug_de("Trabalho"), Some("trabalho".into()));
        assert_eq!(slug_de("Loja São Paulo"), Some("loja-sao-paulo".into()));
        assert!(slug_de("a".repeat(80).as_str()).unwrap().len() <= 24);
    }

    #[test]
    fn slug_vindo_de_fora_so_passa_se_for_o_canonico() {
        assert_eq!(slug_aceito("trabalho").as_deref(), Some("trabalho"));
        assert_eq!(slug_aceito("principal").as_deref(), Some("principal"));
        // Não é canônico: seria reescrito, então é recusado em vez de
        // silenciosamente virar outra coisa.
        assert_eq!(slug_aceito("Trabalho").as_deref(), None);
        assert_eq!(slug_aceito("../windows").as_deref(), None);
        assert_eq!(slug_aceito("a/b").as_deref(), None);
    }

    #[test]
    fn conta_dos_args_ignora_lixo_e_cai_na_principal() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(conta_dos_args(&a(&["zaplite.exe"])), None);
        assert_eq!(
            conta_dos_args(&a(&["zaplite.exe", "--conta", "trabalho"])).as_deref(),
            Some("trabalho")
        );
        assert_eq!(
            conta_dos_args(&a(&["zaplite.exe", "--conta=trabalho"])).as_deref(),
            Some("trabalho")
        );
        // Um argumento hostil não vira pasta: cai em None ⇒ conta principal.
        assert_eq!(conta_dos_args(&a(&["zaplite.exe", "--conta", "../../x"])), None);
        assert_eq!(conta_dos_args(&a(&["zaplite.exe", "--conta"])), None);
        // O deep link continua sendo deep link.
        assert_eq!(
            conta_dos_args(&a(&["zaplite.exe", "whatsapp://send?phone=1"])),
            None
        );
    }

    #[test]
    fn registro_tem_sempre_a_principal_e_descarta_entrada_torta() {
        // Sem arquivo: só a principal.
        let r = interpretar_registro(None);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].slug, PRINCIPAL);

        // Com BOM (mesmo defeito do settings.json) e com lixo no meio.
        let bruto = "\u{feff}{\"contas\":[\
            {\"slug\":\"trabalho\",\"rotulo\":\"Trabalho\"},\
            {\"slug\":\"../fuga\",\"rotulo\":\"x\"},\
            {\"slug\":\"principal\",\"rotulo\":\"tentativa de sombrear\"},\
            {\"slug\":\"trabalho\",\"rotulo\":\"duplicata\"},\
            {\"rotulo\":\"sem slug\"}]}";
        let r = interpretar_registro(Some(bruto));
        assert_eq!(
            r.iter().map(|c| c.slug.as_str()).collect::<Vec<_>>(),
            vec![PRINCIPAL, "trabalho"],
            "só a principal e a conta válida sobrevivem"
        );
        assert_eq!(r[0].rotulo, "Conta principal", "ninguém sombreia a principal");
    }

    #[test]
    fn registro_quebrado_nao_esconde_a_conta_principal() {
        // Vale a pena amarrar: um `contas.json` corrompido NÃO pode deixar o
        // usuário sem caminho de volta para a conta que tem a sessão dele.
        assert_eq!(interpretar_registro(Some("{{{lixo")).len(), 1);
        assert_eq!(interpretar_registro(Some("")).len(), 1);
        assert_eq!(interpretar_registro(Some("[]")).len(), 1);
    }
}
