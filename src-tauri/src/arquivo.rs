//! Arquivo local de conversas — a fonte que o servidor MCP (`mcp.rs`) lê.
//!
//! Duas entradas, as duas PASSIVAS:
//!   * a página manda o que o WhatsApp Web já desenhou na tela (módulo
//!     `localArchive`); o ZapLite nunca rola, abre ou carrega conversa sozinho;
//!   * o usuário importa o `.txt`/`.zip` do "Exportar conversa" do celular.
//!
//! Formato, de propósito sem banco de dados: `arquivo/indice.json` (uma
//! entrada por conversa) e `arquivo/<chave>.jsonl` (uma mensagem por linha,
//! só acrescentada). O ZapLite é o ÚNICO escritor; o MCP só lê. Uma linha
//! cortada por queda de energia é descartada na leitura, nunca derruba o resto.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const PASTA: &str = "arquivo";
const INDICE: &str = "indice.json";

// Tetos do que a PÁGINA pode mandar numa chamada. `arquivo_registrar` é
// alcançável pela origem remota: um script hostil não pode encher o disco nem
// gravar um texto de 10 MB numa mensagem.
pub const MAX_MSGS_POR_CHAMADA: usize = 300;
const MAX_TEXTO: usize = 16 * 1024;
const MAX_CAMPO: usize = 200;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Msg {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub id: String,
    /// `dd/mm/aaaa`
    pub data: String,
    /// `HH:MM`
    pub hora: String,
    #[serde(default)]
    pub autor: String,
    #[serde(rename = "deMim", default, skip_serializing_if = "Option::is_none")]
    pub de_mim: Option<bool>,
    pub texto: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub tipo: String,
    /// `tela` (capturada) ou `importado`
    pub fonte: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Conversa {
    /// Jid do WhatsApp (`...@c.us`, `...@g.us`); vazio para conversa só
    /// importada, até a primeira captura com o mesmo nome adotá-la.
    #[serde(default)]
    pub id: String,
    pub nome: String,
    #[serde(default)]
    pub grupo: bool,
    #[serde(default)]
    pub mensagens: u64,
    /// `aaaa-mm-dd HH:MM` da mensagem mais recente.
    #[serde(default)]
    pub ultima: String,
}

pub type Indice = BTreeMap<String, Conversa>;

/* --------------------------------------------------------------------------
   Normalização — PURA e testada. Os dois formatos precisam cair na mesma
   forma para a importação reconhecer o que já foi capturado.
   -------------------------------------------------------------------------- */

/// `15/8/26` → `15/08/2026`. `dia_primeiro = false` para arquivo em m/d.
pub fn normalizar_data(bruta: &str, dia_primeiro: bool) -> Option<String> {
    let p: Vec<&str> = bruta.trim().split(['/', '.', '-']).collect();
    if p.len() != 3 {
        return None;
    }
    let n: Vec<u32> = p.iter().map(|x| x.trim().parse().ok()).collect::<Option<_>>()?;
    let (d, m) = if dia_primeiro { (n[0], n[1]) } else { (n[1], n[0]) };
    let a = if n[2] < 100 { 2000 + n[2] } else { n[2] };
    if !(1..=31).contains(&d) || !(1..=12).contains(&m) || !(1990..=2100).contains(&a) {
        return None;
    }
    Some(format!("{d:02}/{m:02}/{a:04}"))
}

/// `9:05`, `09:05:33`, `1:38 PM`, `1:38 p.m.` → `HH:MM` (24 h).
pub fn normalizar_hora(bruta: &str) -> Option<String> {
    let s = bruta.trim().replace('\u{202f}', " ").replace('\u{a0}', " ");
    let baixo = s.to_ascii_lowercase().replace('.', "");
    let (corpo, pm, am) = if let Some(c) = baixo.strip_suffix("pm") {
        (c.trim().to_string(), true, false)
    } else if let Some(c) = baixo.strip_suffix("am") {
        (c.trim().to_string(), false, true)
    } else {
        (baixo.trim().to_string(), false, false)
    };
    let p: Vec<&str> = corpo.split(':').collect();
    if p.len() < 2 || p.len() > 3 {
        return None;
    }
    let mut h: u32 = p[0].trim().parse().ok()?;
    let m: u32 = p[1].trim().parse().ok()?;
    if pm && h < 12 {
        h += 12;
    }
    if am && h == 12 {
        h = 0;
    }
    if h > 23 || m > 59 {
        return None;
    }
    Some(format!("{h:02}:{m:02}"))
}

/// `dd/mm/aaaa` + `HH:MM` → `aaaa-mm-dd HH:MM`, ordenável como texto.
pub fn quando(data: &str, hora: &str) -> String {
    let p: Vec<&str> = data.split('/').collect();
    if p.len() != 3 {
        return String::new();
    }
    format!("{}-{}-{} {}", p[2], p[1], p[0], hora)
}

fn cortar(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut fim = max;
    while !s.is_char_boundary(fim) {
        fim -= 1;
    }
    s[..fim].to_string()
}

fn chave_de_conteudo(m: &Msg) -> String {
    let texto: String = m.texto.split_whitespace().collect::<Vec<_>>().join(" ");
    format!("{}|{}|{}", m.data, m.hora, texto)
}

pub fn chave_da_conversa(id: &str, nome: &str) -> String {
    let base = if id.is_empty() { format!("n:{}", nome.trim().to_lowercase()) } else { format!("j:{id}") };
    crate::jobs::fingerprint(&[base.as_bytes()])[..16].to_string()
}

/* --------------------------------------------------------------------------
   Leitura — usada pelo MCP e pelo próprio escritor.
   -------------------------------------------------------------------------- */

pub fn ler_indice(dir: &Path) -> Indice {
    fs::read(dir.join(INDICE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Mensagens de uma conversa, na ordem em que foram gravadas. Linha que não
/// é JSON válido (gravação interrompida) é pulada.
pub fn ler_mensagens(dir: &Path, chave: &str) -> Vec<Msg> {
    let Ok(f) = fs::File::open(dir.join(format!("{chave}.jsonl"))) else {
        return Vec::new();
    };
    std::io::BufReader::new(f)
        .lines()
        .map_while(Result::ok)
        .filter_map(|l| serde_json::from_str::<Msg>(&l).ok())
        .collect()
}

/* --------------------------------------------------------------------------
   Escrita — só o processo do ZapLite, sob uma trava.
   -------------------------------------------------------------------------- */

#[derive(Default)]
struct Vistos {
    ids: HashSet<String>,
    /// Multiconjunto: duas mensagens "ok" no mesmo minuto são duas.
    conteudo: HashMap<String, u32>,
}

impl Vistos {
    fn carregar(dir: &Path, chave: &str) -> Self {
        let mut v = Vistos::default();
        for m in ler_mensagens(dir, chave) {
            if !m.id.is_empty() {
                v.ids.insert(m.id.clone());
            }
            *v.conteudo.entry(chave_de_conteudo(&m)).or_default() += 1;
        }
        v
    }
}

struct Estado {
    dir: PathBuf,
    indice: Indice,
    vistos: HashMap<String, Vistos>,
}

static ESTADO: Mutex<Option<Estado>> = Mutex::new(None);

fn com_estado<T>(dir: &Path, f: impl FnOnce(&mut Estado) -> Result<T, String>) -> Result<T, String> {
    let mut g = ESTADO.lock().unwrap_or_else(|e| e.into_inner());
    if g.as_ref().map(|e| e.dir != dir).unwrap_or(true) {
        *g = Some(Estado { dir: dir.to_path_buf(), indice: ler_indice(dir), vistos: HashMap::new() });
    }
    f(g.as_mut().expect("estado"))
}

fn gravar_indice(e: &Estado) -> Result<(), String> {
    crate::settings_store::atomic_write(&e.dir.join(INDICE), &serde_json::to_value(&e.indice).map_err(|x| x.to_string())?)
}

/// A conversa onde gravar. Jid conhecido vence; senão, uma conversa só
/// importada com o MESMO nome é adotada (ganha o jid e continua no mesmo
/// arquivo), para o histórico do celular e a captura virarem uma conversa só.
fn resolver_chave(e: &mut Estado, id: &str, nome: &str, grupo: bool) -> String {
    if !id.is_empty() {
        if let Some((k, _)) = e.indice.iter().find(|(_, c)| c.id == id) {
            return k.clone();
        }
        let nome_l = nome.trim().to_lowercase();
        if !nome_l.is_empty() {
            if let Some((k, c)) = e.indice.iter_mut().find(|(_, c)| c.id.is_empty() && c.nome.trim().to_lowercase() == nome_l) {
                c.id = id.to_string();
                c.grupo = grupo;
                return k.clone();
            }
        }
    } else if let Some((k, _)) = e.indice.iter().find(|(_, c)| c.nome.trim().to_lowercase() == nome.trim().to_lowercase()) {
        return k.clone();
    }
    let k = chave_da_conversa(id, nome);
    e.indice.entry(k.clone()).or_insert_with(|| Conversa { id: id.to_string(), nome: nome.to_string(), grupo, ..Default::default() });
    k
}

/// Acrescenta as mensagens novas. Com `id`, duplicata é pelo id. Sem `id`
/// (importação), duplicata é pelo conteúdo contra o que JÁ estava gravado
/// antes desta chamada — repetições legítimas dentro do mesmo arquivo passam.
fn acrescentar(e: &mut Estado, chave: &str, msgs: Vec<Msg>) -> Result<usize, String> {
    let dir = e.dir.clone();
    let vistos = e.vistos.entry(chave.to_string()).or_insert_with(|| Vistos::carregar(&dir, chave));
    let mut disponivel = vistos.conteudo.clone();
    let mut novas: Vec<Msg> = Vec::new();
    for m in msgs {
        let ck = chave_de_conteudo(&m);
        if !m.id.is_empty() {
            if vistos.ids.contains(&m.id) {
                continue;
            }
        } else if let Some(n) = disponivel.get_mut(&ck).filter(|n| **n > 0) {
            *n -= 1;
            continue;
        }
        if !m.id.is_empty() {
            vistos.ids.insert(m.id.clone());
        }
        *vistos.conteudo.entry(ck).or_default() += 1;
        novas.push(m);
    }
    if novas.is_empty() {
        return Ok(0);
    }
    fs::create_dir_all(&dir).map_err(|x| x.to_string())?;
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(format!("{chave}.jsonl")))
        .map_err(|x| x.to_string())?;
    let mut buf = String::new();
    for m in &novas {
        buf.push_str(&serde_json::to_string(m).map_err(|x| x.to_string())?);
        buf.push('\n');
    }
    f.write_all(buf.as_bytes()).map_err(|x| x.to_string())?;
    let c = e.indice.get_mut(chave).expect("conversa resolvida");
    c.mensagens += novas.len() as u64;
    for m in &novas {
        let q = quando(&m.data, &m.hora);
        if q > c.ultima {
            c.ultima = q;
        }
    }
    Ok(novas.len())
}

#[derive(Deserialize)]
pub struct ConversaDaPagina {
    pub id: String,
    pub nome: String,
    #[serde(default)]
    pub grupo: bool,
}

#[derive(Deserialize)]
pub struct MsgDaPagina {
    pub id: String,
    /// `data-pre-plain-text` já analisado pela página: data e hora como o
    /// WhatsApp escreveu.
    #[serde(default)]
    pub data: String,
    #[serde(default)]
    pub hora: String,
    #[serde(default)]
    pub autor: String,
    #[serde(rename = "deMim", default)]
    pub de_mim: bool,
    #[serde(default)]
    pub texto: String,
    #[serde(default)]
    pub tipo: String,
}

/// O que a página viu na tela. Mensagem sem data/hora reconhecível é
/// descartada: sem elas não há como ordenar nem casar com a importação.
pub fn registrar_da_pagina(dir: &Path, conversa: ConversaDaPagina, msgs: Vec<MsgDaPagina>) -> Result<usize, String> {
    if msgs.len() > MAX_MSGS_POR_CHAMADA {
        return Err(format!("no máximo {MAX_MSGS_POR_CHAMADA} mensagens por chamada."));
    }
    let id = cortar(conversa.id.trim(), MAX_CAMPO);
    let nome = cortar(conversa.nome.trim(), MAX_CAMPO);
    if id.is_empty() {
        return Err("conversa sem identificador.".into());
    }
    let msgs: Vec<Msg> = msgs
        .into_iter()
        .filter_map(|m| {
            let data = normalizar_data(&m.data, true)?;
            let hora = normalizar_hora(&m.hora)?;
            let texto = cortar(&m.texto, MAX_TEXTO);
            if texto.trim().is_empty() && m.tipo.is_empty() {
                return None;
            }
            Some(Msg {
                id: cortar(m.id.trim(), MAX_CAMPO),
                data,
                hora,
                autor: cortar(m.autor.trim(), MAX_CAMPO),
                de_mim: Some(m.de_mim),
                texto,
                tipo: cortar(&m.tipo, 32),
                fonte: "tela".into(),
            })
        })
        .collect();
    com_estado(dir, |e| {
        // Nome vazio = a página não tinha certeza de qual conversa é a do
        // cabeçalho (troca de conversa em andamento): mantém o que já havia.
        let chave = resolver_chave(e, &id, if nome.is_empty() { &id } else { &nome }, conversa.grupo);
        if let Some(c) = e.indice.get_mut(&chave) {
            if !nome.is_empty() {
                c.nome = nome.clone();
            }
        }
        let n = acrescentar(e, &chave, msgs)?;
        gravar_indice(e)?;
        Ok(n)
    })
}

/* --------------------------------------------------------------------------
   Importação do "Exportar conversa" do celular — PURA e testada.
   Android: `15/08/2026 13:38 - Fulano: texto`
   iPhone:  `[15/08/2026, 13:38:05] Fulano: texto`
   Linha sem cabeçalho continua a mensagem anterior.
   -------------------------------------------------------------------------- */

struct Cabecalho<'a> {
    data: &'a str,
    hora: &'a str,
    resto: &'a str,
}

fn cabecalho(linha: &str) -> Option<Cabecalho<'_>> {
    let s = linha.trim_start_matches(['\u{200e}', '\u{feff}', ' ']);
    let (cabeca, resto) = if let Some(s) = s.strip_prefix('[') {
        let fim = s.find(']')?;
        (&s[..fim], s[fim + 1..].trim_start())
    } else {
        let fim = s.find(" - ")?;
        (&s[..fim], &s[fim + 3..])
    };
    let corte = cabeca.find([',', ' '])?;
    let data = &cabeca[..corte];
    let hora = cabeca[corte + 1..].trim_start_matches([',', ' ']);
    if data.matches('/').count() != 2 || !hora.contains(':') {
        return None;
    }
    Some(Cabecalho { data, hora, resto })
}

/// Arquivo em m/d (celular em inglês dos EUA)? Decide pelo arquivo inteiro:
/// basta uma data com o segundo número acima de 12.
fn arquivo_mes_primeiro(texto: &str) -> bool {
    let mut mes_primeiro = false;
    for l in texto.lines() {
        if let Some(c) = cabecalho(l) {
            let p: Vec<u32> = c.data.split('/').filter_map(|x| x.trim().parse().ok()).collect();
            if p.len() == 3 {
                if p[0] > 12 {
                    return false;
                }
                if p[1] > 12 {
                    mes_primeiro = true;
                }
            }
        }
    }
    mes_primeiro
}

pub fn analisar_exportacao(texto: &str) -> Vec<Msg> {
    let dia_primeiro = !arquivo_mes_primeiro(texto);
    let mut out: Vec<Msg> = Vec::new();
    let mut atual: Option<Msg> = None;
    for linha in texto.lines() {
        let c = cabecalho(linha).and_then(|c| {
            Some((normalizar_data(c.data, dia_primeiro)?, normalizar_hora(c.hora)?, c.resto))
        });
        match c {
            Some((data, hora, resto)) => {
                if let Some(m) = atual.take() {
                    out.push(m);
                }
                // Sem "Autor: " é aviso do sistema (criptografia, entrou no
                // grupo): não é mensagem de ninguém.
                let Some((autor, corpo)) = resto.split_once(": ") else {
                    continue;
                };
                let corpo = corpo.trim_start_matches('\u{200e}');
                let midia = matches!(corpo.trim(), "<Mídia oculta>" | "<Media omitted>" | "<Arquivo de mídia oculto>")
                    || corpo.contains("(arquivo anexado)")
                    || corpo.contains("(file attached)")
                    || corpo.starts_with("<anexado:")
                    || corpo.starts_with("<attached:");
                atual = Some(Msg {
                    id: String::new(),
                    data,
                    hora,
                    autor: autor.trim().to_string(),
                    de_mim: None,
                    texto: cortar(corpo, MAX_TEXTO),
                    tipo: if midia { "mídia".into() } else { String::new() },
                    fonte: "importado".into(),
                });
            }
            None => {
                if let Some(m) = atual.as_mut() {
                    if m.texto.len() < MAX_TEXTO {
                        m.texto.push('\n');
                        m.texto.push_str(linha);
                        m.texto = cortar(&m.texto, MAX_TEXTO);
                    }
                }
            }
        }
    }
    if let Some(m) = atual {
        out.push(m);
    }
    out
}

/// "Conversa do WhatsApp com Fulano.txt" → "Fulano".
pub fn nome_pelo_arquivo(nome_arquivo: &str) -> String {
    let base = Path::new(nome_arquivo)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    for prefixo in ["Conversa do WhatsApp com ", "WhatsApp Chat with ", "WhatsApp Chat - ", "Chat de WhatsApp con "] {
        if let Some(r) = base.strip_prefix(prefixo) {
            return r.trim().to_string();
        }
    }
    base.trim().to_string()
}

/// O texto de um `.txt` ou do `.txt` de dentro de um `.zip` (o iPhone exporta
/// `_chat.txt` dentro de um zip).
pub fn ler_arquivo_exportado(p: &Path) -> Result<String, String> {
    let bytes = fs::read(p).map_err(|e| e.to_string())?;
    let eh_zip = bytes.starts_with(b"PK\x03\x04");
    if !eh_zip {
        return Ok(String::from_utf8_lossy(&bytes).into_owned());
    }
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| e.to_string())?;
    let mut alvo = None;
    for i in 0..z.len() {
        let nome = z.by_index(i).map_err(|e| e.to_string())?.name().to_string();
        if nome.to_ascii_lowercase().ends_with(".txt") {
            let preferido = nome.ends_with("_chat.txt") || nome.contains("Conversa do WhatsApp");
            if alvo.is_none() || preferido {
                alvo = Some(i);
            }
        }
    }
    let i = alvo.ok_or("o .zip não tem nenhum .txt de conversa dentro.")?;
    let mut f = z.by_index(i).map_err(|e| e.to_string())?;
    let mut s = Vec::new();
    std::io::Read::read_to_end(&mut f, &mut s).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&s).into_owned())
}

pub fn importar(dir: &Path, nome: &str, texto: &str) -> Result<Value, String> {
    let msgs = analisar_exportacao(texto);
    if msgs.is_empty() {
        return Err("não reconheci nenhuma mensagem neste arquivo. Ele veio do \"Exportar conversa\" do WhatsApp?".into());
    }
    let lidas = msgs.len();
    let nome = cortar(nome.trim(), MAX_CAMPO);
    com_estado(dir, |e| {
        let chave = resolver_chave(e, "", &nome, false);
        let novas = acrescentar(e, &chave, msgs)?;
        gravar_indice(e)?;
        Ok(json!({ "conversa": nome, "lidas": lidas, "novas": novas }))
    })
}

pub fn status(dir: &Path) -> Value {
    let indice = ler_indice(dir);
    let bytes: u64 = fs::read_dir(dir)
        .map(|it| it.filter_map(|e| e.ok()?.metadata().ok()).map(|m| m.len()).sum())
        .unwrap_or(0);
    json!({
        "conversas": indice.len(),
        "mensagens": indice.values().map(|c| c.mensagens).sum::<u64>(),
        "bytes": bytes,
        "pasta": dir.to_string_lossy(),
    })
}

/// Apaga o arquivo local inteiro. O estado em memória vai junto, senão a
/// próxima captura "lembraria" ids de mensagens que já não existem no disco.
pub fn apagar(dir: &Path) -> Result<(), String> {
    let mut g = ESTADO.lock().unwrap_or_else(|e| e.into_inner());
    *g = None;
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod testes {
    use super::*;

    fn dir_temp() -> PathBuf {
        std::env::temp_dir().join(format!("zaplite-arquivo-{:x}", rand::random::<u64>()))
    }

    #[test]
    fn datas_e_horas_dos_dois_formatos_viram_uma_so() {
        assert_eq!(normalizar_data("15/8/26", true).as_deref(), Some("15/08/2026"));
        assert_eq!(normalizar_data("8/15/26", false).as_deref(), Some("15/08/2026"));
        assert_eq!(normalizar_data("32/01/2026", true), None);
        assert_eq!(normalizar_hora("9:05").as_deref(), Some("09:05"));
        assert_eq!(normalizar_hora("13:38:05").as_deref(), Some("13:38"));
        assert_eq!(normalizar_hora("1:38 PM").as_deref(), Some("13:38"));
        assert_eq!(normalizar_hora("12:10\u{202f}a.m.").as_deref(), Some("00:10"));
        assert_eq!(quando("15/08/2026", "13:38"), "2026-08-15 13:38");
    }

    #[test]
    fn exportacao_android_e_iphone() {
        let android = "15/08/2026 13:38 - As mensagens e as ligações são protegidas com a criptografia de ponta a ponta.\n\
                       15/08/2026 13:38 - Fulano: bom dia\n\
                       15/08/2026 13:40 - Beltrano: primeira linha\nsegunda linha\n\
                       15/08/2026 13:41 - Fulano: <Mídia oculta>\n";
        let m = analisar_exportacao(android);
        assert_eq!(m.len(), 3);
        assert_eq!((m[0].autor.as_str(), m[0].texto.as_str(), m[0].hora.as_str()), ("Fulano", "bom dia", "13:38"));
        assert_eq!(m[1].texto, "primeira linha\nsegunda linha");
        assert_eq!(m[2].tipo, "mídia");

        let iphone = "\u{200e}[15/08/2026, 13:38:05] Fulano: bom dia\n[15/08/2026, 13:39:00] Você: oi";
        let m = analisar_exportacao(iphone);
        assert_eq!(m.len(), 2);
        assert_eq!((m[0].data.as_str(), m[0].hora.as_str()), ("15/08/2026", "13:38"));

        // celular em inglês dos EUA: m/d, decidido pelo arquivo
        let us = "8/15/26, 1:38 PM - Fulano: hi\n8/1/26, 9:00 AM - Fulano: yo";
        let m = analisar_exportacao(us);
        assert_eq!((m[0].data.as_str(), m[0].hora.as_str()), ("15/08/2026", "13:38"));
        assert_eq!(m[1].data, "01/08/2026");
    }

    #[test]
    fn nome_da_conversa_sai_do_nome_do_arquivo() {
        assert_eq!(nome_pelo_arquivo("Conversa do WhatsApp com Equipe Vendas.txt"), "Equipe Vendas");
        assert_eq!(nome_pelo_arquivo("WhatsApp Chat with Ana.zip"), "Ana");
    }

    #[test]
    fn captura_e_importacao_viram_uma_conversa_sem_duplicar() {
        let dir = dir_temp();
        // 1) histórico do celular, só com nome
        let txt = "15/08/2026 13:38 - Fulano: ok\n15/08/2026 13:38 - Fulano: ok\n15/08/2026 13:40 - Fulano: fechado";
        assert_eq!(importar(&dir, "Fulano", txt).unwrap()["novas"], 3);
        // importar DE NOVO não duplica nada — nem os dois "ok" do mesmo minuto
        assert_eq!(importar(&dir, "Fulano", txt).unwrap()["novas"], 0);
        // 2) captura da tela: adota a conversa importada pelo nome
        let pag = |id: &str, hora: &str, texto: &str| MsgDaPagina {
            id: id.into(), data: "15/08/2026".into(), hora: hora.into(), autor: "Fulano".into(),
            de_mim: false, texto: texto.into(), tipo: String::new(),
        };
        let conv = || ConversaDaPagina { id: "5511999998888@c.us".into(), nome: "Fulano".into(), grupo: false };
        let n = registrar_da_pagina(&dir, conv(), vec![pag("A", "13:41", "novo"), pag("B", "13:42", "outro")]).unwrap();
        assert_eq!(n, 2);
        // a mesma tela de novo (o observador roda várias vezes): nada novo
        assert_eq!(registrar_da_pagina(&dir, conv(), vec![pag("A", "13:41", "novo")]).unwrap(), 0);
        let indice = ler_indice(&dir);
        assert_eq!(indice.len(), 1, "importada e capturada são a mesma conversa");
        let c = indice.values().next().unwrap();
        assert_eq!((c.id.as_str(), c.mensagens, c.ultima.as_str()), ("5511999998888@c.us", 5, "2026-08-15 13:42"));
        // estado em memória apagado junto com o disco
        apagar(&dir).unwrap();
        assert!(!dir.exists());
        assert_eq!(registrar_da_pagina(&dir, conv(), vec![pag("A", "13:41", "novo")]).unwrap(), 1);
        apagar(&dir).unwrap();
    }

    #[test]
    fn pagina_nao_passa_dos_tetos() {
        let dir = dir_temp();
        let conv = ConversaDaPagina { id: "x@c.us".into(), nome: "X".into(), grupo: false };
        let muitas = (0..MAX_MSGS_POR_CHAMADA + 1)
            .map(|i| MsgDaPagina { id: i.to_string(), data: "15/08/2026".into(), hora: "10:00".into(),
                autor: String::new(), de_mim: false, texto: "a".into(), tipo: String::new() })
            .collect();
        assert!(registrar_da_pagina(&dir, conv, muitas).is_err());
        let _ = apagar(&dir);
    }
}
