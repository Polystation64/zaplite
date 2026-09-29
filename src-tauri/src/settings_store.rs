//! Persistencia atomica, merge de tres vias e protecao local de segredos.
use base64::Engine;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::io::Write;
use std::path::Path;

pub const MAX_DOCUMENT: usize = 4 * 1024 * 1024;

#[cfg(windows)]
fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let ok = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) };
    if ok == 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) }
}

#[cfg(not(windows))]
fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> { std::fs::rename(from, to) }

/// Campos nao editados no painel preservam o valor atual. Conflitos reais
/// falham antes de escrever qualquer byte; arrays sao unidades indivisiveis.
pub fn merge(base: &Value, desired: &Value, current: &Value) -> Result<Value, String> {
    fn field(b: Option<&Value>, d: Option<&Value>, c: Option<&Value>, path: &str)
        -> Result<Option<Value>, String> {
        if b == d { return Ok(c.cloned()); }
        if c == b || c == d { return Ok(d.cloned()); }
        if let (Some(Value::Object(b)), Some(Value::Object(d)), Some(Value::Object(c))) = (b, d, c) {
            let mut out = c.clone();
            let keys: BTreeSet<_> = b.keys().chain(d.keys()).collect();
            for key in keys {
                if key == "_revision" { continue; }
                match field(b.get(key), d.get(key), c.get(key), &format!("{path}/{key}"))? {
                    Some(value) => { out.insert(key.clone(), value); }
                    None => { out.remove(key); }
                }
            }
            return Ok(Some(Value::Object(out)));
        }
        Err(format!("O campo {path} mudou enquanto o painel estava aberto. Reabra o painel e reaplique essa alteracao; nada foi sobrescrito."))
    }
    if !base.is_object() || !desired.is_object() || !current.is_object() {
        return Err("Configuracao precisa ser um objeto.".into());
    }
    field(Some(base), Some(desired), Some(current), "configuracoes")?
        .ok_or_else(|| "Configuracao vazia.".into())
}

pub fn atomic_write(path: &Path, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_DOCUMENT { return Err("Configuracao excede o limite de 4 MB.".into()); }
    let parent = path.parent().ok_or("Pasta de configuracao invalida.")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = parent.join(format!(".zaplite-settings-{:016x}.tmp", rand::random::<u64>()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        // O temporario fica no mesmo volume. No Windows, MoveFileExW troca o
        // destino em uma unica operacao; nunca truncamos o arquivo original.
        replace_file(&tmp, path)
    })();
    if result.is_err() { let _ = std::fs::remove_file(&tmp); }
    result.map_err(|e| format!("Nao foi possivel salvar; o arquivo anterior foi preservado: {e}"))
}

#[cfg(windows)]
fn crypt(bytes: &[u8], protect: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN};
    use windows_sys::Win32::Foundation::LocalFree;
    let input = CRYPT_INTEGER_BLOB { cbData: bytes.len().try_into().map_err(|_| "Segredo muito grande.")?, pbData: bytes.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    // DPAPI vinculada ao usuario do Windows; nenhuma interface ou chave externa.
    let ok = unsafe {
        if protect {
            CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        } else {
            CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        }
    };
    if ok == 0 { return Err("O Windows nao conseguiu proteger/abrir as chaves. Use a mesma conta do Windows; o arquivo nao sera sobrescrito.".into()); }
    let result = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData as _); }
    Ok(result)
}

#[cfg(not(windows))]
fn crypt(_: &[u8], _: bool) -> Result<Vec<u8>, String> {
    Err("Protecao de chaves requer Windows.".into())
}

pub fn encode(value: &Value) -> Result<Value, String> {
    let mut stored = value.clone();
    for key in crate::ai::CAMPOS_DE_CHAVE {
        if let Some(secret) = value[key].as_str().filter(|s| !s.is_empty()) {
            stored[key] = json!({"$dpapi": base64::engine::general_purpose::STANDARD.encode(crypt(secret.as_bytes(), true)?)});
        }
    }
    Ok(stored)
}

fn decode_one(blob: &Value) -> Result<String, String> {
    let encoded = blob["$dpapi"].as_str().ok_or("Formato de chave protegida desconhecido.")?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| "Chave protegida corrompida.")?;
    String::from_utf8(crypt(&bytes, false)?).map_err(|_| "Chave protegida invalida.".into())
}

/// Chave que nao abriu: o campo e o blob cifrado original, intocado.
pub struct Ilegivel { pub campo: String, pub blob: Value, pub motivo: String }

/// Decifra so os campos de chave. Um campo que nao abre (arquivo copiado de
/// outro usuario/maquina, blob danificado) sai do resultado e volta em
/// `Ilegivel` - o RESTO da configuracao (notas, modulos, regras) continua
/// valendo. Antes, uma chave ilegivel zerava a configuracao inteira.
pub fn decode(mut value: Value) -> (Value, Vec<Ilegivel>) {
    let mut ilegiveis = Vec::new();
    for key in crate::ai::CAMPOS_DE_CHAVE {
        if value[key].is_object() {
            match decode_one(&value[key]) {
                Ok(texto) => value[key] = json!(texto),
                Err(motivo) => {
                    let blob = value[key].take();
                    if let Some(m) = value.as_object_mut() { m.remove(*key); }
                    ilegiveis.push(Ilegivel { campo: key.to_string(), blob, motivo });
                }
            }
        }
    }
    (value, ilegiveis)
}

/// Na gravacao: o campo ilegivel que o usuario NAO substituiu volta ao disco
/// como estava. Digitar uma chave nova no Painel e a unica coisa que o apaga.
pub fn preservar_ilegiveis(stored: &mut Value, ilegiveis: &[Ilegivel]) {
    for i in ilegiveis {
        let atual = &stored[i.campo.as_str()];
        let substituido = atual.as_str().map_or(false, |s| !s.is_empty()) || atual.is_object();
        if !substituido {
            if let Some(m) = stored.as_object_mut() { m.insert(i.campo.clone(), i.blob.clone()); }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn painel_antigo_preserva_notas_e_agendamentos() {
        let b = json!({"theme":"dark","contactNotes":{},"scheduled":[]});
        let mut d = b.clone(); d["theme"] = json!("light");
        let c = json!({"theme":"dark","contactNotes":{"x":"nova"},"scheduled":[{"id":"novo"}]});
        let m = merge(&b, &d, &c).unwrap();
        assert_eq!(m["theme"], "light"); assert_eq!(m["contactNotes"], c["contactNotes"]); assert_eq!(m["scheduled"], c["scheduled"]);
    }
    #[test]
    fn merge_preserva_atualizacao_aninhada_e_recusa_conflito() {
        let b = json!({"notify":{"sound":"a","muted":[]}});
        let d = json!({"notify":{"sound":"b","muted":[]}});
        let c = json!({"notify":{"sound":"a","muted":["x"]}});
        assert_eq!(merge(&b,&d,&c).unwrap(), json!({"notify":{"sound":"b","muted":["x"]}}));
        assert!(merge(&json!({"x":1}), &json!({"x":2}), &json!({"x":3})).is_err());
    }
    #[test]
    fn escrita_atomica_substitui_e_preserva_em_erro() {
        let dir = std::env::temp_dir().join(format!("zaplite-store-test-{:x}", rand::random::<u64>()));
        let p = dir.join("settings.json");
        atomic_write(&p,&json!({"a":1})).unwrap();
        atomic_write(&p,&json!({"b":2})).unwrap();
        assert!(atomic_write(&p,&json!({"huge":"x".repeat(MAX_DOCUMENT)})).is_err());
        assert_eq!(serde_json::from_slice::<Value>(&std::fs::read(&p).unwrap()).unwrap(),json!({"b":2}));
        std::fs::remove_file(p).unwrap(); std::fs::remove_dir(dir).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn dpapi_roundtrip_e_migracao_sem_texto_claro() {
        let plain = json!({"openaiKey":"chave-ficticia-de-teste","contactNotes":{"x":"nota"}});
        assert_eq!(decode(plain.clone()).0, plain);
        let encrypted = encode(&plain).unwrap();
        assert!(!encrypted.to_string().contains("chave-ficticia"));
        let (aberto, ilegiveis) = decode(encrypted);
        assert_eq!(aberto, plain); assert!(ilegiveis.is_empty());
    }
    #[cfg(windows)]
    #[test]
    fn chave_ilegivel_nao_derruba_o_resto_e_sobrevive_a_gravacao() {
        let blob = json!({"$dpapi":"AAAA"});
        let (v, ilegiveis) = decode(json!({"openaiKey":blob.clone(),"contactNotes":{"x":"nota"}}));
        assert_eq!(v, json!({"contactNotes":{"x":"nota"}}));
        assert_eq!(ilegiveis.len(), 1); assert_eq!(ilegiveis[0].campo, "openaiKey");
        // gravar sem digitar chave nova: o blob volta intacto
        let mut stored = encode(&json!({"contactNotes":{"x":"nova"}})).unwrap();
        preservar_ilegiveis(&mut stored, &ilegiveis);
        assert_eq!(stored["openaiKey"], blob);
        // digitou chave nova: ela vence
        let mut stored = encode(&json!({"openaiKey":"nova-chave"})).unwrap();
        preservar_ilegiveis(&mut stored, &ilegiveis);
        assert_ne!(stored["openaiKey"], blob);
    }
}
