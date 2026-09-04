//! Instalação do Whisper pelo próprio ZapLite.
//!
//! Por que aqui e não no instalador NSIS: o instalador tem ~2 MB e os modelos
//! vão de 75 MB a 3 GB. Embutir é inviável, baixar durante o NSIS é frágil (sem
//! retomada, sem barra, sem cancelar) e, dentro do app, o usuário troca de
//! modelo depois sem reinstalar nada.
//!
//! Regra de ouro deste módulo: **nada substitui a configuração de quem já tem
//! Whisper próprio**. Se `whisperCli`/`whisperModel` apontam para caminhos que
//! existem em disco, eles ficam como estão; o motor embutido é alternativa.

use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

/// Release do whisper.cpp cujos binários de Windows são baixados. Fixo de
/// propósito: um "latest" que mude de layout quebra a extração sem aviso.
pub(crate) const TAG: &str = "b4938";

const BASE_RELEASE: &str = "https://github.com/ggml-org/whisper.cpp/releases/download";
const BASE_MODELO: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

/// Assinatura de um modelo GGML. Os 4 primeiros bytes de qualquer `ggml-*.bin`
/// do whisper.cpp são `6c 6d 67 67` — o `0x67676d6c` ("ggml") gravado em
/// little-endian, portanto `lmgg` na ordem em que os bytes aparecem no arquivo.
/// Conferido no `ggml-large-v3-turbo.bin` que o usuário já usa.
const MAGIA_GGML: &[u8; 4] = b"lmgg";
/// Cabeçalho de arquivo local de um ZIP.
const MAGIA_ZIP: &[u8; 4] = b"PK\x03\x04";

// ---------------------------------------------------------------------------
// Catálogos
// ---------------------------------------------------------------------------

pub(crate) struct Motor {
    pub id: &'static str,
    pub rotulo: &'static str,
    pub arquivo: &'static str,
    /// Tamanho publicado no release; serve de tolerância e de rótulo na tela.
    pub bytes: u64,
    pub nota: &'static str,
    /// Só é oferecido quando há GPU NVIDIA.
    pub exige_nvidia: bool,
}

pub(crate) const MOTORES: &[Motor] = &[
    Motor {
        id: "cpu",
        rotulo: "CPU",
        arquivo: "whisper-bin-x64.zip",
        bytes: 8_361_840,
        nota: "Funciona em qualquer processador x64: o pacote traz uma DLL por geração \
               (sse42, haswell, skylakex, alderlake…) e escolhe a certa ao rodar.",
        exige_nvidia: false,
    },
    Motor {
        id: "blas",
        rotulo: "BLAS",
        arquivo: "whisper-blas-bin-x64.zip",
        bytes: 21_180_000,
        nota: "Mesma compatibilidade do CPU, com álgebra linear otimizada. \
               Costuma transcrever mais rápido sem GPU.",
        exige_nvidia: false,
    },
    Motor {
        id: "cuda",
        rotulo: "CUDA 12.4 (NVIDIA)",
        arquivo: "whisper-cublas-12.4.0-bin-x64.zip",
        bytes: 671_100_000,
        nota: "Roda na GPU e é de longe o mais rápido — mas o pacote tem 640 MB \
               porque carrega as bibliotecas da CUDA.",
        exige_nvidia: true,
    },
];

pub(crate) struct Modelo {
    pub id: &'static str,
    /// Tamanho exato publicado pelo Hugging Face (`content-length`).
    pub bytes: u64,
    pub nota: &'static str,
    pub recomendado: bool,
}

pub(crate) const MODELOS: &[Modelo] = &[
    Modelo {
        id: "tiny",
        bytes: 77_691_713,
        nota: "O mais leve e o mais rápido. Erra bastante em português — serve para \
               testar a instalação, não para o dia a dia.",
        recomendado: false,
    },
    Modelo {
        id: "base",
        bytes: 147_951_465,
        nota: "Leve. Dá conta de áudio limpo e pausado; tropeça em gíria, ruído e \
               nomes próprios.",
        recomendado: false,
    },
    Modelo {
        id: "small",
        bytes: 487_601_967,
        nota: "O menor que já se usa de verdade em português. Bom equilíbrio para \
               máquinas modestas.",
        recomendado: false,
    },
    Modelo {
        id: "medium",
        bytes: 1_533_763_059,
        nota: "Preciso, porém lento sem GPU. O large-v3-turbo entrega quase o mesmo \
               bem mais rápido.",
        recomendado: false,
    },
    Modelo {
        id: "large-v3-turbo",
        bytes: 1_624_555_275,
        nota: "Qualidade de large com velocidade perto do small. É a melhor escolha \
               para áudio de WhatsApp em português.",
        recomendado: true,
    },
    Modelo {
        id: "large-v3",
        bytes: 3_095_033_483,
        nota: "A melhor qualidade absoluta e a mais lenta. Só compensa em áudio \
               difícil, com GPU.",
        recomendado: false,
    },
];

fn motor(id: &str) -> Option<&'static Motor> {
    MOTORES.iter().find(|m| m.id == id)
}
fn modelo(id: &str) -> Option<&'static Modelo> {
    MODELOS.iter().find(|m| m.id == id)
}

// ---------------------------------------------------------------------------
// Pastas
// ---------------------------------------------------------------------------

/// `%LOCALAPPDATA%\br.com.zaplite.app\whisper`. Fica em LOCAL (e não Roaming)
/// porque são gigabytes de binário que não fazem sentido sincronizar em perfil
/// móvel.
pub(crate) fn pasta_whisper(app: &AppHandle) -> PathBuf {
    let base = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("br.com.zaplite.app"));
    base.join("whisper")
}
pub(crate) fn pasta_motor(app: &AppHandle) -> PathBuf {
    pasta_whisper(app).join("engine")
}
pub(crate) fn pasta_modelos(app: &AppHandle) -> PathBuf {
    pasta_whisper(app).join("models")
}

/// Caminho do `whisper-cli.exe` embutido, se o motor já tiver sido instalado.
/// O pacote do whisper.cpp traz `whisper-cli.exe` **e** `main.exe` (o nome
/// antigo); os dois são aceitos, nesta ordem.
pub(crate) fn cli_embutido(app: &AppHandle) -> Option<PathBuf> {
    let dir = pasta_motor(app);
    for nome in ["whisper-cli.exe", "main.exe"] {
        let p = dir.join(nome);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn caminho_modelo(app: &AppHandle, id: &str) -> PathBuf {
    pasta_modelos(app).join(format!("ggml-{id}.bin"))
}

// ---------------------------------------------------------------------------
// Progresso (o Painel faz polling; nada de evento perdido no meio do caminho)
// ---------------------------------------------------------------------------

#[derive(Default, Clone)]
struct Progresso {
    ativo: bool,
    tarefa: String,
    alvo: String,
    baixado: u64,
    total: u64,
    fase: String,
    erro: Option<String>,
    feito: Option<String>,
}

fn prog() -> &'static Mutex<Progresso> {
    static P: OnceLock<Mutex<Progresso>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(Progresso::default()))
}
static CANCELAR: AtomicBool = AtomicBool::new(false);
/// Serializa as instalações: duas ao mesmo tempo brigariam pelo mesmo
/// progresso e pela mesma pasta.
static OCUPADO: AtomicBool = AtomicBool::new(false);
/// Só para o teste: conta quantas vezes o progresso foi zerado.
static GERACAO: AtomicU64 = AtomicU64::new(0);

fn iniciar(tarefa: &str, alvo: &str, total: u64) {
    CANCELAR.store(false, Ordering::SeqCst);
    GERACAO.fetch_add(1, Ordering::SeqCst);
    let mut p = prog().lock().unwrap();
    *p = Progresso {
        ativo: true,
        tarefa: tarefa.into(),
        alvo: alvo.into(),
        baixado: 0,
        total,
        fase: "conectando".into(),
        erro: None,
        feito: None,
    };
}
fn fase(f: &str) {
    prog().lock().unwrap().fase = f.into();
}
fn andar(baixado: u64, total: u64) {
    let mut p = prog().lock().unwrap();
    p.baixado = baixado;
    p.total = total;
    p.fase = "baixando".into();
}
fn terminar(r: &Result<String, String>) {
    let mut p = prog().lock().unwrap();
    p.ativo = false;
    p.fase = "pronto".into();
    match r {
        Ok(s) => {
            p.feito = Some(s.clone());
            p.erro = None;
        }
        Err(e) => {
            p.erro = Some(e.clone());
            p.feito = None;
        }
    }
}

// ---------------------------------------------------------------------------
// Download robusto
// ---------------------------------------------------------------------------

/// Erro que o usuário consegue entender. `reqwest` costuma devolver uma cadeia
/// de causas em inglês; aqui ela vira uma frase.
fn erro_rede(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "a conexão expirou (o servidor não respondeu a tempo)".into()
    } else if e.is_connect() {
        "não consegui conectar ao servidor — verifique a internet, proxy ou firewall".into()
    } else {
        format!("falha de rede: {e}")
    }
}

fn erro_io(e: &std::io::Error, destino: &Path) -> String {
    // ERROR_DISK_FULL / ERROR_HANDLE_DISK_FULL no Windows.
    let codigo = e.raw_os_error().unwrap_or(0);
    if codigo == 112 || codigo == 39 {
        format!(
            "disco cheio ao gravar em {}. Libere espaço e tente de novo — o que já baixou é aproveitado.",
            destino.display()
        )
    } else {
        format!("erro ao gravar {}: {e}", destino.display())
    }
}

/// Baixa `url` para `destino`, com retomada, cancelamento e verificação.
///
/// Contrato (é aqui que essas funcionalidades costumam falhar na vida real):
/// 1. o download vai para `<destino>.part`; `destino` só passa a existir depois
///    de tudo verificado — nunca há um `.bin` truncado com cara de válido;
/// 2. se um `.part` sobrou de uma tentativa anterior, tenta `Range:` e retoma;
/// 3. o tamanho anunciado pelo servidor precisa bater com o esperado dentro da
///    tolerância — página de erro HTML ou redirecionamento para login não passa;
/// 4. no fim, o total gravado tem que bater exatamente e os 4 primeiros bytes
///    têm que ser a assinatura do formato;
/// 5. cancelou: o `.part` é apagado (o usuário pediu para não ficar lixo).
///    Caiu a rede: o `.part` fica, para retomar. Verificação falhou: apaga, que
///    o conteúdo é inservível.
async fn baixar(
    url: &str,
    destino: &Path,
    esperado: u64,
    magia: &[u8; 4],
    rotulo_formato: &str,
) -> Result<(), String> {
    if let Some(pai) = destino.parent() {
        std::fs::create_dir_all(pai).map_err(|e| erro_io(&e, pai))?;
    }
    let parte = destino.with_file_name(format!(
        "{}.part",
        destino.file_name().unwrap_or_default().to_string_lossy()
    ));

    let ja = std::fs::metadata(&parte).map(|m| m.len()).unwrap_or(0);
    // Um `.part` maior que o esperado é lixo de outra versão: recomeça.
    let ja = if ja >= esperado.saturating_mul(2) { 0 } else { ja };

    let cliente = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .user_agent("ZapLite")
        .build()
        .map_err(|e| erro_rede(&e))?;

    let mut req = cliente.get(url);
    if ja > 0 {
        req = req.header("Range", format!("bytes={ja}-"));
    }
    let resp = req.send().await.map_err(|e| erro_rede(&e))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!(
            "o servidor recusou o download ({}). URL: {url}",
            status.as_u16()
        ));
    }
    let retomando = status.as_u16() == 206 && ja > 0;
    let restante = resp.content_length().unwrap_or(0);
    let total = if retomando { ja + restante } else { restante };

    // Tolerância de 25%: o release pode ser recompilado e mudar alguns KB, mas
    // uma página de erro (alguns KB) ou um arquivo de outra coisa não passa.
    let piso = esperado / 4 * 3;
    let teto = esperado / 4 * 5;
    if total == 0 || total < piso || total > teto {
        return Err(format!(
            "o servidor devolveu {} em vez dos ~{} esperados — download recusado \
             (pode ser página de erro, proxy corporativo ou o arquivo mudou de lugar).",
            humano(total),
            humano(esperado)
        ));
    }

    let mut arq = if retomando {
        use std::fs::OpenOptions;
        OpenOptions::new()
            .append(true)
            .open(&parte)
            .map_err(|e| erro_io(&e, &parte))?
    } else {
        std::fs::File::create(&parte).map_err(|e| erro_io(&e, &parte))?
    };

    let mut escrito = if retomando { ja } else { 0 };
    andar(escrito, total);

    let mut resp = resp;
    loop {
        if CANCELAR.load(Ordering::SeqCst) {
            drop(arq);
            let _ = std::fs::remove_file(&parte);
            return Err("cancelado".into());
        }
        let bloco = match resp.chunk().await {
            Ok(Some(b)) => b,
            Ok(None) => break,
            Err(e) => {
                // Rede caiu no meio: o `.part` FICA, para retomar depois.
                return Err(format!(
                    "{} — o que já baixou ({}) foi guardado e a próxima tentativa retoma daí.",
                    erro_rede(&e),
                    humano(escrito)
                ));
            }
        };
        use std::io::Write;
        arq.write_all(&bloco).map_err(|e| {
            let msg = erro_io(&e, &parte);
            msg
        })?;
        escrito += bloco.len() as u64;
        andar(escrito, total);
    }
    use std::io::Write;
    arq.flush().map_err(|e| erro_io(&e, &parte))?;
    drop(arq);

    fase("verificando");
    if escrito != total {
        let _ = std::fs::remove_file(&parte);
        return Err(format!(
            "download incompleto: recebi {} de {}. Nada foi instalado.",
            humano(escrito),
            humano(total)
        ));
    }
    if let Err(e) = conferir_magia(&parte, magia) {
        let _ = std::fs::remove_file(&parte);
        return Err(format!("{e} (esperava um {rotulo_formato})"));
    }
    // Rename por último: até esta linha não existe nenhum arquivo com o nome
    // definitivo, então nada meio-baixado é confundido com instalação boa.
    if destino.exists() {
        let _ = std::fs::remove_file(destino);
    }
    std::fs::rename(&parte, destino).map_err(|e| erro_io(&e, destino))?;
    Ok(())
}

fn conferir_magia(p: &Path, magia: &[u8; 4]) -> Result<(), String> {
    let mut f = std::fs::File::open(p).map_err(|e| format!("não consegui reabrir o arquivo: {e}"))?;
    let mut cab = [0u8; 4];
    f.read_exact(&mut cab)
        .map_err(|_| "o arquivo baixado é pequeno demais para ser válido".to_string())?;
    if &cab != magia {
        return Err(format!(
            "o arquivo baixado não tem a assinatura certa (começa com {cab:02x?})"
        ));
    }
    Ok(())
}

pub(crate) fn humano(b: u64) -> String {
    if b >= 1_073_741_824 {
        format!("{:.1} GB", b as f64 / 1_073_741_824.0)
    } else if b >= 1_048_576 {
        format!("{:.0} MB", b as f64 / 1_048_576.0)
    } else if b >= 1024 {
        format!("{:.0} KB", b as f64 / 1024.0)
    } else {
        format!("{b} B")
    }
}

// ---------------------------------------------------------------------------
// Extração do motor
// ---------------------------------------------------------------------------

/// O pacote traz 38 arquivos, quase todos inúteis aqui (testes, SDL2, exemplos
/// de outros modelos). Extrair só o necessário deixa a pasta em ~12 MB em vez
/// de 21 MB e evita colocar executáveis de demonstração na máquina do usuário.
pub(crate) fn interessa(nome_no_zip: &str) -> Option<String> {
    // Zip-slip: só o nome final é usado, então `../..` no caminho não escapa.
    let base = Path::new(nome_no_zip).file_name()?.to_string_lossy().to_string();
    if base.is_empty() || base == ".." || base.contains(':') {
        return None;
    }
    let baixo = base.to_ascii_lowercase();
    let vale = baixo == "whisper-cli.exe" || baixo == "main.exe" || baixo.ends_with(".dll");
    if vale {
        Some(base)
    } else {
        None
    }
}

fn extrair(zip: &Path, destino: &Path) -> Result<usize, String> {
    let arq = std::fs::File::open(zip).map_err(|e| erro_io(&e, zip))?;
    let mut z = zip::ZipArchive::new(arq)
        .map_err(|e| format!("o pacote baixado não abriu como ZIP: {e}"))?;
    std::fs::create_dir_all(destino).map_err(|e| erro_io(&e, destino))?;
    let mut n = 0usize;
    for i in 0..z.len() {
        let mut item = z
            .by_index(i)
            .map_err(|e| format!("erro lendo o pacote: {e}"))?;
        if item.is_dir() {
            continue;
        }
        let nome = item.name().to_string();
        let Some(base) = interessa(&nome) else { continue };
        let saida = destino.join(&base);
        let mut f = std::fs::File::create(&saida).map_err(|e| erro_io(&e, &saida))?;
        std::io::copy(&mut item, &mut f).map_err(|e| erro_io(&e, &saida))?;
        n += 1;
    }
    if n == 0 {
        return Err("o pacote baixado não tinha nenhum executável do whisper dentro.".into());
    }
    Ok(n)
}

// ---------------------------------------------------------------------------
// Detecção de GPU
// ---------------------------------------------------------------------------

/// Sem abrir processo: o driver da NVIDIA instala o `nvidia-smi.exe` em
/// System32. Se ele não está lá, oferecer 640 MB de CUDA seria desperdício.
pub(crate) fn tem_nvidia() -> bool {
    let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    if PathBuf::from(&sysroot).join("System32").join("nvidia-smi.exe").is_file() {
        return true;
    }
    let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into());
    PathBuf::from(pf)
        .join("NVIDIA Corporation")
        .join("NVSMI")
        .join("nvidia-smi.exe")
        .is_file()
}

// ---------------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------------

/// Retrato honesto do estado atual: o que existe, onde, e de onde veio.
/// Quem já tem tudo funcionando vê "pronto" e nenhuma oferta de instalação.
#[tauri::command]
pub(crate) fn whisper_status(app: AppHandle) -> Value {
    let s = crate::read_settings(&app);
    let cli_cfg = s["whisperCli"].as_str().unwrap_or("").trim().to_string();
    let modelo_cfg = s["whisperModel"].as_str().unwrap_or("").trim().to_string();
    let home = std::env::var("USERPROFILE").ok().or_else(|| std::env::var("HOME").ok());

    let embutido = cli_embutido(&app);
    // MESMA ordem do `transcribe_audio`, senão o Painel mentiria: primeiro o
    // que o usuário configurou/tem, e só depois o motor instalado pelo app.
    let (achado, _) = crate::achar_whisper(&cli_cfg, &modelo_cfg, home.as_deref());
    let (cli, origem) = match achado {
        Some(p) => {
            let origem = if !cli_cfg.is_empty() && PathBuf::from(&cli_cfg) == p {
                "configurado por você"
            } else if embutido.as_deref() == Some(p.as_path()) {
                "instalado pelo ZapLite"
            } else {
                "encontrado automaticamente"
            };
            (Some(p), origem)
        }
        None => (embutido.clone(), "instalado pelo ZapLite"),
    };

    let modelo_path = PathBuf::from(&modelo_cfg);
    let modelo_existe = !modelo_cfg.is_empty() && modelo_path.is_file();
    let modelo_bytes = if modelo_existe {
        std::fs::metadata(&modelo_path).map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };

    let dir_modelos = pasta_modelos(&app);
    let modelos: Vec<Value> = MODELOS
        .iter()
        .map(|m| {
            let p = dir_modelos.join(format!("ggml-{}.bin", m.id));
            let baixado = p.is_file();
            json!({
                "id": m.id,
                "bytes": m.bytes,
                "tamanho": humano(m.bytes),
                "nota": m.nota,
                "recomendado": m.recomendado,
                "baixado": baixado,
                "caminho": p.to_string_lossy(),
                "emUso": baixado && modelo_existe && p == modelo_path,
            })
        })
        .collect();

    let nvidia = tem_nvidia();
    let motores: Vec<Value> = MOTORES
        .iter()
        .filter(|m| !m.exige_nvidia || nvidia)
        .map(|m| {
            json!({
                "id": m.id,
                "rotulo": m.rotulo,
                "bytes": m.bytes,
                "tamanho": humano(m.bytes),
                "nota": m.nota,
            })
        })
        .collect();

    json!({
        "cli": cli.as_ref().map(|p| p.to_string_lossy().to_string()),
        "cliOrigem": cli.as_ref().map(|_| origem),
        "motorInstalado": embutido.is_some(),
        "pastaMotor": pasta_motor(&app).to_string_lossy(),
        "pastaModelos": dir_modelos.to_string_lossy(),
        "modeloCaminho": modelo_cfg,
        "modeloExiste": modelo_existe,
        "modeloBytes": modelo_bytes,
        "modeloTamanho": humano(modelo_bytes),
        // Modelo fora da pasta do app = instalação própria do usuário. O Painel
        // usa isto para NÃO empurrar instalação a quem já resolveu a vida.
        "modeloProprio": modelo_existe && !modelo_path.starts_with(&dir_modelos),
        "pronto": cli.is_some() && modelo_existe,
        "nvidia": nvidia,
        "motores": motores,
        "modelos": modelos,
        "release": TAG,
    })
}

#[tauri::command]
pub(crate) fn whisper_progress() -> Value {
    let p = prog().lock().unwrap().clone();
    let pct = if p.total > 0 {
        (p.baixado as f64 / p.total as f64 * 100.0).min(100.0)
    } else {
        0.0
    };
    json!({
        "ativo": p.ativo,
        "tarefa": p.tarefa,
        "alvo": p.alvo,
        "baixado": p.baixado,
        "total": p.total,
        "baixadoTxt": humano(p.baixado),
        "totalTxt": humano(p.total),
        "pct": pct,
        "fase": p.fase,
        "erro": p.erro,
        "feito": p.feito,
    })
}

#[tauri::command]
pub(crate) fn whisper_cancel() {
    CANCELAR.store(true, Ordering::SeqCst);
}

fn tomar_vez() -> Result<(), String> {
    if OCUPADO.swap(true, Ordering::SeqCst) {
        return Err("já existe um download em andamento.".into());
    }
    Ok(())
}
fn devolver_vez() {
    OCUPADO.store(false, Ordering::SeqCst);
}

/// W2 — baixa e instala o motor (whisper-cli + DLLs) na pasta do app e já
/// aponta a configuração para ele. O usuário não digita caminho nenhum.
#[tauri::command]
pub(crate) async fn whisper_install_engine(app: AppHandle, variante: String) -> Result<String, String> {
    let m = motor(&variante).ok_or_else(|| format!("motor desconhecido: {variante}"))?;
    if m.exige_nvidia && !tem_nvidia() {
        return Err("não encontrei driver NVIDIA nesta máquina; o pacote CUDA não serviria.".into());
    }
    tomar_vez()?;
    let r = instalar_motor(&app, m).await;
    terminar(&r);
    devolver_vez();
    r
}

async fn instalar_motor(app: &AppHandle, m: &'static Motor) -> Result<String, String> {
    iniciar(&format!("motor {}", m.rotulo), m.id, m.bytes);
    let dir = pasta_motor(app);
    let zip = pasta_whisper(app).join(m.arquivo);
    let url = format!("{BASE_RELEASE}/{TAG}/{}", m.arquivo);

    baixar(&url, &zip, m.bytes, MAGIA_ZIP, "pacote ZIP").await?;

    fase("extraindo");
    let n = match extrair(&zip, &dir) {
        Ok(n) => n,
        Err(e) => {
            let _ = std::fs::remove_file(&zip);
            return Err(e);
        }
    };
    // O ZIP é descartável: 8 a 640 MB de lixo se ficasse.
    let _ = std::fs::remove_file(&zip);

    let cli = cli_embutido(app)
        .ok_or_else(|| "extraí o pacote mas não achei o whisper-cli.exe dentro dele.".to_string())?;

    // W5: um caminho que o usuário digitou e que existe é decisão dele — o
    // ZapLite não sobrescreve. Campo vazio, ao contrário, não é decisão de
    // ninguém: aí o caminho do motor recém-instalado é gravado, e o usuário
    // não precisa digitar nada (ele fica visível e editável no Painel).
    fase("configurando");
    let mut s = crate::read_settings(app);
    let atual = s["whisperCli"].as_str().unwrap_or("").trim().to_string();
    let respeitou = !atual.is_empty() && PathBuf::from(&atual).is_file();
    if !respeitou {
        s["whisperCli"] = json!(cli.to_string_lossy());
        crate::write_settings(app, s)?;
    }

    Ok(if respeitou {
        format!(
            "Motor {} instalado ({n} arquivos) em {}. O whisper-cli que você configurou foi mantido — \
             apague o campo se quiser usar o do ZapLite.",
            m.rotulo,
            dir.display()
        )
    } else {
        format!(
            "Motor {} instalado ({n} arquivos). Usando {}.",
            m.rotulo,
            cli.display()
        )
    })
}

/// W3 — baixa um modelo e passa a usá-lo. Os modelos convivem: baixar o
/// `small` não apaga o `large-v3-turbo`.
#[tauri::command]
pub(crate) async fn whisper_download_model(app: AppHandle, id: String) -> Result<String, String> {
    let m = modelo(&id).ok_or_else(|| format!("modelo desconhecido: {id}"))?;
    tomar_vez()?;
    let r = baixar_modelo(&app, m).await;
    terminar(&r);
    devolver_vez();
    r
}

async fn baixar_modelo(app: &AppHandle, m: &'static Modelo) -> Result<String, String> {
    iniciar(&format!("modelo {}", m.id), m.id, m.bytes);
    let destino = caminho_modelo(app, m.id);
    let url = format!("{BASE_MODELO}/ggml-{}.bin", m.id);
    baixar(&url, &destino, m.bytes, MAGIA_GGML, "modelo GGML").await?;

    fase("configurando");
    apontar_modelo(app, &destino)?;
    Ok(format!(
        "Modelo {} baixado e verificado ({}). Já está em uso.",
        m.id,
        humano(std::fs::metadata(&destino).map(|x| x.len()).unwrap_or(m.bytes))
    ))
}

fn apontar_modelo(app: &AppHandle, p: &Path) -> Result<(), String> {
    let mut s = crate::read_settings(app);
    s["whisperModel"] = json!(p.to_string_lossy());
    crate::write_settings(app, s)
}

/// Troca entre modelos já baixados, sem baixar nada de novo.
#[tauri::command]
pub(crate) fn whisper_use_model(app: AppHandle, id: String) -> Result<String, String> {
    modelo(&id).ok_or_else(|| format!("modelo desconhecido: {id}"))?;
    let p = caminho_modelo(&app, &id);
    if !p.is_file() {
        return Err(format!("o modelo {id} ainda não foi baixado."));
    }
    apontar_modelo(&app, &p)?;
    Ok(format!("Agora usando o modelo {id}."))
}

/// Apaga um modelo baixado pelo ZapLite. Nunca apaga o que está em uso nem
/// arquivo de fora da pasta do app.
#[tauri::command]
pub(crate) fn whisper_delete_model(app: AppHandle, id: String) -> Result<String, String> {
    modelo(&id).ok_or_else(|| format!("modelo desconhecido: {id}"))?;
    let p = caminho_modelo(&app, &id);
    if !p.is_file() {
        return Err(format!("o modelo {id} não está baixado."));
    }
    let s = crate::read_settings(&app);
    if s["whisperModel"].as_str().unwrap_or("") == p.to_string_lossy() {
        return Err("este é o modelo em uso. Escolha outro antes de apagá-lo.".into());
    }
    std::fs::remove_file(&p).map_err(|e| erro_io(&e, &p))?;
    Ok(format!("Modelo {id} apagado."))
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod testes {
    use super::*;

    /// O filtro de extração é a barreira contra zip-slip: um item chamado
    /// `../../../Windows/System32/x.dll` só pode virar `x.dll` na pasta do
    /// motor, nunca escapar dela.
    #[test]
    fn extracao_nao_escapa_da_pasta() {
        assert_eq!(interessa("Release/whisper-cli.exe").as_deref(), Some("whisper-cli.exe"));
        assert_eq!(interessa("Release/ggml-cpu-haswell.dll").as_deref(), Some("ggml-cpu-haswell.dll"));
        assert_eq!(
            interessa("../../../Windows/System32/evil.dll").as_deref(),
            Some("evil.dll"),
            "o caminho tem que ser achatado para o nome puro"
        );
        assert_eq!(interessa("..\\..\\evil.dll").as_deref(), Some("evil.dll"));
        assert_eq!(
            interessa("C:/Windows/System32/x.dll").as_deref(),
            Some("x.dll"),
            "caminho absoluto também é achatado, nunca seguido"
        );
        // Fluxo alternativo de NTFS (`arquivo.dll:oculto`) não passa.
        assert_eq!(interessa("Release/whisper.dll:oculto"), None);
        // Sobras que não interessam.
        assert_eq!(interessa("Release/test-vad.exe"), None);
        assert_eq!(interessa("Release/stream.exe"), None);
        assert_eq!(interessa("Release/"), None);
    }

    /// A assinatura GGML é `lmgg` — o `0x67676d6c` em little-endian. Se este
    /// teste mudar, a verificação do download inteiro muda de sentido.
    #[test]
    fn magia_ggml_confere() {
        let dir = std::env::temp_dir().join(format!("zl_magia_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bom = dir.join("bom.bin");
        std::fs::write(&bom, b"lmgg\x00\x00\x00\x00").unwrap();
        assert!(conferir_magia(&bom, MAGIA_GGML).is_ok());

        // Uma página de erro HTML salva com nome de modelo NÃO passa.
        let html = dir.join("erro.bin");
        std::fs::write(&html, b"<!DOCTYPE html><html>404").unwrap();
        assert!(conferir_magia(&html, MAGIA_GGML).is_err());

        // Arquivo curto demais também não.
        let curto = dir.join("curto.bin");
        std::fs::write(&curto, b"lm").unwrap();
        assert!(conferir_magia(&curto, MAGIA_GGML).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Catálogo bem-formado: exatamente uma recomendação, ids únicos e
    /// tamanhos plausíveis (nenhum modelo de 0 byte por erro de digitação).
    #[test]
    fn catalogo_coerente() {
        assert_eq!(MODELOS.iter().filter(|m| m.recomendado).count(), 1);
        for m in MODELOS {
            assert!(m.bytes > 50_000_000, "{} com tamanho implausível", m.id);
            assert_eq!(MODELOS.iter().filter(|x| x.id == m.id).count(), 1);
        }
        for m in MOTORES {
            assert!(m.arquivo.ends_with(".zip"));
            assert!(m.bytes > 1_000_000);
        }
        // CUDA é o único que exige GPU — os outros têm que ser oferecidos sempre.
        assert_eq!(MOTORES.iter().filter(|m| m.exige_nvidia).count(), 1);
    }

    #[test]
    fn tamanho_em_portugues() {
        assert_eq!(humano(77_691_713), "74 MB");
        assert_eq!(humano(1_624_555_275), "1.5 GB");
        assert_eq!(humano(0), "0 B");
    }

    /// Duas instalações simultâneas não podem existir: a segunda tem que ser
    /// recusada com mensagem, não corromper o progresso da primeira.
    #[test]
    fn uma_instalacao_por_vez() {
        devolver_vez();
        assert!(tomar_vez().is_ok());
        assert!(tomar_vez().is_err());
        devolver_vez();
        assert!(tomar_vez().is_ok());
        devolver_vez();
        assert!(GERACAO.load(Ordering::SeqCst) < u64::MAX);
    }
}
