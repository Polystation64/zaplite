use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

/// Teto de toasts simultâneos. Cada janela é um WebView2 (processo próprio);
/// sem teto, uma rajada de mensagens abre janelas até o Windows engasgar.
const MAX_TOASTS: usize = 5;

/// N1 — teto de toasts FIXADOS ao mesmo tempo. Um fixado sai da rotatividade
/// (o teto de `MAX_TOASTS` nunca o empurra), então ele é o único jeito de a
/// fila travar: com 5 fixados, nenhuma mensagem nova conseguiria janela.
/// Menor que `MAX_TOASTS` de propósito — sempre sobram 2 vagas para o fluxo.
const MAX_PINNED: usize = 3;

/// N2 — limites do tamanho por regra, em % do estilo escolhido.
const SIZE_PCT_MIN: u64 = 80;
const SIZE_PCT_MAX: u64 = 150;
/// N2 — opacidade mínima em repouso. Abaixo disso o texto some no fundo e o
/// toast deixa de ser notificação; o mouse por cima sempre volta a 100%.
const OPACIDADE_MIN: f64 = 0.35;

/// N2 — normaliza o tamanho por regra. `0` é "não escrito" (o `serde(default)`
/// de um settings antigo), e não 80%.
fn pct_valido(p: u64) -> u64 {
    if p == 0 {
        100
    } else {
        p.clamp(SIZE_PCT_MIN, SIZE_PCT_MAX)
    }
}

/// N2 — idem para a opacidade: `0.0` é "não escrito", não "invisível".
fn opacidade_valida(o: f64) -> f64 {
    if !o.is_finite() || o <= 0.0 {
        1.0
    } else {
        o.clamp(OPACIDADE_MIN, 1.0)
    }
}

/// N2 — cantos da tela onde um toast pode nascer. Qualquer outro texto (settings
/// antigo, valor inventado) cai no canto histórico, inferior direito.
fn canto_valido(p: &str) -> &'static str {
    match p {
        "superior-direita" => "superior-direita",
        "superior-esquerda" => "superior-esquerda",
        "inferior-esquerda" => "inferior-esquerda",
        _ => "inferior-direita",
    }
}

/// O que a página manda. Só fato bruto da conversa — nenhuma decisão de
/// apresentação vem da origem remota: estilo, som, volume, máscara de prévia e
/// silenciamento saem das regras lidas do `settings.json` aqui no Rust.
/// É isso que permite tirar `notify` das chaves públicas (a página não precisa
/// mais ver a lista de regras, isto é, a lista de contatos do usuário).
#[derive(Clone, Deserialize, Debug, Default)]
pub struct ToastRequest {
    pub id: String,
    /// Nome do contato ou grupo (só para exibir)
    pub sender: String,
    /// Nome de quem falou dentro do grupo (vazio em conversa 1:1)
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub body: String,
    /// URL da foto de perfil (data: da própria página)
    #[serde(default)]
    pub avatar: String,
    /// Identificador ESTÁVEL da conversa (jid: `...@lid`, `...@g.us`, `...@c.us`).
    /// É o que o clique usa para abrir a conversa certa — nunca o nome, que é
    /// texto controlado por quem manda a mensagem.
    #[serde(default)]
    pub chat_id: String,
    /// U1: a conversa está SILENCIADA no próprio WhatsApp (sino cortado na
    /// linha da lista). Fato observado na página, decidido aqui.
    #[serde(default)]
    pub muted: bool,
    /// W4: a conversa é um grupo (jid terminando em `@g.us`). Só grupo entra
    /// no caminho de menção — um "@" numa conversa 1:1 é e-mail, não menção.
    #[serde(default)]
    pub is_group: bool,
    /// W4: a linha traz um MARCADOR de menção (ícone/aria-label do próprio
    /// WhatsApp). Fato bruto observado na página; quem decide é o Rust.
    #[serde(default)]
    pub mention_mark: bool,
    /// U3: horário que o WhatsApp mostra na linha da conversa ("16:35",
    /// "07/08/2026", "ontem"). É o horário DA MENSAGEM. Pode vir vazio se a
    /// estrutura da lista mudar — nesse caso o `montar` cai na hora do disparo.
    #[serde(default)]
    pub time: String,
    /// V3: hora do relógio ("14:32") lida de um atributo ESTRUTURAL da linha,
    /// quando ela existe lá — nunca do texto da prévia, que é escrito por
    /// terceiro. Serve para completar um rótulo que é só data ("quarta-feira").
    /// Medido em 16/08/2026: nenhuma linha com rótulo de dia da semana tem
    /// hora, então na prática vem vazio e o rótulo fica como está.
    #[serde(default)]
    pub clock: String,
}

/// Dados de um toast já resolvidos, entregues ao toast.html quando ele carrega.
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Toast {
    pub id: String,
    pub sender: String,
    #[serde(default)]
    pub author: String,
    pub body: String,
    #[serde(default)]
    pub avatar: String,
    #[serde(default)]
    pub chat_id: String,
    /// U3: horário exibido no toast. Já resolvido: ou é o horário que o
    /// WhatsApp mostra na linha (o da mensagem), ou — se a página não
    /// conseguiu ler — a hora local em que a notificação disparou.
    #[serde(default)]
    pub time: String,
    /// Estilo visual: "card" | "faixa" | "destaque" | "discreto"
    pub style: String,
    /// Cor de acento em hex, por regra
    pub accent: String,
    /// Som sintetizado: "nenhum" | "toque" | "sino" | "pulso" | "alerta" | "arpejo"
    pub sound: String,
    /// Caminho de um .wav/.mp3 próprio; se preenchido, ignora `sound`
    pub sound_file: String,
    /// Volume de 0.0 a 1.0
    pub volume: f64,
    /// Se true, só fecha no clique (não expira sozinho)
    pub persistent: bool,
    /// Segundos até fechar quando não é persistente
    pub duration: u64,
    /// Repetir o som a cada N segundos enquanto o toast estiver aberto (0 = não repete)
    pub repeat_every: u64,
    /// W4: este toast é uma MENÇÃO ao usuário num grupo. O toast.html marca
    /// visualmente — é a informação que justifica furar o silêncio.
    #[serde(default)]
    pub mention: bool,
    /// Z2: minutos do botão "lembrar depois". Vem do `settings.json`; o toast
    /// só precisa saber o número para escrever no botão e devolvê-lo.
    #[serde(default)]
    pub snooze_min: u64,
    /// N2: canto da tela. O empilhamento acontece POR CANTO — cada canto é uma
    /// coluna independente, então dois toasts de cantos diferentes nunca
    /// disputam o mesmo pixel.
    #[serde(default)]
    pub position: String,
    /// N2: tamanho da janela em % do estilo escolhido (80..150).
    #[serde(default)]
    pub size_pct: u64,
    /// N2: opacidade em repouso (0.35..1.0). O toast.html volta a 100% quando o
    /// mouse passa por cima — translúcido é para não atrapalhar, não para
    /// esconder a mensagem de quem foi ler.
    #[serde(default)]
    pub opacity: f64,
}

/// Regra de notificação, como o Painel grava no `settings.json`.
#[derive(Clone, Debug, PartialEq)]
pub struct Regra {
    pub style: String,
    pub accent: String,
    pub sound: String,
    pub sound_file: String,
    pub volume: f64,
    pub persistent: bool,
    pub duration: u64,
    pub repeat_every: u64,
    pub hide_preview: bool,
    pub mute: bool,
    /// W1(a): "notificar mesmo se a conversa estiver silenciada no WhatsApp".
    /// DESLIGADA por padrão, e é a ÚNICA porta para furar o silêncio do
    /// WhatsApp. Antes disso, o simples fato de existir uma regra que casasse
    /// com o nome já furava o silêncio — e uma regra `contém: "Gi"` casa com
    /// Regina, Rodrigo, Logística e qualquer grupo com "gi" no nome.
    pub break_mute: bool,
    /// N2 — canto da tela ("inferior-direita" | "superior-direita" |
    /// "superior-esquerda" | "inferior-esquerda").
    pub position: String,
    /// N2 — tamanho em % do estilo (80..150).
    pub size_pct: u64,
    /// N2 — opacidade em repouso (0.35..1.0).
    pub opacity: f64,
}

impl Default for Regra {
    /// P2: instalação de fábrica (sem `settings.json`) tem que notificar.
    /// O `window.Notification` da página já foi silenciado quando o módulo
    /// liga; se aqui não houvesse regra, ligar o módulo apagaria TODA
    /// notificação. Este é o padrão semeado: card, som audível, 7s.
    fn default() -> Self {
        Regra {
            style: "card".into(),
            accent: "#22d3aa".into(),
            sound: "toque".into(),
            sound_file: String::new(),
            volume: 0.7,
            persistent: false,
            duration: 7,
            repeat_every: 0,
            hide_preview: false,
            mute: false,
            break_mute: false,
            // N2: o padrão é EXATAMENTE o comportamento de antes — canto
            // inferior direito, tamanho cheio do estilo, sem transparência.
            // Quem não mexer no Painel não percebe que estas opções existem.
            position: "inferior-direita".into(),
            size_pct: 100,
            opacity: 1.0,
        }
    }
}

impl Regra {
    fn de_json(v: &Value) -> Regra {
        let p = Regra::default();
        let s = |k: &str, d: &str| v[k].as_str().filter(|x| !x.is_empty()).unwrap_or(d).to_string();
        Regra {
            style: s("style", &p.style),
            accent: s("accent", &p.accent),
            sound: s("sound", &p.sound),
            sound_file: v["soundFile"].as_str().unwrap_or("").to_string(),
            volume: v["volume"].as_f64().unwrap_or(p.volume).clamp(0.0, 1.0),
            persistent: v["persistent"].as_bool().unwrap_or(false),
            duration: v["duration"].as_u64().filter(|d| *d > 0).unwrap_or(p.duration),
            repeat_every: v["repeatEvery"].as_u64().unwrap_or(0),
            hide_preview: v["hidePreview"].as_bool().unwrap_or(false),
            mute: v["mute"].as_bool().unwrap_or(false),
            break_mute: v["breakMute"].as_bool().unwrap_or(false),
            position: canto_valido(v["position"].as_str().unwrap_or("")).to_string(),
            size_pct: pct_valido(v["sizePct"].as_u64().unwrap_or(0)),
            opacity: opacidade_valida(v["opacity"].as_f64().unwrap_or(0.0)),
        }
    }
}

/// Escolhe a regra do contato **e** diz se ela veio de uma regra EXPLÍCITA
/// (aquela em que o usuário digitou o nome do contato/grupo) ou do padrão.
///
/// W1(a): a origem da regra NÃO decide mais nada sobre silenciamento. Ter uma
/// regra deixou de implicar autorização para furar o silêncio do WhatsApp —
/// quem fura é a caixa `breakMute` daquela regra, e só ela. O booleano
/// continua sendo devolvido porque o teste o usa para descrever a origem.
pub fn resolver(settings: &Value, sender: &str) -> (Regra, bool) {
    let notify = &settings["notify"];
    let alvo = sender.to_lowercase();

    if let Some(rules) = notify["rules"].as_array() {
        for r in rules {
            if r["enabled"].as_bool() == Some(false) {
                continue;
            }
            let termo = r["match"].as_str().unwrap_or("").trim().to_lowercase();
            if termo.is_empty() {
                continue;
            }
            let bate = if r["mode"].as_str() == Some("exato") {
                alvo == termo
            } else {
                alvo.contains(&termo)
            };
            if bate {
                return (Regra::de_json(r), true);
            }
        }
    }

    if notify["default"].is_object() {
        return (Regra::de_json(&notify["default"]), false);
    }
    (Regra::default(), false)
}

/// Primeira que bater vence; sem nenhuma, cai na regra padrão do usuário; sem
/// configuração alguma, na padrão de fábrica (P2).
#[cfg(test)]
pub fn regra_para(settings: &Value, sender: &str) -> Regra {
    resolver(settings, sender).0
}

/// W1(b) — a conversa está na lista de silenciadas do PAINEL (as caixinhas que
/// o usuário marcou na lista de conversas dele). Casa por `chat_id`, que é
/// estável: renomear o grupo não ressuscita a notificação. Aceita tanto
/// `["id", ...]` quanto `[{"id": "...", "name": "..."}, ...]`, porque o Painel
/// grava o nome junto só para conseguir exibir a lista sem o WhatsApp aberto.
pub fn na_lista_de_mudos(settings: &Value, chat_id: &str) -> bool {
    if chat_id.is_empty() {
        return false;
    }
    let Some(lista) = settings["notify"]["muted"].as_array() else {
        return false;
    };
    lista.iter().any(|v| {
        v.as_str() == Some(chat_id) || v["id"].as_str() == Some(chat_id)
    })
}

/// Z2 — "lembrar depois": em quantos minutos o toast volta. Configurável no
/// Painel (`notify.snoozeMinutes`); o padrão é 10 minutos, que é curto o
/// bastante para não virar esquecimento e longo o bastante para tirar a
/// notificação da frente de quem está no meio de outra coisa.
/// Fora da faixa 1..=240 o valor é descartado em vez de aceito: um zero
/// reabriria o toast no mesmo instante, num laço.
pub const SNOOZE_PADRAO_MIN: u64 = 10;
pub fn snooze_minutos(settings: &Value) -> u64 {
    settings["notify"]["snoozeMinutes"]
        .as_u64()
        .filter(|m| (1..=240).contains(m))
        .unwrap_or(SNOOZE_PADRAO_MIN)
}

/// Z2 — acrescenta uma conversa a `notify.muted` sem passar pelo Painel.
/// Função pura: recebe o settings e devolve o settings novo, para o teste
/// poder provar que não duplica, não apaga o resto e não aceita id vazio.
pub fn com_chat_silenciado(mut settings: Value, chat_id: &str, nome: &str) -> Value {
    if chat_id.is_empty() {
        return settings;
    }
    if !settings.is_object() {
        settings = json!({});
    }
    if !settings["notify"].is_object() {
        settings["notify"] = json!({});
    }
    if !settings["notify"]["muted"].is_array() {
        settings["notify"]["muted"] = json!([]);
    }
    if na_lista_de_mudos(&settings, chat_id) {
        return settings; // já estava lá: silenciar duas vezes não cria duas linhas
    }
    let nome: String = nome.chars().take(80).collect();
    settings["notify"]["muted"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "id": chat_id, "name": nome }));
    settings
}

/// W4 — configuração de menção, lida do `settings.notify.mention`.
#[derive(Clone, Debug, PartialEq)]
pub struct Mencao {
    pub enabled: bool,
    /// Menção pode furar o silêncio do WhatsApp — é justamente o caso em que
    /// o usuário quer saber. Opção dele, não padrão implícito.
    pub break_mute: bool,
    /// Como notificar uma menção (estilo, som, cor, etc.).
    pub regra: Regra,
    /// Apelidos do próprio usuário: "@Alexandre", "5531...". Sem nenhum, só o
    /// marcador do WhatsApp e (se ligado) `any_at` detectam menção.
    pub handles: Vec<String>,
    /// Qualquer "@" na prévia do grupo conta como menção. Grosseiro de
    /// propósito — fica desligado por padrão.
    pub any_at: bool,
}

impl Default for Mencao {
    fn default() -> Self {
        Mencao {
            enabled: false,
            break_mute: false,
            regra: Regra {
                style: "destaque".into(),
                accent: "#f59e0b".into(),
                sound: "alerta".into(),
                ..Regra::default()
            },
            handles: Vec::new(),
            any_at: false,
        }
    }
}

pub fn mencao_config(settings: &Value) -> Mencao {
    let v = &settings["notify"]["mention"];
    if !v.is_object() {
        return Mencao::default();
    }
    let p = Mencao::default();
    let mut regra = Regra::de_json(v);
    // Um objeto de menção sem estilo/som escritos herda o padrão de menção,
    // não o de contato: menção tem que ser visualmente distinta.
    if v["style"].as_str().unwrap_or("").is_empty() {
        regra.style = p.regra.style.clone();
    }
    if v["sound"].as_str().unwrap_or("").is_empty() {
        regra.sound = p.regra.sound.clone();
    }
    if v["accent"].as_str().unwrap_or("").is_empty() {
        regra.accent = p.regra.accent.clone();
    }
    Mencao {
        enabled: v["enabled"].as_bool().unwrap_or(false),
        break_mute: v["breakMute"].as_bool().unwrap_or(false),
        regra,
        handles: v["handles"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str())
                    .map(|s| s.trim().trim_start_matches('@').to_lowercase())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default(),
        any_at: v["anyAt"].as_bool().unwrap_or(false),
    }
}

/// W4 — a mensagem menciona o usuário? Combina TRÊS sinais, e basta um:
///  1. o marcador da própria linha do WhatsApp (`mention_mark`, medido na
///     página — ícone/aria-label de menção);
///  2. um apelido do usuário logo depois de um "@" na prévia;
///  3. `anyAt` (qualquer "@"), que o usuário liga por conta e risco.
/// Só vale em GRUPO: "@" numa conversa 1:1 é endereço de e-mail, não menção
/// (medido na lista real: uma prévia 1:1 era `gabriela.mendes@europartner...`).
pub fn e_mencao(m: &Mencao, req: &ToastRequest) -> bool {
    if !m.enabled || !req.is_group {
        return false;
    }
    if req.mention_mark {
        return true;
    }
    let texto = format!("{} {}", req.author, req.body).to_lowercase();
    if !texto.contains('@') {
        return false;
    }
    if m.any_at {
        return true;
    }
    m.handles.iter().any(|h| texto.contains(&format!("@{h}")))
}

/// M4 — o marcador de menção do WhatsApp é de NÍVEL, não de evento.
///
/// Medido no DOM real (20/08/2026): a linha do grupo com menção pendente traz
/// `div[data-testid="icon-mentions"][aria-label="Menção"]` e ele fica lá
/// ENQUANTO a menção não for lida — inclusive depois de outras dez mensagens
/// chegarem no grupo. Lido como presença, `mention_mark` gruda: toda mensagem
/// seguinte vira "menção" (estilo de menção, som de menção e, com `breakMute`,
/// furando o silêncio). O certo é a SUBIDA DE BORDA: só a primeira observação
/// do marcador conta como menção nova; enquanto ele continuar lá, as mensagens
/// seguintes são mensagens comuns.
///
/// Pura de propósito: é ela que os testes exercitam.
pub fn borda_de_mencao(anterior: Option<bool>, agora: bool) -> bool {
    agora && anterior != Some(true)
}

/// Teto da memória de menção: a lista de conversas do usuário, com folga. Uma
/// página hostil não pode transformar isto num depósito que cresce sem fim.
const MENCAO_MEM_MAX: usize = 2000;

/// Registra o NÍVEL do marcador da conversa e devolve se foi subida de borda.
/// Sem `chat_id` não há memória possível — aí o nível vale como está, que é o
/// comportamento antigo e não inventa uma menção que não veio.
pub fn registrar_mencao(mem: &mut HashMap<String, bool>, chat_id: &str, agora: bool) -> bool {
    if chat_id.is_empty() {
        return agora;
    }
    let borda = borda_de_mencao(mem.get(chat_id).copied(), agora);
    if agora {
        if mem.len() >= MENCAO_MEM_MAX && !mem.contains_key(chat_id) {
            mem.clear();
        }
        mem.insert(chat_id.to_string(), true);
    } else {
        // marcador sumiu = menção lida. Esquecer é o que rearma a próxima.
        mem.remove(chat_id);
    }
    borda
}

fn mencao_mem() -> &'static Mutex<HashMap<String, bool>> {
    static MEM: std::sync::OnceLock<Mutex<HashMap<String, bool>>> = std::sync::OnceLock::new();
    MEM.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Por que uma notificação não apareceu. Existe para o teste (e o dia em que
/// alguém tiver que explicar ao usuário) poder dizer QUAL porta fechou.
#[derive(Clone, Debug, PartialEq)]
pub enum Decisao {
    /// Não notificar, com o motivo.
    Silencio(&'static str),
    /// Notificar com esta regra; o bool diz se é menção.
    Mostrar(Box<Regra>, bool),
}

/// W1 — a decisão inteira, em função pura. É ESTA função que o `show_toast`
/// chama e que os testes exercitam: não há uma segunda cópia da lógica.
///
/// Ordem, e o porquê de cada degrau:
///  1. lista do Painel (W1b) — o usuário marcou aquela conversa na mão. É a
///     palavra final, inclusive sobre menção: ele apontou para AQUELA conversa.
///  2. menção (W4) — só em grupo, e só fura o silêncio do WhatsApp se ele
///     ligou `breakMute` na configuração de menção.
///  3. regra do contato: `mute` cala; senão vale o silêncio do WhatsApp,
///     que agora SEMPRE vence, a menos que a regra tenha `breakMute`.
pub fn decidir(settings: &Value, req: &ToastRequest) -> Decisao {
    if na_lista_de_mudos(settings, &req.chat_id) {
        return Decisao::Silencio("silenciada na lista do Painel");
    }

    let m = mencao_config(settings);
    if e_mencao(&m, req) {
        if req.muted && !m.break_mute {
            return Decisao::Silencio("menção em grupo silenciado no WhatsApp");
        }
        return Decisao::Mostrar(Box::new(m.regra), true);
    }

    let (regra, _explicita) = resolver(settings, &req.sender);
    if regra.mute {
        return Decisao::Silencio("regra manda não notificar");
    }
    if req.muted && !regra.break_mute {
        return Decisao::Silencio("silenciada no WhatsApp");
    }
    Decisao::Mostrar(Box::new(regra), false)
}

/// W2 — DATA **e** HORA no toast.
///
/// O rótulo que o WhatsApp põe na linha da conversa nunca traz as duas coisas:
/// medido na lista real (69 linhas, todas com rótulo) ele é `"00:41"` para
/// hoje, `"Ontem"`, `"sexta-feira"` ou `"07/08/2026"` para o resto. O usuário
/// pediu data E hora; então quando o rótulo é só um relógio — ou seja, a
/// mensagem é de HOJE — a data de hoje entra na frente. Nos outros casos o
/// rótulo JÁ É a data e fica como está: inventar uma hora ali seria mentira,
/// porque a hora daquela mensagem não está na linha.
///
/// V3 — quando o rótulo é um DIA ("quarta-feira", "Ontem", "07/08/2026") e a
/// página conseguiu ler uma hora de verdade na linha (`clock`), as duas se
/// juntam: "quarta-feira 14:32". Sem `clock`, o rótulo sai como está — hora
/// inventada seria mentira, e é por isso que a composição depende de um fato
/// medido na linha, não de um palpite. `clock` vem de atributo estrutural
/// (title/aria-label/datetime), nunca do texto da prévia.
pub fn compor_horario(rotulo: &str, clock: &str, data_hoje: &str, hora_agora: &str) -> String {
    let t = rotulo.trim();
    if t.is_empty() {
        // A linha não deu rótulo nenhum: sobra o instante do disparo, e fica
        // explícito que é data+hora — nunca um toast sem horário, que foi
        // exatamente o que o usuário relatou não ver.
        return format!("{data_hoje} {hora_agora}");
    }
    let eh_relogio = |s: &str| {
        !s.is_empty()
            && s.len() <= 5
            && s.matches(':').count() == 1
            && s.chars().all(|c| c.is_ascii_digit() || c == ':')
    };
    if eh_relogio(t) {
        return format!("{data_hoje} {t}");
    }
    // Rótulo que é DATA. Completa com a hora só se ela vier da linha e o
    // rótulo ainda não trouxer relógio nenhum. Aqui a validação é ESTRITA
    // (hh:mm dentro da faixa): o campo vem da página, e um ":" solto ou um
    // "14:3" não é hora nenhuma.
    let c = clock.trim();
    let hora_valida = || {
        let (h, m) = match c.split_once(':') {
            Some(p) => p,
            None => return false,
        };
        if h.is_empty() || h.len() > 2 || m.len() != 2 {
            return false;
        }
        match (h.parse::<u32>(), m.parse::<u32>()) {
            (Ok(h), Ok(m)) => h <= 23 && m <= 59,
            _ => false,
        }
    };
    let ja_tem_hora = t.contains(':');
    if hora_valida() && !ja_tem_hora {
        return format!("{t} {c}").chars().take(30).collect();
    }
    t.chars().take(24).collect()
}

/// Aplica a regra ao pedido cru. P5: "ocultar prévia" mascara o corpo **e** o
/// autor — numa conversa 1:1 a prévia "Senha: 1234" vira `author="Senha"`, e
/// mascarar só o corpo deixaria o segredo na tela.
#[cfg(test)]
pub fn montar(req: &ToastRequest, r: &Regra) -> Toast {
    montar_com(req, r, false)
}

pub fn montar_com(req: &ToastRequest, r: &Regra, mention: bool) -> Toast {
    let (author, body) = if r.hide_preview {
        (String::new(), "Nova mensagem".to_string())
    } else {
        (
            req.author.chars().take(60).collect(),
            req.body.chars().take(220).collect(),
        )
    };
    Toast {
        id: req.id.clone(),
        sender: req.sender.chars().take(80).collect(),
        author,
        body,
        avatar: req.avatar.clone(),
        chat_id: req.chat_id.clone(),
        // U3: preferência pelo horário DA MENSAGEM (o texto que o WhatsApp já
        // mostra na linha da conversa). Só quando ele não vier é que se usa o
        // instante do DISPARO da notificação — que na prática é o mesmo minuto,
        // mas não é a mesma coisa e por isso está escrito aqui qual é qual.
        time: {
            let agora = chrono::Local::now();
            compor_horario(
                &req.time,
                &req.clock,
                &agora.format("%d/%m").to_string(),
                &agora.format("%H:%M").to_string(),
            )
        },
        style: r.style.clone(),
        accent: r.accent.clone(),
        sound: r.sound.clone(),
        sound_file: r.sound_file.clone(),
        volume: r.volume,
        persistent: r.persistent,
        duration: r.duration,
        repeat_every: r.repeat_every,
        mention,
        // Z2: o `show_toast` sobrescreve com o que estiver no settings.json.
        // Aqui fica o padrão para o caminho de teste, que não lê arquivo.
        snooze_min: SNOOZE_PADRAO_MIN,
        // N2 — decisões de janela: saem da REGRA, como estilo e som. A origem
        // remota continua sem opinar sobre apresentação.
        position: canto_valido(&r.position).to_string(),
        size_pct: pct_valido(r.size_pct),
        opacity: opacidade_valida(r.opacity),
    }
}

/// Largura e altura de cada estilo, em pixels lógicos, já com o tamanho por
/// regra aplicado. É a ÚNICA fonte de tamanho: `restack`, `abrir_espaco` e a
/// criação da janela usam esta função, então nenhum estilo novo pode empilhar
/// diferente do que ocupa.
fn size_for(style: &str, size_pct: u64) -> (f64, f64) {
    let (w, h) = match style {
        "faixa" => (520.0, 78.0),
        "destaque" => (400.0, 190.0),
        "discreto" => (300.0, 68.0),
        // N2 — maior que o `destaque`: prévia de 5 linhas sem cortar no meio.
        "painel" => (460.0, 260.0),
        // N2 — mais discreto que o `discreto`: uma linha, sem avatar, só ícones.
        "mini" => (260.0, 52.0),
        _ => (380.0, 124.0), // card
    };
    let k = pct_valido(size_pct) as f64 / 100.0;
    ((w * k).round(), (h * k).round())
}

/// Y2 — validade do pedido de abrir conversa guardado durante a recuperação.
/// Cobre com folga um reload (nível 2) e uma renavegação (nível 3) do WhatsApp
/// Web; passado disso o clique é velho demais e abrir a conversa sozinho seria
/// surpresa, não conveniência.
const PEDIDO_CHAT_TTL: Duration = Duration::from_secs(90);

#[derive(Default)]
pub struct ToastState {
    /// id -> payload, para o toast.html buscar quando abrir
    pub data: Mutex<HashMap<String, Toast>>,
    /// ordem de empilhamento (mais novo no fim)
    pub stack: Mutex<Vec<String>>,
    /// Y2 — último pedido de abrir conversa que ainda não foi atendido pela
    /// página. O `emit` do Tauri não tem buffer e o listener do bundle só
    /// existe ~0,4 s depois que a página nova roda `apply()`: sem este campo o
    /// clique feito durante uma recuperação cai no vazio.
    pub pedido_chat: Mutex<Option<(String, Instant)>>,
    /// N1 — ids dos toasts FIXADOS pelo usuário no próprio toast. Vive aqui, e
    /// não no `Toast`, porque é decisão tomada DEPOIS de a janela existir: o
    /// payload entregue à página é o que a regra decidiu, este conjunto é o que
    /// o usuário decidiu. `esquecer` o limpa junto com o resto.
    pub pinned: Mutex<HashSet<String>>,
}

const MARGEM: f64 = 16.0;
const VAO: f64 = 10.0;

/// Área de trabalho (em pixels físicos) e escala do monitor onde o app está.
/// P7: é a área ÚTIL, não o tamanho do monitor — usar o monitor inteiro põe o
/// toast mais novo por baixo da barra de tarefas.
fn area_util(app: &AppHandle) -> ((f64, f64, f64, f64), f64) {
    let monitor = app.get_webview_window("main").and_then(|w| {
        w.current_monitor()
            .ok()
            .flatten()
            .or_else(|| w.primary_monitor().ok().flatten())
    });
    match monitor {
        Some(m) => {
            let a = m.work_area();
            (
                (
                    a.position.x as f64,
                    a.position.y as f64,
                    a.size.width as f64,
                    a.size.height as f64,
                ),
                m.scale_factor(),
            )
        }
        None => ((0.0, 0.0, 1920.0, 1040.0), 1.0),
    }
}

/// Posições físicas de UMA coluna (um canto), do mais novo (colado no canto)
/// para o mais antigo. Função pura: é ela que o teste exercita.
///
/// N2 — o canto escolhe de que lado a coluna encosta e para que lado ela
/// cresce: nos cantos de baixo o mais novo fica embaixo e a pilha sobe (o
/// comportamento histórico); nos de cima o mais novo fica em cima e a pilha
/// desce. Nos dois casos o `y` é preso dentro da área útil.
fn posicoes(
    area: (f64, f64, f64, f64),
    scale: f64,
    canto: &str,
    tamanhos: &[(f64, f64)],
) -> Vec<(i32, i32)> {
    let (ax, ay, aw, ah) = area;
    let canto = canto_valido(canto);
    let esquerda = canto.ends_with("esquerda");
    let topo = canto.starts_with("superior");
    let mut saida = Vec::with_capacity(tamanhos.len());
    let mut offset = MARGEM * scale;
    for (w, h) in tamanhos {
        let (wp, hp) = (w * scale, h * scale);
        let x = if esquerda {
            ax + MARGEM * scale
        } else {
            ax + aw - wp - MARGEM * scale
        };
        // Clamp nas duas pontas da área útil: nunca sai da tela nem cobre a
        // barra de tarefas, mesmo se o teto falhar.
        let y = if topo {
            (ay + offset).min(ay + ah - hp).max(ay)
        } else {
            (ay + ah - offset - hp).max(ay)
        };
        saida.push((x.round() as i32, y.round() as i32));
        offset += (h + VAO) * scale;
    }
    saida
}

/// Quantos toasts cabem, dada a altura útil. P7: em vez de abandonar os
/// excedentes na mesma posição (o `break` antigo), o excedente é fechado.
fn cabem(altura_util: f64, scale: f64, alturas: &[f64]) -> usize {
    let mut usado = MARGEM * scale;
    let mut n = 0;
    for h in alturas {
        let preciso = (h + VAO) * scale;
        if usado + preciso > altura_util {
            break;
        }
        usado += preciso;
        n += 1;
    }
    n.min(MAX_TOASTS)
}

/// Reposiciona todos os toasts abertos. N2 — CADA CANTO É UMA COLUNA: os toasts
/// são agrupados pelo canto da regra deles e cada grupo empilha sozinho, a
/// partir do seu próprio canto da área de trabalho. Sem o agrupamento, um toast
/// no canto de cima entraria no mesmo cálculo de offset do canto de baixo e as
/// duas pilhas se sobreporiam.
fn restack(app: &AppHandle) {
    let state = app.state::<ToastState>();
    let stack = state.stack.lock().unwrap().clone();
    let data = state.data.lock().unwrap().clone();
    let (area, scale) = area_util(app);

    // Do mais novo (colado no canto) para o mais antigo, por canto.
    let mut colunas: HashMap<&'static str, Vec<(String, (f64, f64))>> = HashMap::new();
    for id in stack.iter().rev() {
        let Some(t) = data.get(id) else { continue };
        if app.get_webview_window(&format!("toast-{id}")).is_none() {
            continue;
        }
        colunas
            .entry(canto_valido(&t.position))
            .or_default()
            .push((id.clone(), size_for(&t.style, t.size_pct)));
    }

    for (canto, vivos) in colunas {
        let tamanhos: Vec<(f64, f64)> = vivos.iter().map(|(_, s)| *s).collect();
        for ((id, _), (x, y)) in vivos.iter().zip(posicoes(area, scale, canto, &tamanhos)) {
            if let Some(win) = app.get_webview_window(&format!("toast-{id}")) {
                let _ = win.set_position(PhysicalPosition::new(x, y));
            }
        }
    }
}

/// Tira o toast do estado. Chamado tanto pelo `close_toast` quanto pelos
/// eventos da janela — fechar por fora (Alt+F4, gerenciador, watchdog) não pode
/// mais deixar corpo da mensagem e avatar (até 300 KB) retidos para sempre.
fn esquecer(app: &AppHandle, id: &str) {
    let state = app.state::<ToastState>();
    state.data.lock().unwrap().remove(id);
    state.stack.lock().unwrap().retain(|x| x != id);
    // N1 — sem isto, o conjunto de fixados viraria depósito de ids mortos e
    // ainda por cima gastaria a cota de `MAX_PINNED` com janelas que não existem.
    state.pinned.lock().unwrap().remove(id);
}

/// N1 — cabe mais um FIXADO nesta coluna? Duas guardas, e é aqui que mora a
/// resolução do conflito "o fixado não pode ser empurrado, mas também não pode
/// entupir a tela": no máximo `MAX_PINNED` fixados no total (sempre sobram
/// vagas para o fluxo) e, somados, os fixados de um canto nunca passam de
/// METADE da altura útil daquela coluna.
fn pode_fixar(
    altura_util: f64,
    scale: f64,
    fixados_no_canto: &[f64],
    novo: f64,
    total_fixados: usize,
) -> bool {
    if total_fixados >= MAX_PINNED {
        return false;
    }
    let soma: f64 = fixados_no_canto
        .iter()
        .chain(std::iter::once(&novo))
        .map(|h| (h + VAO) * scale)
        .sum();
    soma <= altura_util * 0.5
}

/// Fecha os mais antigos até o novo toast caber (por contagem e por altura útil).
///
/// N1 — a vítima é sempre o mais antigo NÃO FIXADO. Um toast fixado nunca é
/// fechado pela rotatividade: se ele pudesse ser empurrado pelo teto, a promessa
/// do botão ("só some no ✕") seria mentira exatamente quando ela mais importa,
/// que é numa rajada de mensagens. `pode_fixar` é o outro lado do contrato — ele
/// garante que sempre reste meia coluna e ao menos duas vagas livres, então
/// "não sobrou vítima" é um beco sem saída que na prática não acontece.
fn abrir_espaco(app: &AppHandle, altura_nova: f64, canto_novo: &str) {
    let (area, scale) = area_util(app);
    let canto_novo = canto_valido(canto_novo);
    loop {
        let (stack, data, fixos) = {
            let state = app.state::<ToastState>();
            let s = state.stack.lock().unwrap().clone();
            let d = state.data.lock().unwrap().clone();
            let p = state.pinned.lock().unwrap().clone();
            (s, d, p)
        };
        // Só a coluna do toast novo entra na conta de altura: fechar um toast
        // do outro canto não abre um pixel na coluna que está cheia.
        let mut alturas: Vec<f64> = stack
            .iter()
            .rev()
            .filter_map(|id| data.get(id))
            .filter(|t| canto_valido(&t.position) == canto_novo)
            .map(|t| size_for(&t.style, t.size_pct).1)
            .collect();
        alturas.insert(0, altura_nova); // o novo entra colado no canto
        let cabe_altura = cabem(area.3, scale, &alturas) >= alturas.len();
        let cabe_conta = stack.len() + 1 <= MAX_TOASTS;
        if cabe_altura && cabe_conta {
            return;
        }
        let vitima = stack
            .iter()
            .find(|id| {
                if fixos.contains(*id) {
                    return false;
                }
                // Falha de CONTAGEM: qualquer canto serve, porque o teto é do
                // processo. Falha de ALTURA: só serve quem está na coluna cheia.
                cabe_altura
                    || data
                        .get(*id)
                        .map(|t| canto_valido(&t.position) == canto_novo)
                        .unwrap_or(true)
            })
            .cloned();
        let Some(v) = vitima else {
            return;
        };
        fechar(app, &v);
    }
}

fn fechar(app: &AppHandle, id: &str) {
    if let Some(win) = app.get_webview_window(&format!("toast-{id}")) {
        let _ = win.close();
    }
    esquecer(app, id);
}

/// Chamado pelo bundle.js quando chega uma mensagem nova.
#[tauri::command]
pub async fn show_toast(app: AppHandle, mut toast: ToastRequest) -> Result<(), String> {
    if toast.id.is_empty() {
        return Err("toast sem id".into());
    }
    // M4: o marcador de menção da linha é de NÍVEL. Aqui ele vira EVENTO —
    // só a subida de borda conta como menção. Sem isto, uma menção não lida
    // faria toda mensagem seguinte do grupo sair com cara de menção.
    toast.mention_mark = {
        let mut mem = mencao_mem().lock().unwrap();
        registrar_mencao(&mut mem, &toast.chat_id, toast.mention_mark)
    };
    // W1: TODA a decisão mora em `decidir` — função pura, testada, sem cópia.
    let settings = crate::read_settings(&app);
    let (regra, mencao) = match decidir(&settings, &toast) {
        Decisao::Silencio(_motivo) => return Ok(()),
        Decisao::Mostrar(r, m) => (*r, m),
    };
    let mut resolvido = montar_com(&toast, &regra, mencao);
    resolvido.snooze_min = snooze_minutos(&settings);
    mostrar_resolvido(app, resolvido)
}

/// Abre a janela de um toast JÁ DECIDIDO. Separado do `show_toast` porque o
/// "lembrar depois" (Z2) precisa reexibir exatamente o mesmo toast — mesmo
/// conteúdo, mesmo `chat_id` — sem passar de novo por `decidir`: a decisão já
/// foi tomada quando a mensagem chegou, e refazê-la faria uma regra alterada
/// no meio do caminho engolir uma notificação que o usuário mandou guardar.
fn mostrar_resolvido(app: AppHandle, resolvido: Toast) -> Result<(), String> {
    let id = resolvido.id.clone();
    let (w, h) = size_for(&resolvido.style, resolvido.size_pct);

    abrir_espaco(&app, h, &resolvido.position);

    let win = WebviewWindowBuilder::new(
        &app,
        format!("toast-{id}"),
        WebviewUrl::App(format!("toast.html?id={id}").into()),
    )
    .title("ZapLite")
    .inner_size(w, h)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .transparent(true)
    .focused(false)
    .visible(false) // mostra só depois de posicionar, evita o "pulo" na tela
    .build()
    .map_err(|e| e.to_string())?;

    // Só agora o estado é escrito: se o `build()` falhar, nada fica retido.
    // (O toast.html tolera um `get_toast` vazio nos primeiros ms e repete.)
    {
        let state = app.state::<ToastState>();
        state.data.lock().unwrap().insert(id.clone(), resolvido);
        state.stack.lock().unwrap().push(id.clone());
    }

    // A janela pode morrer por caminhos que não passam pelo `close_toast`.
    // Qualquer um deles limpa o estado e reempilha o resto.
    let h_app = app.clone();
    let id_ev = id.clone();
    win.on_window_event(move |e| match e {
        tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => {
            esquecer(&h_app, &id_ev);
            restack(&h_app);
        }
        _ => {}
    });

    restack(&app);
    let _ = win.show();
    Ok(())
}

/// O toast.html pede seus próprios dados ao carregar.
#[tauri::command]
pub fn get_toast(app: AppHandle, id: String) -> Option<Toast> {
    app.state::<ToastState>().data.lock().unwrap().get(&id).cloned()
}

/// Fecha um toast e reorganiza a pilha.
#[tauri::command]
pub fn close_toast(app: AppHandle, id: String) -> Result<(), String> {
    fechar(&app, &id);
    restack(&app);
    Ok(())
}

/// Clique no toast: traz o WhatsApp para a frente e abre a conversa.
/// P3: o que viaja é o **identificador da conversa**, nunca o nome. O nome é
/// texto que o remetente controla; uma mensagem cujo corpo fosse exatamente o
/// nome de outro contato abria a conversa errada.
#[tauri::command]
pub fn focus_chat(app: AppHandle, id: String, chat_id: String) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
        if !chat_id.is_empty() {
            // Y2 — o pedido é GUARDADO antes de ser emitido. O `emit` é um
            // tiro sem buffer: se a página estiver recarregando (nível 2) ou
            // renavegando (nível 3), não há listener para ouvi-lo e o toast
            // fecharia sem nada acontecer. Guardado aqui, o bundle novo pega o
            // pedido com `take_pending_chat` assim que sobe.
            {
                let st = app.state::<ToastState>();
                *st.pedido_chat.lock().unwrap() = Some((chat_id.clone(), Instant::now()));
            }
            // O bundle.js escuta este evento e procura a linha cujo id casa.
            let _ = main.emit("zaplite://open-chat", json!({ "chatId": chat_id }));
        }
    }
    close_toast(app, id)
}

/// Z2 — "lembrar depois": o toast some AGORA e volta daqui a N minutos com o
/// mesmo conteúdo e o mesmo `chat_id` (portanto o clique dele continua abrindo
/// a conversa certa). O payload é retirado do estado antes de a janela fechar
/// — `fechar` chama `esquecer`, e sem essa cópia o conteúdo se perderia.
///
/// LIMITE HONESTO: o adiamento vive na memória do processo. Se o ZapLite for
/// fechado antes de o tempo acabar, o toast não volta. Persistir isso em disco
/// significaria ressuscitar notificações de mensagens já lidas depois de um
/// reinício, que é pior do que perdê-las.
#[tauri::command]
pub fn snooze_toast(app: AppHandle, id: String, minutes: u64) -> Result<(), String> {
    let Some(mut resolvido) = app.state::<ToastState>().data.lock().unwrap().get(&id).cloned()
    else {
        return close_toast(app, id);
    };
    // A página do toast é conteúdo nosso, mas o número ainda passa por aqui:
    // 0 reabriria o toast no mesmo instante, num laço.
    let minutos = minutes.clamp(1, 240);
    resolvido.snooze_min = minutos;
    close_toast(app.clone(), id)?;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(minutos * 60)).await;
        let _ = mostrar_resolvido(app, resolvido);
    });
    Ok(())
}

/// N1 — "fixar" ESTE toast, decidido na hora em que ele aparece (o `persistent`
/// da regra é configuração prévia; isto é a decisão do momento). Um toast
/// fixado para de contar o tempo e sai da rotatividade: nem o teto de
/// `MAX_TOASTS` nem a falta de altura o fecham. Só o ✕.
///
/// Alterna: chamar de novo desfixa e o tempo volta a correr, do começo.
///
/// Devolve o estado NOVO em texto, porque a guarda de espaço mora aqui e a
/// página precisa distinguir "você desfixou" de "não deu, tem fixado demais":
/// `"fixado"` | `"solto"` | `"cheio"`.
#[tauri::command]
pub fn pin_toast(app: AppHandle, id: String) -> Result<String, String> {
    let (area, scale) = area_util(&app);
    let state = app.state::<ToastState>();

    if state.pinned.lock().unwrap().contains(&id) {
        state.pinned.lock().unwrap().remove(&id);
        return Ok("solto".into());
    }

    let data = state.data.lock().unwrap().clone();
    let Some(t) = data.get(&id) else {
        return Err("toast desconhecido".into());
    };
    let canto = canto_valido(&t.position);
    let altura_nova = size_for(&t.style, t.size_pct).1;

    let fixos = state.pinned.lock().unwrap().clone();
    let no_canto: Vec<f64> = fixos
        .iter()
        .filter_map(|x| data.get(x))
        .filter(|o| canto_valido(&o.position) == canto)
        .map(|o| size_for(&o.style, o.size_pct).1)
        .collect();

    if !pode_fixar(area.3, scale, &no_canto, altura_nova, fixos.len()) {
        return Ok("cheio".into());
    }
    state.pinned.lock().unwrap().insert(id);
    Ok("fixado".into())
}

/// Z2 — "silenciar este contato/grupo" direto do toast: acrescenta a conversa
/// a `notify.muted` (a MESMA lista das caixinhas do Painel, casada por id) e
/// fecha o toast. Por id, nunca por nome: o nome é texto que o remetente
/// controla e renomear o grupo ressuscitaria a notificação.
#[tauri::command]
pub fn mute_chat(app: AppHandle, id: String, chat_id: String, name: String) -> Result<(), String> {
    if !chat_id.is_empty() {
        let novo = com_chat_silenciado(crate::read_settings(&app), &chat_id, &name);
        crate::write_settings(&app, novo)?;
    }
    close_toast(app, id)
}

/// Y2 — a página pergunta, ao subir (e ao atender o evento), se há um pedido
/// de conversa pendente. Consome: um pedido só é entregue uma vez, e um pedido
/// velho (mais que `PEDIDO_CHAT_TTL`) é descartado em vez de abrir conversa do
/// nada muito tempo depois do clique.
#[tauri::command]
pub fn take_pending_chat(app: AppHandle) -> Option<String> {
    let st = app.state::<ToastState>();
    let mut p = st.pedido_chat.lock().unwrap();
    match p.take() {
        Some((chat_id, quando)) if quando.elapsed() <= PEDIDO_CHAT_TTL => Some(chat_id),
        _ => None,
    }
}

/// W1(b) — uma conversa da lista, do jeito que o Painel precisa exibir.
/// Vem da página (origem hostil): tudo aqui é dado de EXIBIÇÃO, e o `id` é o
/// único campo com peso de decisão — o mesmo `chat_id` que o toast já usa.
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
pub struct ChatRef {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub group: bool,
    /// silenciada no próprio WhatsApp (só para o Painel mostrar o estado)
    #[serde(default)]
    pub muted: bool,
    /// M4 — NÍVEL do marcador de menção da linha. Não vai para o Painel: serve
    /// só para o Rust perceber que a menção FOI LIDA mesmo quando nenhuma
    /// mensagem nova chegou no intervalo. Sem isso a próxima menção do mesmo
    /// grupo não seria subida de borda e passaria como mensagem comum.
    #[serde(default)]
    pub mention: bool,
}

/// Teto: a lista é a agenda do usuário, não um canal de armazenamento para a
/// página. 800 conversas cobre com folga qualquer conta real.
const MAX_CHATS: usize = 800;

#[derive(Default)]
pub struct ChatList(pub Mutex<Vec<ChatRef>>);

/// W1(b) — a página informa quais conversas existem, para o Painel poder
/// mostrar caixinhas em vez de obrigar o usuário a digitar uma regra por
/// grupo. Não muda decisão nenhuma: é insumo de UI.
#[tauri::command]
pub fn report_chats(app: AppHandle, chats: Vec<ChatRef>) -> Result<(), String> {
    let limpos: Vec<ChatRef> = chats
        .into_iter()
        .filter(|c| !c.id.is_empty())
        .take(MAX_CHATS)
        .map(|c| ChatRef {
            id: c.id.chars().take(120).collect(),
            name: c.name.chars().take(80).collect(),
            group: c.group,
            muted: c.muted,
            mention: c.mention,
        })
        .collect();
    // M4 — este relatório só APAGA a memória de menção (marcador sumiu = menção
    // lida). Ele nunca a LIGA: ligar aqui roubaria a subida de borda do toast
    // que chega junto com a menção, e a notificação de menção não sairia.
    {
        let mut mem = mencao_mem().lock().unwrap();
        for c in &limpos {
            if !c.mention && !c.id.is_empty() {
                mem.remove(&c.id);
            }
        }
    }
    *app.state::<ChatList>().0.lock().unwrap() = limpos;
    Ok(())
}

/// Lido só pelo Painel (janela local). A janela remota não cita este comando
/// na capability dela — ela já tem a lista, é ela quem a produziu.
#[tauri::command]
pub fn list_chats(app: AppHandle) -> Vec<ChatRef> {
    app.state::<ChatList>().0.lock().unwrap().clone()
}

/// Fecha todos de uma vez. N1 — este caminho fecha os FIXADOS também, e é
/// coerente: ele só roda quando o módulo de notificação é DESLIGADO (`revert`)
/// ou quando a janela principal morre. Nos dois casos não há mais quem avisar —
/// deixar um toast fixado vivo depois disso é a janela órfã que o Y1 caçou.
#[tauri::command]
pub fn close_all_toasts(app: AppHandle) -> Result<(), String> {
    let ids: Vec<String> = {
        let state = app.state::<ToastState>();
        // Bind explícito: sem isso o guard temporário do tail expression
        // sobrevive ao `state` e o borrow checker reclama.
        let ids = state.stack.lock().unwrap().clone();
        ids
    };
    for id in ids {
        fechar(&app, &id);
    }
    restack(&app);
    Ok(())
}

/// Y1 — recuperação autorizada: os toasts saem de cena AQUI, no Rust.
///
/// O nível 2 (`location.reload()`) e o nível 3 (renavegação) destroem o
/// contexto JS sem passar por `revert()` — que é o único lugar que chamava
/// `close_all_toasts`. Sem isto, as janelas `toast-*` sobrevivem à recuperação
/// `always_on_top` por cima de um WhatsApp em branco, e o `ToastState` segue
/// segurando o corpo da mensagem e o avatar delas para sempre.
///
/// O Rust é o lado certo para o efeito por dois motivos: é ele quem SABE que a
/// recuperação vai acontecer (a decisão é dele), e é ele que sobrevive ao
/// reload. Isto é EFEITO, não decisão: nada aqui muda o veredito de
/// `decidir_recuperacao`.
///
/// Devolve quantas janelas foram fechadas (o log da recuperação usa o número).
pub fn fechar_toasts_por_recuperacao(app: &AppHandle) -> usize {
    let ids: Vec<String> = {
        let state = app.state::<ToastState>();
        let ids = state.stack.lock().unwrap().clone();
        ids
    };
    let mut n = 0usize;
    let mut ja: Vec<String> = Vec::new();
    for id in ids {
        let label = format!("toast-{id}");
        if app.get_webview_window(&label).is_some() {
            n += 1;
            // O `close()` é assíncrono: a janela ainda aparece no mapa logo
            // depois. Sem esta lista a varredura de órfãs contaria a MESMA
            // janela de novo e o log mentiria o número.
            ja.push(label);
        }
        fechar(app, &id);
    }
    // Varredura de órfãs: janela `toast-*` cujo estado já foi esquecido (o
    // `esquecer` roda no evento de fechamento) continuaria na tela. Aqui não
    // sobra nenhuma.
    let orfas: Vec<String> = app
        .webview_windows()
        .keys()
        .filter(|l| l.starts_with("toast-") && !ja.contains(l))
        .cloned()
        .collect();
    for label in orfas {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.close();
            n += 1;
        }
    }
    // O estado tem que ficar VAZIO: é ele que o teste vivo inspeciona.
    {
        let state = app.state::<ToastState>();
        state.data.lock().unwrap().clear();
        state.stack.lock().unwrap().clear();
        state.pinned.lock().unwrap().clear();
    }
    n
}

/* ---------------------------------------------------------------------------
   PROVA VIVA de N1/N2/N3. Só existe em debug (`ganchos_de_teste`), roda no
   banco de provas (`ZAPLITE_ALVO` + `ZAPLITE_PERFIL_TESTE`) e não escreve uma
   linha no `settings.json`: as regras são montadas aqui, na memória.
   Nada disto entra no binário de release.
--------------------------------------------------------------------------- */

#[cfg(debug_assertions)]
fn toast_de_prova(id: &str, style: &str, pos: &str, pct: u64, op: f64, dur: u64) -> Toast {
    let r = Regra {
        style: style.into(),
        position: pos.into(),
        size_pct: pct,
        opacity: op,
        duration: dur,
        sound: "nenhum".into(),
        ..Regra::default()
    };
    let req = ToastRequest {
        id: id.into(),
        sender: format!("Prova {style}"),
        body: format!("{style} no canto {pos} a {pct}%"),
        chat_id: "5511900000000@c.us".into(),
        ..Default::default()
    };
    montar_com(&req, &r, false)
}

/// Mede as janelas `toast-*` VIVAS: onde estão, que tamanho têm, se alguma
/// escapou da área útil e se alguma encosta em outra. Devolve VÁRIAS linhas
/// curtas porque o `connection.log` corta cada `reason` em 160 caracteres.
#[cfg(debug_assertions)]
fn medir_linhas(app: &AppHandle) -> Vec<String> {
    let (area, _) = area_util(app);
    let (stack, data) = {
        let st = app.state::<ToastState>();
        let s = st.stack.lock().unwrap().clone();
        let d = st.data.lock().unwrap().clone();
        (s, d)
    };
    let mut caixas: Vec<(String, f64, f64, f64, f64)> = Vec::new();
    for id in &stack {
        let Some(w) = app.get_webview_window(&format!("toast-{id}")) else { continue };
        let (Ok(p), Ok(s)) = (w.outer_position(), w.outer_size()) else { continue };
        let rotulo = data
            .get(id)
            .map(|t| format!("{}|{}|{}%", t.style, t.position, t.size_pct))
            .unwrap_or_else(|| id.clone());
        caixas.push((rotulo, p.x as f64, p.y as f64, s.width as f64, s.height as f64));
    }
    let (ax, ay, aw, ah) = area;
    let mut fora: Vec<String> = Vec::new();
    let mut colisoes: Vec<String> = Vec::new();
    for (i, a) in caixas.iter().enumerate() {
        if a.1 < ax || a.2 < ay || a.1 + a.3 > ax + aw || a.2 + a.4 > ay + ah {
            fora.push(a.0.clone());
        }
        for b in caixas.iter().skip(i + 1) {
            if a.1 < b.1 + b.3 && b.1 < a.1 + a.3 && a.2 < b.2 + b.4 && b.2 < a.2 + a.4 {
                colisoes.push(format!("{} x {}", a.0, b.0));
            }
        }
    }
    let mut linhas = vec![format!(
        "area_util=({ax},{ay},{aw},{ah}) janelas={} stack={} data={}",
        caixas.len(),
        stack.len(),
        data.len()
    )];
    for c in &caixas {
        linhas.push(format!(
            "  {} pos=({},{}) tam={}x{} dir={} baixo={}",
            c.0,
            c.1,
            c.2,
            c.3,
            c.4,
            ax + aw - (c.1 + c.3), // folga até a borda direita da área útil
            ay + ah - (c.2 + c.4)  // folga até a barra de tarefas
        ));
    }
    linhas.push(format!(
        "  FORA_DA_AREA={fora:?} COLISOES={colisoes:?} => {}",
        if fora.is_empty() && colisoes.is_empty() && !caixas.is_empty() {
            "PASSOU"
        } else if caixas.is_empty() {
            "SEM JANELAS (inconclusivo)"
        } else {
            "FALHOU"
        }
    ));
    linhas
}

/// Clica, de dentro da página do toast, num dos botões da barra de ações
/// (0 = 📌 fixar, 1 = ⏰, 2 = 🔕) ou no CORPO do toast (`None`).
#[cfg(debug_assertions)]
fn clicar_no_toast(app: &AppHandle, id: &str, botao: Option<usize>) {
    let Some(w) = app.get_webview_window(&format!("toast-{id}")) else { return };
    let js = match botao {
        Some(i) => format!(
            "(function(){{var b=document.querySelectorAll('.acts button')[{i}];if(b)b.click();}})()"
        ),
        None => "(function(){var t=document.getElementById('toast');if(t)t.click();})()".to_string(),
    };
    let _ = w.eval(&js);
}

#[cfg(debug_assertions)]
pub fn prova_janelas(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let diag = |t: &str| crate::connection::note_diag(&app, t);
        let dormir = |ms: u64| tokio::time::sleep(Duration::from_millis(ms));
        let vivo = |id: &str| app.get_webview_window(&format!("toast-{id}")).is_some();
        let relatar = |rotulo: &str| {
            for l in medir_linhas(&app) {
                crate::connection::note_diag(&app, &format!("{rotulo} {l}"));
            }
        };
        dormir(3500).await;

        /* --- (a1) os QUATRO cantos ao mesmo tempo, estilos misturados ------ */
        for (i, (estilo, canto, pct)) in [
            ("card", "inferior-direita", 100u64),
            ("painel", "superior-direita", 100),
            ("mini", "superior-esquerda", 150),
            ("faixa", "inferior-esquerda", 120),
        ]
        .iter()
        .enumerate()
        {
            if let Err(e) =
                mostrar_resolvido(app.clone(), toast_de_prova(&format!("pv-canto-{i}"), estilo, canto, *pct, 1.0, 600))
            {
                diag(&format!("N2 (a1) FALHA ao abrir pv-canto-{i}: {e}"));
            }
            dormir(600).await;
        }
        dormir(1500).await;
        relatar("N2 (a1) QUATRO CANTOS:");
        let _ = close_all_toasts(app.clone());
        dormir(2000).await;

        /* --- (a2) uma coluna só, com os estilos novos e tamanhos por regra -- */
        for (i, (estilo, pct)) in [("painel", 100u64), ("destaque", 100), ("card", 130), ("mini", 80)]
            .iter()
            .enumerate()
        {
            if let Err(e) = mostrar_resolvido(
                app.clone(),
                toast_de_prova(&format!("pv-col-{i}"), estilo, "superior-direita", *pct, 0.85, 600),
            ) {
                diag(&format!("N2 (a2) FALHA ao abrir pv-col-{i}: {e}"));
            }
            dormir(600).await;
            let st = app.state::<ToastState>();
            let ids = st.stack.lock().unwrap().clone();
            let janelas = app
                .webview_windows()
                .keys()
                .filter(|l| l.starts_with("toast-"))
                .count();
            diag(&format!("N2 (a2) apos pv-col-{i}: stack={ids:?} janelas={janelas}"));
        }
        dormir(1500).await;
        relatar("N2 (a2) COLUNA superior-direita:");
        let _ = close_all_toasts(app.clone());
        dormir(2000).await;

        /* --- (b) o 📌 impede o fechamento automático ----------------------- */
        // duração de 4s: se o fixar não funcionasse, este toast morreria sozinho.
        let _ = mostrar_resolvido(
            app.clone(),
            toast_de_prova("pv-fix", "card", "inferior-direita", 100, 1.0, 4),
        );
        dormir(1500).await;
        clicar_no_toast(&app, "pv-fix", Some(0)); // 📌
        dormir(800).await;
        let fixado_no_estado = app.state::<ToastState>().pinned.lock().unwrap().contains("pv-fix");
        diag(&format!(
            "N1 (b) apos clicar no 📌: vivo={} pinned={fixado_no_estado}",
            vivo("pv-fix")
        ));
        // muito depois do tempo de exibição normal (4s)
        dormir(12000).await;
        let sobreviveu_ao_tempo = vivo("pv-fix");
        // e agora a rotatividade: 6 toasts novos, com MAX_TOASTS=5
        for i in 0..6 {
            let _ = mostrar_resolvido(
                app.clone(),
                toast_de_prova(&format!("pv-onda-{i}"), "card", "inferior-direita", 100, 1.0, 600),
            );
            dormir(400).await;
        }
        dormir(1200).await;
        let sobreviveu_a_onda = vivo("pv-fix");
        diag(&format!(
            "N1 (b) RESULTADO: vivo_apos_3x_o_tempo={sobreviveu_ao_tempo} vivo_apos_onda_de_6={sobreviveu_a_onda} => {}",
            if sobreviveu_ao_tempo && sobreviveu_a_onda { "PASSOU" } else { "FALHOU" }
        ));
        relatar("N1 (b) com o fixado na pilha:");
        let _ = close_all_toasts(app.clone());
        dormir(900).await;

        /* --- (c) os botões NÃO abrem a conversa ---------------------------- */
        // `focus_chat` é o único caminho que grava `pedido_chat`. Se um botão
        // vazasse o clique para o corpo, o pedido apareceria aqui.
        let pedido = || app.state::<ToastState>().pedido_chat.lock().unwrap().is_some();
        *app.state::<ToastState>().pedido_chat.lock().unwrap() = None;
        let _ = mostrar_resolvido(
            app.clone(),
            toast_de_prova("pv-btn", "card", "inferior-direita", 100, 1.0, 600),
        );
        dormir(1500).await;
        clicar_no_toast(&app, "pv-btn", Some(0)); // 📌 — age e NÃO fecha
        dormir(900).await;
        let apos_pin = (pedido(), vivo("pv-btn"));
        // ⏰ e 🔕 saem do MESMO `botao()`, com o mesmo par de stopPropagation;
        // a prova usa o ⏰ porque o 🔕 escreveria no `settings.json` do usuário.
        clicar_no_toast(&app, "pv-btn", Some(1)); // ⏰ — fecha, mas sem abrir conversa
        dormir(1200).await;
        let apos_mute = (pedido(), vivo("pv-btn"));
        // controle: o CORPO tem que abrir a conversa, senão a prova acima não vale
        let _ = mostrar_resolvido(
            app.clone(),
            toast_de_prova("pv-corpo", "card", "inferior-direita", 100, 1.0, 600),
        );
        dormir(1500).await;
        clicar_no_toast(&app, "pv-corpo", None);
        dormir(1200).await;
        let apos_corpo = pedido();
        diag(&format!(
            "N3 (c) pedido_chat apos 📌={} (toast vivo={}) | apos ⏰={} (vivo={}) | apos CORPO={apos_corpo} => {}",
            apos_pin.0, apos_pin.1, apos_mute.0, apos_mute.1,
            if !apos_pin.0 && !apos_mute.0 && apos_corpo { "PASSOU" } else { "FALHOU" }
        ));

        let _ = close_all_toasts(app.clone());
        *app.state::<ToastState>().pedido_chat.lock().unwrap() = None;
        dormir(600).await;
        diag(&format!(
            "PROVA JANELA: fim — janelas toast-* restantes = {}",
            app.webview_windows().keys().filter(|l| l.starts_with("toast-")).count()
        ));
    });
}

#[cfg(test)]
mod testes {
    use super::*;

    fn pedido() -> ToastRequest {
        ToastRequest {
            id: "t1".into(),
            sender: "Fulano".into(),
            author: "Senha".into(),
            body: "1234".into(),
            avatar: String::new(),
            chat_id: "5511@c.us".into(),
            muted: false,
            is_group: false,
            mention_mark: false,
            time: "16:35".into(),
            clock: String::new(),
        }
    }

    fn grupo() -> ToastRequest {
        ToastRequest {
            sender: "Playstation Adrenaline".into(),
            author: "Marcelo".into(),
            body: "bom dia".into(),
            chat_id: "12036@g.us".into(),
            is_group: true,
            ..pedido()
        }
    }

    /// W1(a) — REGRESSÃO DO RELATO REAL. O settings do usuário tinha UMA regra,
    /// `contém: "Gi"`, e a lógica antiga deixava qualquer regra explícita furar
    /// o silêncio do WhatsApp. "Gi" casa com Regina, Rodrigo, Logística — e com
    /// grupos silenciados. Agora só a caixa `breakMute` fura.
    #[test]
    fn regra_explicita_nao_fura_mais_o_silencio_do_whatsapp() {
        let s = json!({"notify": {
            "rules": [{"enabled": true, "match": "Gi", "mode": "contém", "style": "destaque"}],
            "default": {"style": "card"}
        }});
        for nome in ["Regina", "Rodrigo", "Logística SP", "Gigi"] {
            let req = ToastRequest { sender: nome.into(), muted: true, ..pedido() };
            assert_eq!(
                decidir(&s, &req),
                Decisao::Silencio("silenciada no WhatsApp"),
                "{nome} está silenciado no WhatsApp e casou com a regra 'Gi'"
            );
        }
        // não silenciado no WhatsApp: a mesma regra notifica normalmente
        let req = ToastRequest { sender: "Regina".into(), ..pedido() };
        assert!(matches!(decidir(&s, &req), Decisao::Mostrar(r, false) if r.style == "destaque"));
    }

    /// W1(a) — a porta existe, e é por regra.
    #[test]
    fn break_mute_por_regra_fura_o_silencio_e_so_para_aquela_regra() {
        let s = json!({"notify": {
            "rules": [
                {"enabled": true, "match": "chefe", "mode": "contém", "breakMute": true, "style": "destaque"},
                {"enabled": true, "match": "gi", "mode": "contém", "style": "faixa"}
            ],
            "default": {"style": "card"}
        }});
        let chefe = ToastRequest { sender: "Chefe".into(), muted: true, ..pedido() };
        assert!(matches!(decidir(&s, &chefe), Decisao::Mostrar(r, false) if r.style == "destaque"));
        let gi = ToastRequest { sender: "Regina".into(), muted: true, ..pedido() };
        assert_eq!(decidir(&s, &gi), Decisao::Silencio("silenciada no WhatsApp"));
        // e a regra padrão nunca fura, nem a de fábrica
        let outro = ToastRequest { sender: "Ninguém".into(), muted: true, ..pedido() };
        assert_eq!(decidir(&s, &outro), Decisao::Silencio("silenciada no WhatsApp"));
        assert_eq!(decidir(&json!({}), &outro), Decisao::Silencio("silenciada no WhatsApp"));
    }

    /// W1(b) — a lista de caixinhas do Painel cala a conversa mesmo sem
    /// silenciamento no WhatsApp, casa por id (não por nome) e vence a menção.
    #[test]
    fn lista_do_painel_cala_por_id_e_vence_tudo() {
        let s = json!({"notify": {
            "muted": ["12036@g.us", {"id": "999@g.us", "name": "Outro"}],
            "mention": {"enabled": true, "breakMute": true, "anyAt": true},
            "rules": [{"enabled": true, "match": "playstation", "mode": "contém", "breakMute": true}]
        }});
        let g = ToastRequest { body: "@alexandre vem".into(), ..grupo() };
        assert_eq!(decidir(&s, &g), Decisao::Silencio("silenciada na lista do Painel"));
        let outro = ToastRequest { chat_id: "999@g.us".into(), ..grupo() };
        assert_eq!(decidir(&s, &outro), Decisao::Silencio("silenciada na lista do Painel"));
        // conversa fora da lista continua notificando
        let livre = ToastRequest { chat_id: "111@g.us".into(), ..grupo() };
        assert!(matches!(decidir(&s, &livre), Decisao::Mostrar(_, _)));
        // id vazio nunca casa com a lista
        let sem_id = ToastRequest { chat_id: String::new(), ..grupo() };
        assert!(!na_lista_de_mudos(&s, &sem_id.chat_id));
    }

    /// W4 — menção: três sinais, só em grupo, e só fura o silêncio por opção.
    #[test]
    fn snooze_usa_o_padrao_quando_o_valor_e_absurdo() {
        assert_eq!(snooze_minutos(&json!({})), SNOOZE_PADRAO_MIN);
        assert_eq!(snooze_minutos(&json!({"notify":{"snoozeMinutes":25}})), 25);
        // 0 reabriria o toast no mesmo instante, num laço; 999 é esquecimento.
        assert_eq!(snooze_minutos(&json!({"notify":{"snoozeMinutes":0}})), SNOOZE_PADRAO_MIN);
        assert_eq!(snooze_minutos(&json!({"notify":{"snoozeMinutes":999}})), SNOOZE_PADRAO_MIN);
        assert_eq!(snooze_minutos(&json!({"notify":{"snoozeMinutes":"dez"}})), SNOOZE_PADRAO_MIN);
    }

    #[test]
    fn silenciar_pelo_toast_entra_na_mesma_lista_do_painel_e_nao_duplica() {
        let s = json!({"theme":"escuro","notify":{"rules":[{"match":"Gi"}]}});
        let s = com_chat_silenciado(s, "5511@c.us", "Gi");
        // entrou na lista que o `decidir` já consulta
        assert!(na_lista_de_mudos(&s, "5511@c.us"));
        // e o resto do settings continua de pé (é o arquivo real do usuário)
        assert_eq!(s["theme"], "escuro");
        assert_eq!(s["notify"]["rules"].as_array().unwrap().len(), 1);

        // silenciar de novo não cria uma segunda linha
        let s = com_chat_silenciado(s, "5511@c.us", "Gi");
        assert_eq!(s["notify"]["muted"].as_array().unwrap().len(), 1);

        // id vazio não vira entrada: silenciaria "todo mundo sem id"
        let s = com_chat_silenciado(s, "", "seja lá quem for");
        assert_eq!(s["notify"]["muted"].as_array().unwrap().len(), 1);

        // e o toast daquela conversa passa a ser engolido
        let req = ToastRequest { chat_id: "5511@c.us".into(), ..pedido() };
        assert!(matches!(decidir(&s, &req), Decisao::Silencio(_)));
    }

    #[test]
    fn silenciar_pelo_toast_funciona_com_settings_vazio() {
        // instalação de fábrica: `notify` nem existe ainda
        let s = com_chat_silenciado(json!({}), "12036@g.us", "Grupo");
        assert!(na_lista_de_mudos(&s, "12036@g.us"));
    }

    /// M4 — o marcador de menção da linha é de NÍVEL (fica enquanto a menção
    /// não for lida). Se fosse lido por presença, a menção "grudaria": toda
    /// mensagem seguinte do grupo sairia com cara de menção — e, com
    /// `breakMute`, furando o silêncio do grupo inteiro. Vale por TRANSIÇÃO.
    #[test]
    fn mencao_vale_uma_vez_por_transicao_e_nao_gruda_enquanto_o_marcador_fica() {
        let mut mem = HashMap::new();
        let g = "12036@g.us";

        // a mensagem que TRAZ a menção: marcador subiu agora → é menção
        assert!(registrar_mencao(&mut mem, g, true));
        // as seguintes chegam com o marcador AINDA ligado (menção não lida):
        // não são menção nenhuma
        assert!(!registrar_mencao(&mut mem, g, true));
        assert!(!registrar_mencao(&mut mem, g, true));

        // o usuário leu a menção: o marcador some. Isso não notifica nada,
        // mas REARMA a próxima.
        assert!(!registrar_mencao(&mut mem, g, false));
        assert!(registrar_mencao(&mut mem, g, true));

        // grupos diferentes não interferem um no outro
        let outro = "999@g.us";
        assert!(registrar_mencao(&mut mem, outro, true));
        assert!(!registrar_mencao(&mut mem, g, true));

        // sem id não há memória possível: o nível vale como veio
        assert!(registrar_mencao(&mut mem, "", true));
        assert!(registrar_mencao(&mut mem, "", true));
        assert!(!registrar_mencao(&mut mem, "", false));

        // a borda pura, isolada
        assert!(borda_de_mencao(None, true));
        assert!(borda_de_mencao(Some(false), true));
        assert!(!borda_de_mencao(Some(true), true));
        assert!(!borda_de_mencao(Some(true), false));
    }

    /// A memória de menção não pode virar depósito: a página é origem hostil e
    /// pode inventar `chat_id` a cada toast.
    #[test]
    fn memoria_de_mencao_tem_teto() {
        let mut mem = HashMap::new();
        for i in 0..(MENCAO_MEM_MAX + 50) {
            registrar_mencao(&mut mem, &format!("{i}@g.us"), true);
        }
        assert!(mem.len() <= MENCAO_MEM_MAX, "memória sem teto: {}", mem.len());
    }

    /// O efeito de ponta a ponta do que M4 conserta: com o marcador GRUDADO e
    /// `breakMute` ligado, a segunda mensagem do grupo silenciado tem que ser
    /// engolida. É `decidir` quem prova isso, com o marcador já resolvido em
    /// borda (é o que o `show_toast` faz antes de chamá-la).
    #[test]
    fn mencao_grudada_nao_fura_o_silencio_das_mensagens_seguintes() {
        let s = json!({"notify": {
            "mention": {"enabled": true, "breakMute": true, "style": "destaque", "sound": "alerta"}
        }});
        let mut mem = HashMap::new();
        let g = "12036@g.us";
        let bruto = ToastRequest {
            chat_id: g.into(),
            is_group: true,
            muted: true,
            mention_mark: true,
            ..pedido()
        };

        // 1ª mensagem: a que contém a menção — fura o silêncio, como pedido
        let mut req = bruto.clone();
        req.mention_mark = registrar_mencao(&mut mem, g, bruto.mention_mark);
        assert!(matches!(decidir(&s, &req), Decisao::Mostrar(_, true)));

        // 2ª e 3ª: marcador ainda lá, mas não são menção — o grupo está
        // silenciado no WhatsApp e volta a calar
        for _ in 0..2 {
            let mut req = bruto.clone();
            req.mention_mark = registrar_mencao(&mut mem, g, bruto.mention_mark);
            assert_eq!(decidir(&s, &req), Decisao::Silencio("silenciada no WhatsApp"));
        }
    }

    #[test]
    fn mencao_usa_tres_sinais_so_em_grupo_e_fura_o_silencio_por_opcao() {
        let s = json!({"notify": {
            "mention": {"enabled": true, "breakMute": true, "handles": ["Alexandre", "@alex"],
                        "style": "destaque", "sound": "alerta"},
            "rules": [], "default": {"style": "card"}
        }});
        // sinal 1: marcador do WhatsApp na linha
        let m1 = ToastRequest { mention_mark: true, muted: true, ..grupo() };
        assert!(matches!(decidir(&s, &m1), Decisao::Mostrar(_, true)));
        // sinal 2: apelido depois de "@" na prévia
        let m2 = ToastRequest { body: "bom dia @Alexandre confere isso".into(), muted: true, ..grupo() };
        assert!(matches!(decidir(&s, &m2), Decisao::Mostrar(r, true) if r.sound == "alerta"));
        // "@" de outra pessoa NÃO é menção
        let m3 = ToastRequest { body: "@Carla LPU".into(), muted: true, ..grupo() };
        assert_eq!(decidir(&s, &m3), Decisao::Silencio("silenciada no WhatsApp"));
        // 1:1 nunca entra no caminho de menção (e-mail tem "@")
        let m4 = ToastRequest { body: "alexandre@empresa.com".into(), is_group: false, ..pedido() };
        assert!(!e_mencao(&mencao_config(&s), &m4));
        // sem breakMute, menção em grupo silenciado continua calada
        let s2 = json!({"notify": {"mention": {"enabled": true, "breakMute": false, "handles": ["Alexandre"]}}});
        let m5 = ToastRequest { body: "@Alexandre".into(), muted: true, ..grupo() };
        assert_eq!(decidir(&s2, &m5), Decisao::Silencio("menção em grupo silenciado no WhatsApp"));
        // ... mas notifica se o grupo NÃO estiver silenciado
        let m6 = ToastRequest { body: "@Alexandre".into(), ..grupo() };
        assert!(matches!(decidir(&s2, &m6), Decisao::Mostrar(_, true)));
        // menção desligada: cai no caminho normal
        let s3 = json!({"notify": {"mention": {"enabled": false, "handles": ["Alexandre"]}}});
        assert!(matches!(decidir(&s3, &m6), Decisao::Mostrar(_, false)));
        // anyAt é grosseiro de propósito e fica desligado por padrão
        assert!(!mencao_config(&json!({})).any_at);
        assert!(!mencao_config(&json!({})).enabled);
    }

    /// O toast marca a menção — é o que justifica o furo do silêncio aparecer.
    #[test]
    fn toast_de_mencao_carrega_a_marca() {
        assert!(montar_com(&grupo(), &Regra::default(), true).mention);
        assert!(!montar(&grupo(), &Regra::default()).mention);
    }

    /// W2 — o toast tem que sair com DATA e HORA, e nunca em branco.
    #[test]
    fn horario_traz_data_e_hora_e_nunca_fica_vazio() {
        // rótulo de hoje (só relógio) ganha a data na frente
        assert_eq!(compor_horario("16:35", "", "15/08", "22:10"), "15/08 16:35");
        assert_eq!(compor_horario("9:05", "", "15/08", "22:10"), "15/08 9:05");
        // rótulo que JÁ é data fica como está — inventar hora seria mentir
        for r in ["Ontem", "sexta-feira", "07/08/2026"] {
            assert_eq!(compor_horario(r, "", "15/08", "22:10"), r);
        }
        // linha sem rótulo: data + hora do disparo, nunca vazio
        assert_eq!(compor_horario("", "", "15/08", "22:10"), "15/08 22:10");
        assert_eq!(compor_horario("   ", "", "15/08", "22:10"), "15/08 22:10");
        // e nada disso pode devolver string vazia
        for r in ["", "x", "16:35", "Ontem"] {
            assert!(!compor_horario(r, "", "15/08", "22:10").is_empty());
        }

        // no caminho inteiro: `montar` usa o relógio local, então só dá para
        // afirmar que a hora da linha sobreviveu dentro do resultado
        let t = montar(&pedido(), &Regra::default());
        assert!(t.time.ends_with("16:35"), "veio {:?}", t.time);
        assert!(t.time.len() > 5, "faltou a data: {:?}", t.time);

        // ocultar prévia não pode apagar o horário: ele não é conteúdo
        let t3 = montar(&pedido(), &Regra { hide_preview: true, ..Regra::default() });
        assert_eq!(t3.time, t.time);
    }

    /// V3 — rótulo de DIA compõe com a hora quando ela existe na linha, e só
    /// quando existe. O toast do print mostrava "quarta-feira" e nada mais.
    #[test]
    fn rotulo_de_dia_compoe_com_a_hora_da_linha_quando_ela_existe() {
        // com hora medida na linha: as duas coisas juntas
        assert_eq!(
            compor_horario("quarta-feira", "14:32", "15/08", "22:10"),
            "quarta-feira 14:32"
        );
        assert_eq!(compor_horario("Ontem", "07:05", "15/08", "22:10"), "Ontem 07:05");
        assert_eq!(
            compor_horario("07/08/2026", "23:59", "15/08", "22:10"),
            "07/08/2026 23:59"
        );
        // sem hora na linha: fica como está, nada de inventar
        assert_eq!(compor_horario("quarta-feira", "", "15/08", "22:10"), "quarta-feira");
        assert_eq!(compor_horario("Ontem", "   ", "15/08", "22:10"), "Ontem");
        // lixo no campo da hora não vira horário
        for c in ["ontem", "25:99h", "14h32", "1234", ":", "14:3"] {
            assert_eq!(
                compor_horario("quarta-feira", c, "15/08", "22:10"),
                "quarta-feira",
                "clock {c:?} não podia ser aceito"
            );
        }
        // rótulo que já é relógio ignora o campo: a data de hoje é que entra
        assert_eq!(compor_horario("16:35", "09:00", "15/08", "22:10"), "15/08 16:35");
        // rótulo que já traz hora não ganha uma segunda
        assert_eq!(
            compor_horario("Ontem 09:00", "14:32", "15/08", "22:10"),
            "Ontem 09:00"
        );
    }

    #[test]
    fn sem_settings_ainda_notifica_com_som() {
        // P2: instalação de fábrica não pode virar apagão de notificação.
        let r = regra_para(&json!({}), "Qualquer Um");
        assert!(!r.mute, "a regra de fábrica não pode silenciar");
        assert_eq!(r.sound, "toque");
        assert_eq!(r.duration, 7);
        assert_eq!(r.style, "card");

        // idem com o objeto notify presente mas vazio (o Painel grava assim)
        let r2 = regra_para(&json!({"notify": {"rules": []}}), "Qualquer Um");
        assert!(!r2.mute);
        assert_eq!(r2, r);
    }

    #[test]
    fn regra_do_contato_vence_a_padrao_e_o_mute_e_respeitado() {
        let s = json!({"notify": {
            "rules": [
                {"enabled": true, "match": "sogra", "mode": "contém", "mute": true},
                {"enabled": true, "match": "chefe", "mode": "exato", "style": "destaque", "sound": "sino"}
            ],
            "default": {"style": "discreto", "sound": "nenhum"}
        }});
        assert!(regra_para(&s, "Sogra querida").mute);
        assert_eq!(regra_para(&s, "Chefe").style, "destaque");
        assert_eq!(regra_para(&s, "Chefe do chefe").style, "discreto"); // "exato" não casa
        assert_eq!(regra_para(&s, "Ninguém").sound, "nenhum");
    }

    #[test]
    fn ocultar_previa_mascara_corpo_e_autor() {
        // P5: o autor sai de uma regex sobre a prévia; mascarar só o corpo
        // deixava "Senha" na tela com a opção ligada.
        let r = Regra { hide_preview: true, ..Regra::default() };
        let t = montar(&pedido(), &r);
        assert_eq!(t.body, "Nova mensagem");
        assert_eq!(t.author, "");
        assert!(!format!("{t:?}").contains("1234"));
        assert_eq!(t.chat_id, "5511@c.us"); // o id da conversa continua indo
    }

    #[test]
    fn sem_ocultar_previa_o_conteudo_passa() {
        let t = montar(&pedido(), &Regra::default());
        assert_eq!(t.body, "1234");
        assert_eq!(t.author, "Senha");
    }

    #[test]
    fn empilhamento_nao_repete_posicao_nem_invade_a_barra_de_tarefas() {
        // P7: área útil de 1920x1040 (barra de 40px embaixo), 4 toasts card.
        let area = (0.0, 0.0, 1920.0, 1040.0);
        let tamanhos = vec![(380.0, 124.0); 4];
        let ps = posicoes(area, 1.0, "inferior-direita", &tamanhos);
        let unicos: std::collections::HashSet<_> = ps.iter().collect();
        assert_eq!(unicos.len(), 4, "toasts empilhados no mesmo pixel: {ps:?}");
        for (x, y) in &ps {
            assert!(*y >= 0 && (*y as f64) + 124.0 <= 1040.0, "saiu da área útil: {y}");
            assert_eq!(*x, 1920 - 380 - 16);
        }
        // o mais novo é o de baixo e fica ACIMA do fim da área útil
        assert_eq!(ps[0].1, 1040 - 16 - 124);
    }

    #[test]
    fn monitor_secundario_desloca_a_origem() {
        let ps = posicoes(
            (-1920.0, 0.0, 1920.0, 1040.0),
            1.0,
            "inferior-direita",
            &[(380.0, 124.0)],
        );
        assert_eq!(ps[0].0, -1920 + 1920 - 380 - 16);
    }

    #[test]
    fn teto_de_toasts_respeita_altura_util_e_o_maximo() {
        // 6 cards (124px) não cabem em 500px de altura útil
        let alturas = vec![124.0; 6];
        assert_eq!(cabem(500.0, 1.0, &alturas), 3);
        // e mesmo com tela sobrando, o teto de contagem vale
        assert_eq!(cabem(4000.0, 1.0, &alturas), MAX_TOASTS);
    }

    /// N2/N3 — os QUATRO cantos, com os estilos novos misturados: nenhuma
    /// janela pode sair da área útil (nem por cima da barra de tarefas), e
    /// dentro de uma coluna ninguém pode se sobrepor a ninguém.
    #[test]
    fn os_quatro_cantos_ficam_na_area_util_e_nao_colidem() {
        // monitor secundário à esquerda, barra de tarefas de 40px embaixo e
        // 1,5x de escala: o caso que junta todas as armadilhas de uma vez.
        let area = (-1920.0, 0.0, 1920.0, 1040.0);
        let scale = 1.5;
        let estilos = ["card", "faixa", "destaque", "discreto", "painel", "mini"];
        let tamanhos: Vec<(f64, f64)> = estilos.iter().map(|e| size_for(e, 100)).collect();
        for canto in [
            "inferior-direita",
            "superior-direita",
            "superior-esquerda",
            "inferior-esquerda",
        ] {
            let quantos = cabem(area.3, scale, &tamanhos.iter().map(|t| t.1).collect::<Vec<_>>());
            let usados = &tamanhos[..quantos];
            let ps = posicoes(area, scale, canto, usados);
            for (i, ((w, h), (x, y))) in usados.iter().zip(&ps).enumerate() {
                let (wp, hp) = (w * scale, h * scale);
                assert!(
                    (*x as f64) >= area.0 && (*x as f64) + wp <= area.0 + area.2,
                    "{canto}: saiu na horizontal em {i}: x={x} w={wp}"
                );
                assert!(
                    (*y as f64) >= area.1 && (*y as f64) + hp <= area.1 + area.3,
                    "{canto}: saiu na vertical em {i}: y={y} h={hp}"
                );
                // sem colisão com nenhum outro da MESMA coluna
                for (j, ((w2, h2), (x2, y2))) in usados.iter().zip(&ps).enumerate() {
                    if i == j {
                        continue;
                    }
                    let (wp2, hp2) = (w2 * scale, h2 * scale);
                    let cruza_x = (*x as f64) < (*x2 as f64) + wp2 && (*x2 as f64) < (*x as f64) + wp;
                    let cruza_y = (*y as f64) < (*y2 as f64) + hp2 && (*y2 as f64) < (*y as f64) + hp;
                    assert!(!(cruza_x && cruza_y), "{canto}: {i} colide com {j}: {ps:?}");
                }
            }
            // o mais novo encosta no canto certo
            let (w0, h0) = usados[0];
            let esperado_x = if canto.ends_with("esquerda") {
                (area.0 + MARGEM * scale).round() as i32
            } else {
                (area.0 + area.2 - w0 * scale - MARGEM * scale).round() as i32
            };
            let esperado_y = if canto.starts_with("superior") {
                (area.1 + MARGEM * scale).round() as i32
            } else {
                (area.1 + area.3 - MARGEM * scale - h0 * scale).round() as i32
            };
            assert_eq!((ps[0].0, ps[0].1), (esperado_x, esperado_y), "canto {canto}");
        }
    }

    /// N2 — tamanho por regra muda a janela DE VERDADE (é o mesmo `size_for`
    /// que empilha, então não existe estilo que ocupe diferente do que reserva)
    /// e nunca escapa da faixa 80..150%. `0` é "não escrito", e vale 100%.
    #[test]
    fn tamanho_por_regra_escala_e_fica_na_faixa() {
        assert_eq!(size_for("card", 100), (380.0, 124.0));
        assert_eq!(size_for("card", 0), (380.0, 124.0));
        assert_eq!(size_for("card", 150), (570.0, 186.0));
        assert_eq!(size_for("card", 5), size_for("card", SIZE_PCT_MIN));
        assert_eq!(size_for("card", 9999), size_for("card", SIZE_PCT_MAX));
        // os dois estilos novos: um maior que o destaque, um menor que o discreto
        assert!(size_for("painel", 100).1 > size_for("destaque", 100).1);
        assert!(size_for("mini", 100).1 < size_for("discreto", 100).1);
    }

    /// N1 — o conflito do fixado com o teto: fixar sai da rotatividade, mas
    /// não pode tomar a coluna. Teto de contagem E teto de metade da altura.
    #[test]
    fn fixar_tem_teto_de_contagem_e_de_metade_da_coluna() {
        let (_, alt) = size_for("card", 100); // 124
        // coluna de 1040px: dois cards fixados cabem na metade, o terceiro não
        assert!(pode_fixar(1040.0, 1.0, &[], alt, 0));
        assert!(pode_fixar(1040.0, 1.0, &[alt], alt, 1));
        assert!(
            !pode_fixar(1040.0, 1.0, &[alt, alt, alt], alt, 3),
            "passou do teto de contagem"
        );
        // tela baixa: um `painel` já é mais da metade e não pode ser fixado
        let (_, painel) = size_for("painel", 100); // 260
        assert!(
            !pode_fixar(400.0, 1.0, &[], painel, 0),
            "fixado tomando mais de metade da coluna"
        );
        // e o teto de fixados é sempre menor que o teto de toasts: com todos
        // os fixados possíveis ainda sobra vaga para mensagem nova.
        assert!(MAX_PINNED < MAX_TOASTS);
    }

    /// N2 — opacidade e canto vindos do settings passam pela regra até o toast,
    /// e lixo (canto inventado, opacidade 0 ou 3.0) cai no padrão de antes.
    #[test]
    fn canto_e_opacidade_saem_da_regra_e_lixo_cai_no_padrao() {
        let s = json!({"notify":{"default":{
            "position":"superior-esquerda","opacity":0.5,"sizePct":130}}});
        let r = regra_para(&s, "Fulano");
        assert_eq!(r.position, "superior-esquerda");
        assert_eq!(r.size_pct, 130);
        assert!((r.opacity - 0.5).abs() < 1e-9);
        let t = montar(&pedido(), &r);
        assert_eq!(t.position, "superior-esquerda");
        assert_eq!(t.size_pct, 130);

        let lixo = json!({"notify":{"default":{
            "position":"no-meio-da-tela","opacity":3.0,"sizePct":9000}}});
        let r = regra_para(&lixo, "Fulano");
        assert_eq!(r.position, "inferior-direita");
        assert_eq!(r.size_pct, SIZE_PCT_MAX);
        assert!((r.opacity - 1.0).abs() < 1e-9);
        // settings sem nada escrito = exatamente o comportamento histórico
        let r = regra_para(&json!({}), "Fulano");
        assert_eq!(r.position, "inferior-direita");
        assert_eq!(r.size_pct, 100);
        assert!((r.opacity - 1.0).abs() < 1e-9);
        assert!(opacidade_valida(0.01) >= OPACIDADE_MIN);
    }
}
