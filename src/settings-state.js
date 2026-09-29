/* Patch local: preserva edicoes feitas enquanto uma gravacao estava em voo. */
(function (root) {
  function mergeEdits(base, desired, current) {
    const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const object = v => v && typeof v === "object" && !Array.isArray(v);
    if (equal(base, desired)) return structuredClone(current);
    if (object(base) && object(desired) && object(current)) {
      const out = structuredClone(current);
      new Set([...Object.keys(base), ...Object.keys(desired)]).forEach(key => {
        if (["__proto__", "constructor", "prototype", "_revision"].includes(key)) return;
        if (equal(base[key], desired[key])) return;
        if (!(key in desired)) delete out[key];
        else out[key] = mergeEdits(base[key], desired[key], current[key]);
      });
      return out;
    }
    return structuredClone(desired);
  }
  /* Leva `target` a ficar igual a `source` SEM trocar a identidade dos
     objetos e arrays que ja existiam. O Painel pendura handlers que guardam
     `arr`/`r` (atalhos, regras de notificacao); trocar `S` inteiro depois de
     salvar deixava esses handlers escrevendo num objeto morto, e toda edicao
     feita depois do primeiro "Salvar" sumia sem erro. */
  function syncInPlace(target, source) {
    const object = v => v && typeof v === "object" && !Array.isArray(v);
    if (Array.isArray(target) && Array.isArray(source)) {
      source.forEach((v, i) => { target[i] = syncInPlace(target[i], v); });
      target.length = source.length;
      return target;
    }
    if (object(target) && object(source)) {
      Object.keys(target).forEach(key => { if (!(key in source)) delete target[key]; });
      Object.keys(source).forEach(key => {
        if (["__proto__", "constructor", "prototype"].includes(key)) return;
        target[key] = syncInPlace(target[key], source[key]);
      });
      return target;
    }
    return source;
  }
  root.ZLMergeEdits = mergeEdits;
  root.ZLSyncInPlace = syncInPlace;
  if (typeof module !== "undefined") module.exports = { mergeEdits, syncInPlace };
})(globalThis);
