//! `connection.log`: fila, escrita serializada, rotação e o `log_and_emit`
//! que é o ÚNICO ponto por onde uma transição vira linha de log + evento.

use super::*;

pub(crate) static LOG_GATE: Mutex<()> = Mutex::new(());
pub(crate) static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
pub(crate) static LOG_TX: OnceLock<SyncSender<String>> = OnceLock::new();
pub(crate) static LOG_DROPPED: AtomicU32 = AtomicU32::new(0);

pub(crate) fn contem(agulha: &[u8], palheiro: &[u8]) -> bool {
    if palheiro.is_empty() || agulha.len() < palheiro.len() {
        return false;
    }
    agulha.windows(palheiro.len()).any(|w| w == palheiro)
}

/// Linha gerada pelo PRÓPRIO app (watchdog, ciclo de vida da janela). São as
/// que a rotação protege: é o histórico de diagnóstico.
pub(crate) fn linha_local(l: &[u8]) -> bool {
    contem(l, br#""src":"app""#)
}

/// Rotação como função PURA, para poder ser testada.
///
/// A versão anterior cortava o arquivo na metade e jogava fora o começo. Com a
/// página conseguindo 3,8 transições por segundo (medido), ~20 min de rede
/// instável (ou um laço hostil) APAGAVAM todo o histórico: negação de serviço
/// sobre a própria observabilidade. Agora o trecho descartado é filtrado — as
/// linhas do app sobrevivem (até `ROT_LOCAIS_MAX`), as da página é que saem.
pub(crate) fn rotacionar_conteudo(content: &[u8], max: u64) -> Option<Vec<u8>> {
    if content.len() as u64 <= max {
        return None;
    }
    let mut cut = content.len() / 2;
    while cut < content.len() && content[cut] != b'\n' {
        cut += 1;
    }
    if cut < content.len() {
        cut += 1; // consome a própria quebra
    }
    let (cabeca, cauda) = content.split_at(cut.min(content.len()));
    let mut locais: Vec<&[u8]> = cabeca
        .split(|b| *b == b'\n')
        .filter(|l| !l.is_empty() && linha_local(l))
        .collect();
    if locais.len() > ROT_LOCAIS_MAX {
        locais.drain(..locais.len() - ROT_LOCAIS_MAX);
    }
    let mut out = Vec::with_capacity(cauda.len() + locais.len() * 200);
    for l in locais {
        out.extend_from_slice(l);
        out.push(b'\n');
    }
    out.extend_from_slice(cauda);
    Some(out)
}

/// Só pode ser chamada com `LOG_GATE` na mão.
pub(crate) fn rotacionar_travado(path: &Path) {
    let Ok(meta) = fs::metadata(path) else { return };
    if meta.len() <= LOG_MAX_BYTES {
        return;
    }
    let Ok(content) = fs::read(path) else { return };
    let Some(novo) = rotacionar_conteudo(&content, LOG_MAX_BYTES) else {
        return;
    };
    // grava num temporário e renomeia: nunca existe um instante com o log
    // truncado no disco (o `fs::write` truncante da versão anterior perdia
    // qualquer escrita que caísse no meio).
    let tmp = path.with_extension("log.tmp");
    if fs::write(&tmp, &novo).is_ok() {
        let _ = fs::rename(&tmp, path);
    }
}

/// O ÚNICO ponto de escrita do arquivo.
pub(crate) fn escrever_linha(path: &Path, linha: &str) {
    let _g = LOG_GATE.lock().unwrap_or_else(|e| e.into_inner());
    rotacionar_travado(path);
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(path) {
        // uma linha = UMA escrita (o '\n' vai junto no mesmo buffer)
        let mut buf = String::with_capacity(linha.len() + 1);
        buf.push_str(linha);
        buf.push('\n');
        let _ = f.write_all(buf.as_bytes());
        let _ = f.flush();
    }
}

pub(crate) fn log_path(app: &AppHandle) -> Option<&'static PathBuf> {
    if let Some(p) = LOG_PATH.get() {
        return Some(p);
    }
    let dir = app.path().app_config_dir().ok()?;
    let _ = fs::create_dir_all(&dir);
    let _ = LOG_PATH.set(dir.join("connection.log"));
    LOG_PATH.get()
}

pub(crate) fn log_sender(app: &AppHandle) -> Option<&'static SyncSender<String>> {
    if let Some(tx) = LOG_TX.get() {
        return Some(tx);
    }
    let path = log_path(app)?.clone();
    // K5: fila LIMITADA. Cheia, a linha é descartada e contada — nunca bloqueia
    // o chamador nem cresce sem teto.
    let (tx, rx) = sync_channel::<String>(LOG_QUEUE_MAX);
    std::thread::Builder::new()
        .name("zaplite-connlog".into())
        .spawn(move || {
            while let Ok(line) = rx.recv() {
                let d = LOG_DROPPED.swap(0, Ordering::SeqCst);
                if d > 0 {
                    escrever_linha(
                        &path,
                        &json!({
                            "ts": iso_now(),
                            "prev": "UNKNOWN",
                            "state": "UNKNOWN",
                            "reason": format!("{d} linhas de log descartadas (fila cheia, teto {LOG_QUEUE_MAX})"),
                            "note": true,
                            "src": "app",
                        })
                        .to_string(),
                    );
                }
                escrever_linha(&path, &line);
            }
        })
        .ok()?;
    let _ = LOG_TX.set(tx);
    LOG_TX.get()
}

pub(crate) fn append_log(app: &AppHandle, line: String) {
    if let Some(tx) = log_sender(app) {
        if let Err(TrySendError::Full(_)) = tx.try_send(line) {
            LOG_DROPPED.fetch_add(1, Ordering::SeqCst);
        }
    }
}

/// Escrita SÍNCRONA, só para os caminhos de fim de vida do processo: a thread
/// escritora é background e morre junto com o processo, então uma linha
/// enfileirada às vésperas da saída simplesmente não seria gravada.
/// Usa o MESMO `escrever_linha` da thread — portanto o mesmo mutex, a mesma
/// escrita única. É isso que mata a corrupção sem perder a garantia de entrega.
pub(crate) fn note_sync(app: &AppHandle, state: &str, attempts: u32, reason: &str) {
    let Some(path) = log_path(app) else { return };
    let line = json!({
        "ts": iso_now(),
        "prev": state,
        "state": state,
        "reason": sanitize_reason(reason),
        "attempts": attempts,
        "note": true,
        "src": "app",
    })
    .to_string();
    escrever_linha(path, &line);
}

/// Linha de diagnóstico que NÃO é transição.
/// K11: `attempts` é o valor REAL (antes era `0` fixo, e notas com `attempts:0`
/// no meio de linhas com `attempts:6` corrompiam qualquer agregação).
pub(crate) fn note(app: &AppHandle, state: &str, attempts: u32, reason: &str) {
    let line = json!({
        "ts": iso_now(),
        "prev": state,
        "state": state,
        "reason": sanitize_reason(reason),
        "attempts": attempts,
        "note": true,
        "src": "app",
    });
    append_log(app, line.to_string());
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn log_and_emit(
    app: &AppHandle,
    prev: &str,
    state: &str,
    reason: &str,
    attempts: u32,
    since_ms: u64,
    ts: Option<String>,
    src: &str,
) {
    let line = json!({
        "ts": ts.unwrap_or_else(iso_now),
        "prev": prev,
        "state": state,
        "reason": reason,
        "attempts": attempts,
        "src": src,
    });
    append_log(app, line.to_string());
    let _ = app.emit(
        "zaplite://conn-state",
        json!({ "state": state, "since": since_ms, "attempts": attempts, "reason": reason }),
    );
}
